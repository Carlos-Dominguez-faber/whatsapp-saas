import assert from "node:assert/strict";
import { test, mock } from "node:test";

let policy: { policy: string; reason: string } | Error = { policy: "allow", reason: "within_budget" };
mock.module("./cost-enforcer.ts", {
  exports: {
    enforceCostPolicy: async () => {
      if (policy instanceof Error) throw policy;
      return policy;
    },
  },
});

let reservation: { allowed: boolean; reservationId?: string } | Error = { allowed: true, reservationId: "res_1" };
const reserveCalls: unknown[][] = [];
let clientReservation: { allowed: boolean; reason?: string; reservationId?: string } | Error = {
  allowed: true,
  reservationId: "res_c",
};
const clientReserveCalls: unknown[][] = [];
mock.module("./cost-tracker.ts", {
  exports: {
    reserveWorkspaceLlmCall: async (...args: unknown[]) => {
      reserveCalls.push(args);
      if (reservation instanceof Error) throw reservation;
      return reservation;
    },
    reserveClientTestChat: async (...args: unknown[]) => {
      clientReserveCalls.push(args);
      if (clientReservation instanceof Error) throw clientReservation;
      return clientReservation;
    },
  },
});

const { guardWorkspaceLlmCall, guardClientTestChat, CLIENT_TEST_CHAT_LIMITS } = await import("./llm-call-guard.ts");

function reset() {
  policy = { policy: "allow", reason: "within_budget" };
  reservation = { allowed: true, reservationId: "res_1" };
  reserveCalls.length = 0;
  clientReservation = { allowed: true, reservationId: "res_c" };
  clientReserveCalls.length = 0;
}

test("within budget and under the hourly cap, the call goes ahead with its reservation", async () => {
  reset();
  const result = await guardWorkspaceLlmCall("ws_1", "template_generate");
  assert.deepEqual(result, { ok: true, reservationId: "res_1" });
  assert.deepEqual(reserveCalls[0], ["ws_1", "template_generate", 20]);
});

test("from the degrade threshold manager tools are refused, leaving the rest for customers", async () => {
  for (const p of ["degrade", "cut"]) {
    reset();
    policy = { policy: p, reason: "x" };
    const result = await guardWorkspaceLlmCall("ws_1", "agent_test_chat");
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.response.status, 429);
    assert.match((await result.response.json()).error, /presupuesto diario de IA/);
    assert.equal(reserveCalls.length, 0, `${p}: no hourly slot is taken`);
  }
});

test("at the hourly cap the call is refused with a message for that tool", async () => {
  reset();
  reservation = { allowed: false };
  const result = await guardWorkspaceLlmCall("ws_1", "agent_test_chat");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.response.status, 429);
  assert.match((await result.response.json()).error, /mensajes de prueba por hora/);
  assert.deepEqual(reserveCalls[0], ["ws_1", "agent_test_chat", 60]);
});

test("a database error answers 503 instead of calling the model unchecked", async () => {
  reset();
  policy = new Error("sum_daily_llm_tokens failed");
  const r1 = await guardWorkspaceLlmCall("ws_1", "template_generate");
  assert.equal(r1.ok ? 200 : r1.response.status, 503);

  reset();
  reservation = new Error("reserve_workspace_llm_call failed");
  const r2 = await guardWorkspaceLlmCall("ws_1", "template_generate");
  assert.equal(r2.ok ? 200 : r2.response.status, 503);
});

test("/probar reserves one of the person's and the workspace's hourly calls", async () => {
  reset();
  const result = await guardClientTestChat("ws_1", "user_1");
  assert.deepEqual(result, { ok: true, reservationId: "res_c" });
  assert.deepEqual(clientReserveCalls[0], ["ws_1", "user_1", CLIENT_TEST_CHAT_LIMITS]);
  assert.equal(reserveCalls.length, 0, "the playground's cap is not touched");
});

test("/probar's refusals don't mention budgets, and say whose cap it was", async () => {
  reset();
  policy = { policy: "degrade", reason: "x" };
  const budget = await guardClientTestChat("ws_1", "user_1");
  assert.equal(budget.ok, false);
  if (!budget.ok) {
    assert.equal(budget.response.status, 429);
    assert.doesNotMatch((await budget.response.json()).error, /presupuesto|IA/);
  }
  assert.equal(clientReserveCalls.length, 0);

  for (const [reason, pattern] of [["user_hour", /Llegaste/], ["workspace_hour", /Este espacio/]] as const) {
    reset();
    clientReservation = { allowed: false, reason };
    const r = await guardClientTestChat("ws_1", "user_1");
    assert.equal(r.ok, false);
    if (!r.ok) assert.match((await r.response.json()).error, pattern);
  }
});

test("/probar fails closed when the reservation can't be made", async () => {
  reset();
  clientReservation = new Error("db down");
  const r = await guardClientTestChat("ws_1", "user_1");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.response.status, 503);
});
