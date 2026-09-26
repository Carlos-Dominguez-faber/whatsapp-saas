import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

// processNextBatch() wiring: which guard runs when, what a retry keeps, and
// where the turn's reservation ends up. Every collaborator is faked.

type Row = Record<string, unknown>;

let batch: Row;
const batchUpdates: Row[] = [];
const eventInserts: Row[] = [];
const calls: string[] = [];

function thenable<T>(value: T, onLimit?: () => unknown) {
  const chain: any = {
    eq: () => chain,
    is: () => chain,
    gt: () => chain,
    lt: () => chain,
    order: () => chain,
    limit: (..._args: unknown[]) => (onLimit ? thenable(onLimit()) : chain),
    single: async () => value,
    maybeSingle: async () => value,
    then: (resolve: (v: T) => void) => resolve(value),
  };
  return chain;
}

let conversationState = "ai_active";
let orphanRows: Row[] = [];
const rpcCalls: Array<{ fn: string; args: unknown }> = [];
let upsertRpc: (args: Row) => { data: unknown; error: unknown } = () => ({
  data: "batch_new",
  error: null,
});
const legacyWrites: Array<{ table: string; op: string; row?: Row }> = [];

const fakeSvc = {
  rpc: async (fn: string, args: Row) => {
    calls.push(`rpc:${fn}`);
    rpcCalls.push({ fn, args });
    if (fn === "claim_next_batch") return { data: [batch], error: null };
    if (fn === "upsert_batch_and_link_message") return upsertRpc(args);
    return { data: null, error: null };
  },
  from: (table: string) => ({
    select: () => {
      if (table === "messages") {
        // consolidateBatch awaits the chain; the orphan lookup ends in .limit().
        return thenable(
          { data: [{ id: "m1", body: "hola", meta: {}, type: "text" }], error: null },
          () => ({ data: orphanRows, error: null }),
        );
      }
      if (table === "conversations") {
        return thenable({
          data: {
            id: "conv_1",
            workspace_id: "ws_1",
            contact_id: "contact_1",
            ai_enabled: true,
            summary: null,
            state: conversationState,
          },
          error: null,
        });
      }
      if (table === "message_batches") {
        legacyWrites.push({ table, op: "select" });
        return thenable({ data: null, error: null });
      }
      return thenable({ data: null, error: null });
    },
    update: (row: Row) => {
      if (table === "message_batches") {
        batchUpdates.push(row);
        if (!row.status && (row.meta as Row | undefined)?.pending_reply) {
          calls.push("checkpoint:pending_reply");
        }
      }
      if (table === "messages") legacyWrites.push({ table, op: "update", row });
      return thenable({ error: null });
    },
    insert: (row: Row) => {
      if (table === "events") eventInserts.push(row);
      if (table === "message_batches") legacyWrites.push({ table, op: "insert", row });
      const done = { error: null };
      return {
        select: () => ({ single: async () => ({ data: { id: "batch_legacy" }, error: null }) }),
        then: (resolve: (v: unknown) => void) => resolve(done),
      };
    },
  }),
};
mock.module("@supabase/supabase-js", { exports: { createClient: () => fakeSvc } });

let decideResult: Row = { decision: "respond", reason: "normal", availableTools: [], reservationId: "res_1" };
const decideArgs: Row[] = [];
const transitions: Array<{ to: string; trigger: unknown }> = [];
mock.module("./decision-engine.ts", {
  exports: {
    decide: async (opts: Row) => {
      decideArgs.push(opts);
      calls.push("decide");
      return decideResult;
    },
    applyTransition: async (_conv: string, to: string, opts: Row = {}) => {
      transitions.push({ to, trigger: opts.trigger });
    },
  },
});

let costPolicy: Row | Error = { policy: "allow", reason: "within_budget" };
mock.module("./cost-enforcer.ts", {
  exports: {
    enforceCostPolicy: async () => {
      calls.push("enforceCostPolicy");
      if (costPolicy instanceof Error) throw costPolicy;
      return costPolicy;
    },
    buildCostAwareSystemPrompt: async (_ws: string, prompt: string, policy: string) =>
      policy === "degrade" ? { systemPrompt: prompt, model: "openai/gpt-4o-mini" } : { systemPrompt: prompt },
  },
});

const usageRecords: Row[] = [];
let rateAllowed = true;
mock.module("./cost-tracker.ts", {
  exports: {
    recordLlmUsage: async (opts: Row) => void usageRecords.push(opts),
    checkRateLimits: async () => ({ allowed: rateAllowed }),
  },
});

let whatsappSettings: Row | null = { provider: "ycloud", config: {} };
mock.module("./whatsapp-provider.ts", {
  exports: {
    loadWhatsAppSettings: async () => {
      calls.push("loadWhatsAppSettings");
      return whatsappSettings;
    },
    WHATSAPP_NOT_CONNECTED: "WHATSAPP_NOT_CONNECTED",
  },
});

let jevVerdict = { suppressReply: false, ownsStage: false };
mock.module("@/features/jev-judge/apply.ts", {
  exports: {
    applyJevToBatch: async () => {
      calls.push("jev");
      return jevVerdict;
    },
  },
});

let modelPolicy = (model: string) => model;
const modelPolicyArgs: unknown[][] = [];
mock.module("./model-policy.ts", {
  exports: {
    enforceModelPolicy: async (_sb: unknown, ws: string, model: string, source: string) => {
      modelPolicyArgs.push([ws, model, source]);
      return modelPolicy(model);
    },
  },
});

const generateArgs: Row[] = [];
let generated = { text: "¡Hola!", toolCallsExecuted: 1 };
mock.module("./openrouter.ts", {
  exports: {
    generateWithTools: async (opts: Row) => {
      calls.push("generate");
      generateArgs.push(opts);
      return { ...generated, inputTokens: 120, outputTokens: 30 };
    },
    getWorkspaceModel: async () => "openai/gpt-4.1",
  },
});

let dispatchError: Error | null = null;
let dispatchResult: Row = { ok: true };
const dispatchArgs: Row[] = [];
mock.module("./dispatch.ts", {
  exports: {
    dispatchText: async (opts: Row) => {
      calls.push("dispatch");
      dispatchArgs.push(opts);
      if (dispatchError) throw dispatchError;
      return dispatchResult;
    },
    dispatchTemplate: async () => ({ ok: true }),
  },
});

mock.module("./kb-service.ts", {
  exports: {
    searchKb: async () => {
      calls.push("searchKb");
      return [];
    },
    formatKbContext: () => "",
    listKbSourceLinks: async () => [],
    formatKbReferenceLinks: () => "",
  },
});
mock.module("./prompt-resolver.ts", { exports: { resolveSystemPrompt: async () => null } });
mock.module("./prompt-builder.ts", { exports: { buildSystemPrompt: () => "SYSTEM PROMPT" } });
mock.module("@/features/agents/services/active-agent.ts", { exports: { getActiveAgent: async () => null } });
mock.module("@/features/agents/services/auto-tagging.ts", { exports: { maybeAutoProcess: async () => undefined } });
mock.module("./business-info.ts", {
  exports: {
    getBusinessInfo: async () => null,
    buildBusinessInfoContext: () => "",
    buildNowContext: () => "",
  },
});
mock.module("./conversation-history.ts", { exports: { getConversationHistory: async () => [] } });
mock.module("./setter.ts", { exports: { getSetterConfig: async () => null, evaluateLead: async () => null } });
mock.module("./highlevel-client.ts", {
  exports: { syncContactToHL: async () => undefined, createHLOpportunity: async () => undefined },
});

const { processNextBatch, upsertBatch, reconcileOrphanedMessages } = await import(
  "./buffer.ts"
);

function reset(meta: Row = {}) {
  batch = {
    id: "batch_1",
    workspace_id: "ws_1",
    conversation_id: "conv_1",
    status: "processing",
    meta,
  };
  batchUpdates.length = 0;
  eventInserts.length = 0;
  calls.length = 0;
  decideArgs.length = 0;
  usageRecords.length = 0;
  generateArgs.length = 0;
  decideResult = { decision: "respond", reason: "normal", availableTools: [], reservationId: "res_1" };
  costPolicy = { policy: "allow", reason: "within_budget" };
  whatsappSettings = { provider: "ycloud", config: {} };
  jevVerdict = { suppressReply: false, ownsStage: false };
  modelPolicy = (model: string) => model;
  modelPolicyArgs.length = 0;
  dispatchError = null;
  dispatchResult = { ok: true };
  dispatchArgs.length = 0;
  generated = { text: "¡Hola!", toolCallsExecuted: 1 };
  conversationState = "ai_active";
  transitions.length = 0;
  rpcCalls.length = 0;
  legacyWrites.length = 0;
  orphanRows = [];
  rateAllowed = true;
  upsertRpc = () => ({ data: "batch_new", error: null });
}

test("the turn's reservation reaches recordLlmUsage, so the turn counts once", async () => {
  reset();
  const result = await processNextBatch();
  assert.deepEqual(result, { processed: true, conversationId: "conv_1" });
  assert.equal(usageRecords.length, 1);
  assert.equal(usageRecords[0].reservationId, "res_1");
  assert.equal(usageRecords[0].promptTokens, 120);
  assert.equal(batchUpdates.at(-1)?.status, "processed");
});

test("order: decide → Jev → WhatsApp provider → budget → KB search → model", async () => {
  reset();
  await processNextBatch();
  const order = ["decide", "jev", "loadWhatsAppSettings", "enforceCostPolicy", "searchKb", "generate"];
  const positions = order.map((c) => calls.indexOf(c));
  assert.ok(positions.every((p) => p >= 0), calls.join(" → "));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, calls.join(" → "));
});

test("on a cut day Jev still runs (it can hand off to a person), but not the KB or the model", async () => {
  reset();
  costPolicy = { policy: "cut", reason: "daily_hard_limit" };
  const result = await processNextBatch();
  assert.equal(result.processed, true);
  assert.ok(calls.includes("jev"));
  for (const skipped of ["searchKb", "generate", "dispatch"]) {
    assert.ok(!calls.includes(skipped), `${skipped} must not run on cut`);
  }
  assert.equal(batchUpdates.at(-1)?.status, "processed");
});

test("a reply Jev suppresses is processed even without a WhatsApp provider", async () => {
  reset();
  jevVerdict = { suppressReply: true, ownsStage: false };
  whatsappSettings = null;
  const result = await processNextBatch();
  assert.equal(result.processed, true);
  assert.equal(batchUpdates.at(-1)?.status, "processed");
  assert.ok(!calls.includes("enforceCostPolicy"));
});

test("a retry reuses the Jev verdict of its first attempt instead of judging again", async () => {
  reset({ retry_count: 1, jev_verdict: { suppressReply: false, ownsStage: true } });
  await processNextBatch();
  assert.ok(!calls.includes("jev"));
  assert.ok(calls.includes("generate"));
});

test("a budget read error retries the batch — it is not marked processed — keeping the reservation and the Jev verdict", async () => {
  reset();
  costPolicy = new Error("sum_daily_llm_tokens failed: timeout");
  const result = await processNextBatch();
  assert.equal(result.processed, false);
  assert.ok(!batchUpdates.some((u) => u.status === "processed"));
  assert.ok(!calls.includes("generate"));
  const retry = batchUpdates.at(-1)!;
  assert.equal(retry.status, "buffering");
  const meta = retry.meta as Row;
  assert.equal(meta.retry_count, 1);
  assert.equal(meta.llm_reservation_id, "res_1");
  assert.deepEqual(meta.jev_verdict, { suppressReply: false, ownsStage: false });
});

test("once the reply exists, a later failure keeps the reply and drops the spent reservation", async () => {
  reset();
  dispatchError = new Error("provider down");
  const result = await processNextBatch();
  assert.equal(result.processed, false);
  assert.equal(usageRecords[0].reservationId, "res_1");
  const meta = batchUpdates.at(-1)!.meta as Row;
  // Reusing res_1 would overwrite the tokens this attempt already spent.
  assert.equal("llm_reservation_id" in meta, false);
  assert.equal(meta.pending_reply, "¡Hola!");
});

test("the model goes through the catalog policy before the call", async () => {
  reset();
  modelPolicy = () => "openai/gpt-4o-mini";
  await processNextBatch();
  assert.deepEqual(modelPolicyArgs[0], ["ws_1", "openai/gpt-4.1", "agent_turn"]);
  assert.equal(generateArgs[0].model, "openai/gpt-4o-mini");
  assert.equal(usageRecords[0].model, "openai/gpt-4o-mini");
});

test("a retry hands its earlier reservation to decide instead of taking a new slot", async () => {
  reset({ retry_count: 1, llm_reservation_id: "res_prev" });
  decideResult = { decision: "respond", reason: "normal", availableTools: [], reservationId: "res_prev" };
  await processNextBatch();
  assert.equal(decideArgs[0].reservationId, "res_prev");
  assert.equal(usageRecords[0].reservationId, "res_prev");
});

test("without a WhatsApp provider the batch retries before the budget, the KB or the model", async () => {
  reset();
  whatsappSettings = null;
  const result = await processNextBatch();
  assert.equal(result.processed, false);
  for (const skipped of ["enforceCostPolicy", "searchKb", "generate"]) {
    assert.ok(!calls.includes(skipped), skipped);
  }
});

test("a degraded budget keeps the full prompt and only switches the model", async () => {
  reset();
  costPolicy = { policy: "degrade", reason: "daily_warn_threshold", fallbackModel: "openai/gpt-4o-mini" };
  await processNextBatch();
  assert.equal(generateArgs[0].systemPrompt, "SYSTEM PROMPT");
  assert.equal(generateArgs[0].model, "openai/gpt-4o-mini");
});

// ── pending reply: a retry re-sends, it never regenerates ─────────────────────

test("a retry with a saved reply only delivers it: no decide, Jev, model or tools", async () => {
  reset({ retry_count: 1, pending_reply: "Tu cita quedó el martes." });
  const result = await processNextBatch();
  assert.equal(result.processed, true);
  for (const skipped of ["decide", "jev", "enforceCostPolicy", "searchKb", "generate"]) {
    assert.ok(!calls.includes(skipped), `${skipped} must not run on a resend`);
  }
  assert.equal(dispatchArgs[0].body, "Tu cita quedó el martes.");
  assert.equal(usageRecords.length, 0);
  assert.equal(batchUpdates.at(-1)?.status, "processed");
});

test("the reply is saved on the batch before it is sent", async () => {
  reset();
  await processNextBatch();
  const checkpointAt = calls.indexOf("checkpoint:pending_reply");
  const dispatchAt = calls.indexOf("dispatch");
  assert.ok(checkpointAt > 0, calls.join(" → "));
  assert.ok(checkpointAt < dispatchAt, "saved before the send, so a crash can't lose it");
});

test("a send WhatsApp didn't accept is retried with the same text, without a failed row", async () => {
  reset();
  dispatchResult = { ok: false, retryable: true, errorCode: "SEND_FAILED" };
  const result = await processNextBatch();
  assert.equal(result.processed, false);
  assert.equal(dispatchArgs[0].recordRetryableFailure, false);
  const retry = batchUpdates.at(-1)!;
  assert.equal(retry.status, "buffering");
  assert.equal((retry.meta as Row).pending_reply, "¡Hola!");
});

test("on the last attempt the failure is recorded for the team and the batch closes", async () => {
  reset({ retry_count: 3, pending_reply: "¡Hola!" });
  dispatchResult = { ok: false, retryable: true, errorCode: "SEND_FAILED" };
  const result = await processNextBatch();
  assert.equal(result.processed, true);
  assert.equal(dispatchArgs[0].recordRetryableFailure, true);
  assert.equal(batchUpdates.at(-1)?.status, "processed");
});

test("a failure the message may have survived is not retried", async () => {
  reset();
  dispatchResult = { ok: false, retryable: false, errorCode: "SEND_FAILED" };
  const result = await processNextBatch();
  assert.equal(result.processed, true);
  assert.equal(batchUpdates.at(-1)?.status, "processed");
});

test("if a person took the conversation during the turn, the reply is not sent", async () => {
  reset();
  conversationState = "human_active";
  const result = await processNextBatch();
  assert.equal(result.processed, true);
  assert.ok(!calls.includes("dispatch"));
  assert.equal(batchUpdates.at(-1)?.status, "processed");
});

// ── empty replies and the budget cut ──────────────────────────────────────────

test("an empty reply with no tool run is regenerated on retry", async () => {
  reset();
  generated = { text: "  ", toolCallsExecuted: 0 };
  const result = await processNextBatch();
  assert.equal(result.processed, false);
  assert.ok(!calls.includes("dispatch"));
  assert.equal(batchUpdates.at(-1)?.status, "buffering");
});

test("an empty reply after a tool ran hands off instead of running the tool again", async () => {
  reset();
  generated = { text: "", toolCallsExecuted: 2 };
  const result = await processNextBatch();
  assert.equal(result.processed, true);
  assert.deepEqual(transitions, [{ to: "handoff_pending", trigger: "empty_reply" }]);
  assert.ok(!calls.includes("dispatch"));
  assert.equal(batchUpdates.at(-1)?.status, "processed");
});

test("the budget cut hands off to a person only when the workspace opted in", async () => {
  reset();
  costPolicy = { policy: "cut", reason: "daily_hard_limit" };
  await processNextBatch();
  assert.deepEqual(transitions, []);

  reset();
  costPolicy = { policy: "cut", reason: "daily_hard_limit" };
  whatsappSettings = { provider: "ycloud", config: { cost_cut_handoff: true } };
  await processNextBatch();
  assert.deepEqual(transitions, [{ to: "handoff_pending", trigger: "cost_cut" }]);
});

// ── upsertBatch and the orphan reconciler ─────────────────────────────────────

test("upsertBatch links through the atomic RPC", async () => {
  reset();
  const id = await upsertBatch({ workspaceId: "ws_1", conversationId: "conv_1", messageId: "m1" });
  assert.equal(id, "batch_new");
  assert.equal(rpcCalls[0].fn, "upsert_batch_and_link_message");
  assert.equal((rpcCalls[0].args as Row).p_force_new_batch, false);
  assert.equal(legacyWrites.length, 0);
});

test("before db-push, upsertBatch keeps batching the old way instead of failing", async () => {
  reset();
  upsertRpc = () => ({
    data: null,
    error: { code: "PGRST202", message: "Could not find the function", hint: null },
  });
  const original = console.error;
  console.error = () => {};
  try {
    const id = await upsertBatch({ workspaceId: "ws_1", conversationId: "conv_1", messageId: "m1" });
    assert.equal(id, "batch_legacy");
  } finally {
    console.error = original;
  }
  assert.ok(legacyWrites.some((w) => w.op === "insert"));
});

test("upsertBatch throws after its retries on a real database error", async () => {
  reset();
  upsertRpc = () => ({ data: null, error: { code: "57014", message: "timeout" } });
  const original = console.error;
  console.error = () => {};
  try {
    await assert.rejects(
      upsertBatch(
        { workspaceId: "ws_1", conversationId: "conv_1", messageId: "m1" },
        { attempts: 2, sleep: async () => {} },
      ),
      /Failed to upsert batch/,
    );
  } finally {
    console.error = original;
  }
  assert.equal(rpcCalls.length, 2);
});

test("an orphan gets an isolated batch flushed now; AI-off or rate-limited ones don't", async () => {
  reset();
  orphanRows = [
    { id: "o1", workspace_id: "ws_1", conversation_id: "conv_1", conversations: { ai_enabled: true, contact_id: "c1" } },
    { id: "o2", workspace_id: "ws_1", conversation_id: "conv_2", conversations: { ai_enabled: false, contact_id: "c2" } },
  ];
  assert.equal(await reconcileOrphanedMessages(), 1);
  const args = rpcCalls.find((c) => c.fn === "upsert_batch_and_link_message")!.args as Row;
  assert.equal(args.p_message_id, "o1");
  assert.equal(args.p_force_new_batch, true);
  assert.equal(args.p_silence_ms, 0);

  reset();
  orphanRows = [
    { id: "o1", workspace_id: "ws_1", conversation_id: "conv_1", conversations: { ai_enabled: true, contact_id: "c1" } },
  ];
  rateAllowed = false;
  assert.equal(await reconcileOrphanedMessages(), 0);
});
