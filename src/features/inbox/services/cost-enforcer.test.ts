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

const fakeClient = {
  from() {
    return {
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

test("enforceCostPolicy allows when today's usage is under the warn threshold", async () => {
  rpcResponse = { data: 500_000, error: null };
  const result = await enforceCostPolicy("ws_1");
  assert.deepEqual(result, { policy: "allow", reason: "within_budget" });
});

test("enforceCostPolicy degrades and logs a cost_alert at the warn threshold boundary (exactly 1,000,000)", async () => {
  insertedRows.length = 0;
  rpcResponse = { data: 1_000_000, error: null };
  const result = await enforceCostPolicy("ws_1");
  assert.deepEqual(result, {
    policy: "degrade",
    reason: "daily_warn_threshold",
    fallbackModel: "openai/gpt-4o-mini",
  });
  assert.equal(insertedRows.length, 1);
  assert.equal((insertedRows[0] as { type: string }).type, "cost_alert");
});

test("enforceCostPolicy cuts at the hard limit boundary (exactly 1,500,000) without inserting an alert", async () => {
  insertedRows.length = 0;
  rpcResponse = { data: 1_500_000, error: null };
  const result = await enforceCostPolicy("ws_1");
  assert.deepEqual(result, { policy: "cut", reason: "daily_hard_limit" });
  assert.equal(insertedRows.length, 0);
});

test("enforceCostPolicy fails closed (cut) when the daily sum RPC errors — an unverifiable budget must not allow spend", async () => {
  rpcResponse = { data: null, error: { message: "boom" } };
  const result = await enforceCostPolicy("ws_1");
  assert.deepEqual(result, { policy: "cut", reason: "db_error_fail_closed" });
});

test("enforceCostPolicy trusts a sum past what a single 1000-row PostgREST page could hold", async () => {
  // The Node-side reduce()+PostgREST default row cap used to truncate a
  // sum like this one silently. Aggregating in SQL has no row limit — this
  // test only proves enforceCostPolicy trusts whatever number the RPC
  // returns, since the summing itself now happens in Postgres.
  rpcResponse = { data: 1_500_499, error: null };
  const result = await enforceCostPolicy("ws_1");
  assert.deepEqual(result, { policy: "cut", reason: "daily_hard_limit" });
});

test("enforceCostPolicy scopes the daily sum to this workspace and the UTC-midnight day start", async () => {
  rpcCalls = [];
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

test("buildCostAwareSystemPrompt shortens to the first 20 non-empty lines and sets the fallback model on degrade", async () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  const base = lines.join("\n\n");
  const result = await buildCostAwareSystemPrompt("ws_1", base, "degrade");
  assert.equal(result.model, "openai/gpt-4o-mini");
  const resultLines = result.systemPrompt.split("\n");
  assert.equal(resultLines.length, 20);
  assert.equal(resultLines[0], "line 0");
  assert.equal(resultLines[19], "line 19");
});

test("buildCostAwareSystemPrompt returns the base prompt unchanged on allow", async () => {
  const result = await buildCostAwareSystemPrompt("ws_1", "base prompt", "allow");
  assert.deepEqual(result, { systemPrompt: "base prompt" });
});
