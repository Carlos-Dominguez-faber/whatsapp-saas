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
mock.module("./cost-tracker.ts", {
  exports: {
    reserveWorkspaceLlmCall: async (...args: unknown[]) => {
      reserveCalls.push(args);
      if (reservation instanceof Error) throw reservation;
      return reservation;
    },
  },
});

const { guardWorkspaceLlmCall } = await import("./llm-call-guard.ts");

function reset() {
  policy = { policy: "allow", reason: "within_budget" };
  reservation = { allowed: true, reservationId: "res_1" };
  reserveCalls.length = 0;
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
