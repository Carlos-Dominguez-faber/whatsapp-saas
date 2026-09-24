import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

const FAKE_NOW_MS = Date.parse("2026-08-22T12:00:00.000Z");
mock.module("node:perf_hooks", {
  exports: {
    performance: { timeOrigin: 0, now: () => FAKE_NOW_MS },
  },
});

interface QueueEntry {
  data?: unknown;
  error?: unknown;
}

let responseQueue: QueueEntry[] = [];
let calls: Array<{ op: string; args: unknown[] }> = [];
const insertedRows: unknown[] = [];
let insertErrorToReturn: unknown = null;
let rpcResponse: QueueEntry = { data: null, error: null };
let rpcCalls: Array<{ fn: string; args: unknown }> = [];
const updateCalls: Array<{ row: unknown; eqArgs: unknown[] }> = [];

function nextResponse(): QueueEntry {
  return responseQueue.shift() ?? { data: null, error: null };
}

function makeChain() {
  const chain: any = {
    eq(column: string, value: unknown) {
      calls.push({ op: "eq", args: [column, value] });
      return chain;
    },
    filter(column: string, op: string, value: unknown) {
      calls.push({ op: "filter", args: [column, op, value] });
      return chain;
    },
    gte(column: string, value: unknown) {
      calls.push({ op: "gte", args: [column, value] });
      return chain;
    },
    then(resolve: (v: QueueEntry) => void) {
      resolve(nextResponse());
    },
  };
  return chain;
}

const fakeClient = {
  from() {
    return {
      select(columns: string) {
        calls.push({ op: "select", args: [columns] });
        return makeChain();
      },
      insert(row: unknown) {
        insertedRows.push(row);
        return Promise.resolve({ error: insertErrorToReturn });
      },
      update(row: unknown) {
        return {
          eq(column: string, value: unknown) {
            updateCalls.push({ row, eqArgs: [column, value] });
            return Promise.resolve({ error: insertErrorToReturn });
          },
        };
      },
    };
  },
  rpc(fn: string, args: unknown) {
    rpcCalls.push({ fn, args });
    return Promise.resolve(rpcResponse);
  },
};

mock.module("@supabase/supabase-js", {
  exports: { createClient: () => fakeClient },
});

const { recordLlmUsage, checkRateLimits, reserveLlmTurn } = await import("./cost-tracker.ts");

test("recordLlmUsage inserts an llm_usage event with summed total_tokens", async () => {
  insertedRows.length = 0;
  await recordLlmUsage({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    contactId: "contact_1",
    model: "openai/gpt-4o",
    promptTokens: 100,
    completionTokens: 50,
  });
  assert.equal(insertedRows.length, 1);
  assert.deepEqual(insertedRows[0], {
    type: "llm_usage",
    level: "info",
    workspace_id: "ws_1",
    conversation_id: "conv_1",
    payload: {
      model: "openai/gpt-4o",
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      contact_id: "contact_1",
    },
  });
});

test("checkRateLimits allows when under the hourly ceiling", async () => {
  calls = [];
  responseQueue = [
    { data: Array.from({ length: 5 }, (_, i) => ({ id: `e${i}` })), error: null },
  ];
  const result = await checkRateLimits("ws_1", "contact_1");
  assert.deepEqual(result, { allowed: true });
});

test("checkRateLimits denies once the contact hits the hourly turn ceiling (boundary: exactly 20)", async () => {
  calls = [];
  responseQueue = [
    { data: Array.from({ length: 20 }, (_, i) => ({ id: `e${i}` })), error: null },
  ];
  const result = await checkRateLimits("ws_1", "contact_1");
  assert.deepEqual(result, { allowed: false, reason: "rate_limit_contact_hour" });
});

test("checkRateLimits fails closed when the hourly query errors — an unverifiable budget is not an allowed one", async () => {
  calls = [];
  responseQueue = [{ data: null, error: { message: "boom" } }];
  const result = await checkRateLimits("ws_1", "contact_1");
  assert.deepEqual(result, { allowed: false, reason: "rate_limit_check_failed" });
});

test("checkRateLimits scopes the hourly query by type, workspace, and contact_id", async () => {
  calls = [];
  responseQueue = [{ data: [], error: null }];
  await checkRateLimits("ws_1", "contact_1");
  assert.ok(
    calls.some((c) => c.op === "eq" && c.args[0] === "type" && c.args[1] === "llm_usage"),
  );
  assert.ok(
    calls.some((c) => c.op === "eq" && c.args[0] === "workspace_id" && c.args[1] === "ws_1"),
  );
  assert.ok(
    calls.some(
      (c) =>
        c.op === "filter" &&
        c.args[0] === "payload->>contact_id" &&
        c.args[1] === "eq" &&
        c.args[2] === "contact_1",
    ),
  );
});

test("checkRateLimits computes the hourly window from the mocked clock", async () => {
  calls = [];
  responseQueue = [{ data: [], error: null }];
  await checkRateLimits("ws_1", "contact_1");
  const hourlyGte = calls.find((c) => c.op === "gte" && c.args[0] === "created_at");
  assert.ok(hourlyGte, "expected an hourly gte('created_at', ...) call");
  assert.equal(
    Date.parse(String(hourlyGte!.args[1])),
    FAKE_NOW_MS - 3_600_000,
  );
});

test("recordLlmUsage logs but does not throw when the insert fails", async () => {
  insertedRows.length = 0;
  insertErrorToReturn = { message: "insert boom" };
  const errorLogs: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errorLogs.push(args);
  };
  try {
    await assert.doesNotReject(() =>
      recordLlmUsage({
        workspaceId: "ws_1",
        conversationId: "conv_1",
        contactId: "contact_1",
        model: "openai/gpt-4o",
        promptTokens: 10,
        completionTokens: 5,
      }),
    );
  } finally {
    console.error = originalError;
    insertErrorToReturn = null;
  }
  assert.ok(
    errorLogs.some((args) =>
      String(args[0]).includes("failed to record llm_usage event"),
    ),
  );
});

test("reserveLlmTurn allows and returns the reservation id when under the hourly ceiling", async () => {
  rpcCalls = [];
  rpcResponse = { data: [{ allowed: true, reservation_id: "res_1" }], error: null };
  const result = await reserveLlmTurn("ws_1", "contact_1");
  assert.deepEqual(result, { allowed: true, reservationId: "res_1" });
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].fn, "reserve_llm_turn");
  assert.deepEqual(rpcCalls[0].args, {
    p_workspace_id: "ws_1",
    p_contact_id: "contact_1",
    p_hourly_limit: 20,
  });
});

test("reserveLlmTurn denies without a reservation id once the hourly ceiling is hit", async () => {
  rpcResponse = { data: [{ allowed: false, reservation_id: null }], error: null };
  const result = await reserveLlmTurn("ws_1", "contact_1");
  assert.deepEqual(result, { allowed: false, reason: "rate_limit_contact_hour" });
});

test("reserveLlmTurn fails closed when the RPC errors", async () => {
  rpcResponse = { data: null, error: { message: "boom" } };
  const result = await reserveLlmTurn("ws_1", "contact_1");
  assert.deepEqual(result, { allowed: false, reason: "rate_limit_check_failed" });
});

test("recordLlmUsage updates the reservation row in place when a reservationId is given, instead of inserting a new one", async () => {
  insertedRows.length = 0;
  updateCalls.length = 0;
  insertErrorToReturn = null;
  await recordLlmUsage({
    reservationId: "res_1",
    workspaceId: "ws_1",
    conversationId: "conv_1",
    contactId: "contact_1",
    model: "openai/gpt-4o",
    promptTokens: 100,
    completionTokens: 50,
  });
  assert.equal(insertedRows.length, 0);
  assert.equal(updateCalls.length, 1);
  assert.deepEqual(updateCalls[0].eqArgs, ["id", "res_1"]);
  const row = updateCalls[0].row as { conversation_id: string; payload: Record<string, unknown> };
  assert.equal(row.conversation_id, "conv_1");
  assert.deepEqual(row.payload, {
    model: "openai/gpt-4o",
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150,
    contact_id: "contact_1",
  });
});
