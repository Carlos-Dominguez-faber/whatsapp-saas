import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

interface QueueEntry {
  data?: unknown;
  error?: unknown;
}

let rpcResponse: QueueEntry = { data: null, error: null };
let rpcCalls: Array<{ fn: string; args: unknown }> = [];
const insertedRows: unknown[] = [];
// One entry per select() chain, in call order.
let selectQueue: QueueEntry[] = [];
let selectOps: unknown[][][] = [];

function selectChain() {
  const ops: unknown[][] = [];
  selectOps.push(ops);
  const chain: any = {};
  for (const op of ["eq", "in", "gte", "order", "range", "limit"]) {
    chain[op] = (...args: unknown[]) => {
      ops.push([op, ...args]);
      return chain;
    };
  }
  chain.then = (resolve: (v: QueueEntry) => void) =>
    resolve(selectQueue.shift() ?? { data: [], error: null });
  return chain;
}

const fakeClient = {
  from() {
    return {
      select: () => selectChain(),
      insert(row: unknown) {
        insertedRows.push(row);
        return Promise.resolve({ error: null });
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

const { enforceCostPolicy, buildCostAwareSystemPrompt } = await import(
  "./cost-enforcer.ts"
);

function reset() {
  rpcResponse = { data: null, error: null };
  rpcCalls = [];
  insertedRows.length = 0;
  selectQueue = [];
  selectOps = [];
}

test("enforceCostPolicy allows when today's usage is under the warn threshold", async () => {
  reset();
  rpcResponse = { data: 500_000, error: null };
  const result = await enforceCostPolicy("ws_1");
  assert.deepEqual(result, { policy: "allow", reason: "within_budget" });
  assert.equal(insertedRows.length, 0);
});

test("enforceCostPolicy degrades at 800,000 and logs the day's first cost_alert", async () => {
  reset();
  rpcResponse = { data: 800_000, error: null };
  selectQueue = [{ data: [], error: null }]; // no cost_alert yet today
  const result = await enforceCostPolicy("ws_1");
  assert.deepEqual(result, {
    policy: "degrade",
    reason: "daily_warn_threshold",
    fallbackModel: "openai/gpt-4o-mini",
  });
  assert.equal(insertedRows.length, 1);
  assert.equal((insertedRows[0] as { type: string }).type, "cost_alert");
});

test("enforceCostPolicy logs cost_alert at most once per workspace and day", async () => {
  reset();
  rpcResponse = { data: 900_000, error: null };
  selectQueue = [{ data: [{ id: "evt_1" }], error: null }];
  const result = await enforceCostPolicy("ws_1");
  assert.equal(result.policy, "degrade");
  assert.equal(insertedRows.length, 0);
  assert.ok(selectOps[0].some(([op, col, val]) => op === "eq" && col === "type" && val === "cost_alert"));
});

test("enforceCostPolicy cuts at 1,000,000 and logs the day's first cost_cut", async () => {
  reset();
  rpcResponse = { data: 1_000_000, error: null };
  selectQueue = [{ data: [], error: null }];
  const result = await enforceCostPolicy("ws_1");
  assert.deepEqual(result, { policy: "cut", reason: "daily_hard_limit" });
  assert.equal(insertedRows.length, 1);
  assert.equal((insertedRows[0] as { type: string; level: string }).type, "cost_cut");
  assert.equal((insertedRows[0] as { type: string; level: string }).level, "error");

  reset();
  rpcResponse = { data: 1_000_000, error: null };
  selectQueue = [{ data: [{ id: "evt_cut" }], error: null }];
  await enforceCostPolicy("ws_1");
  assert.equal(insertedRows.length, 0, "a second cut the same day adds no event");
});

test("enforceCostPolicy throws when the daily sum RPC errors, so the batch is retried instead of spending unverified", async () => {
  reset();
  rpcResponse = { data: null, error: { message: "boom" } };
  await assert.rejects(() => enforceCostPolicy("ws_1"), /sum_daily_llm_tokens failed: boom/);
});

test("before db-push the cap still holds: a missing sum function falls back to summing the events", async () => {
  reset();
  rpcResponse = {
    data: null,
    error: { code: "PGRST202", hint: "Perhaps you meant to call the function public.reserve_llm_turn" },
  };
  selectQueue = [
    {
      data: [
        { payload: { total_tokens: 700_000 } },
        { payload: { total_tokens: 400_000 } },
        { payload: { total_tokens: "corrupt" } },
      ],
      error: null,
    },
    { data: [], error: null }, // end of the events
    { data: [], error: null }, // the cost_cut lookup
  ];
  const result = await enforceCostPolicy("ws_1");
  assert.deepEqual(result, { policy: "cut", reason: "daily_hard_limit" });
  const sumOps = selectOps[0];
  assert.ok(sumOps.some(([op, col]) => op === "in" && col === "type"));
  assert.ok(sumOps.some(([op, col, val]) => op === "eq" && col === "workspace_id" && val === "ws_1"));
  // A stable order, so no row is skipped or read twice between pages.
  assert.deepEqual(
    sumOps.filter(([op]) => op === "order").map(([, col]) => col),
    ["created_at", "id"],
  );
});

test("the fallback keeps paging by what came back, even when pages are smaller than asked", async () => {
  reset();
  rpcResponse = { data: null, error: { code: "PGRST202", hint: null } };
  const row = { payload: { total_tokens: 300_000 } };
  selectQueue = [
    { data: [row, row], error: null },
    { data: [row, row], error: null },
    { data: [], error: null },
    { data: [], error: null }, // cost_cut lookup
  ];
  const result = await enforceCostPolicy("ws_1");
  assert.deepEqual(result, { policy: "cut", reason: "daily_hard_limit" });
  assert.deepEqual(
    selectOps[1].find(([op]) => op === "range"),
    ["range", 2, 1001],
  );
});

test("the fallback throws rather than return a sum it could not finish", async () => {
  reset();
  rpcResponse = { data: null, error: { code: "PGRST202", hint: null } };
  const page = { data: Array.from({ length: 1000 }, () => ({ payload: { total_tokens: 0 } })), error: null };
  selectQueue = Array.from({ length: 101 }, () => page);
  await assert.rejects(() => enforceCostPolicy("ws_1"), /stopped after 100000 rows/);
});

test("the sum function called with the wrong parameters is a bug: it throws instead of falling back", async () => {
  reset();
  rpcResponse = {
    data: null,
    error: {
      code: "PGRST202",
      message: "Could not find the function",
      hint: "Perhaps you meant to call the function public.sum_daily_llm_tokens(p_day_start, p_workspace_id)",
    },
  };
  await assert.rejects(() => enforceCostPolicy("ws_1"), /sum_daily_llm_tokens failed/);
});

test("enforceCostPolicy trusts a sum past what a single 1000-row PostgREST page could hold", async () => {
  // The Node-side reduce()+PostgREST default row cap used to truncate a
  // sum like this one silently. Aggregating in SQL has no row limit — this
  // test only proves enforceCostPolicy trusts whatever number the RPC
  // returns, since the summing itself now happens in Postgres.
  reset();
  rpcResponse = { data: 1_500_499, error: null };
  const result = await enforceCostPolicy("ws_1");
  assert.deepEqual(result, { policy: "cut", reason: "daily_hard_limit" });
});

test("enforceCostPolicy scopes the daily sum to this workspace and the UTC-midnight day start", async () => {
  reset();
  rpcResponse = { data: 0, error: null };
  await enforceCostPolicy("ws_1");
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].fn, "sum_daily_llm_tokens");
  const args = rpcCalls[0].args as {
    p_workspace_id: string;
    p_day_start: string;
  };
  assert.equal(args.p_workspace_id, "ws_1");
  const parsed = new Date(args.p_day_start);
  assert.equal(parsed.getUTCHours(), 0);
  assert.equal(parsed.getUTCMinutes(), 0);
  assert.equal(parsed.getUTCSeconds(), 0);
  assert.equal(parsed.getUTCMilliseconds(), 0);
});

test("buildCostAwareSystemPrompt returns the fallback message and no model override on cut", async () => {
  const result = await buildCostAwareSystemPrompt("ws_1", "base prompt", "cut");
  assert.equal(result.model, undefined);
  assert.match(result.systemPrompt, /no está disponible temporalmente/);
});

test("buildCostAwareSystemPrompt keeps the whole prompt on degrade and only switches the model", async () => {
  // Persona, rules and guardrails come last in prompt-builder: trimming lines
  // would drop exactly those.
  const base = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n\n");
  const result = await buildCostAwareSystemPrompt("ws_1", base, "degrade");
  assert.deepEqual(result, { systemPrompt: base, model: "openai/gpt-4o-mini" });
});

test("buildCostAwareSystemPrompt returns the base prompt unchanged on allow", async () => {
  const result = await buildCostAwareSystemPrompt("ws_1", "base prompt", "allow");
  assert.deepEqual(result, { systemPrompt: "base prompt" });
});
