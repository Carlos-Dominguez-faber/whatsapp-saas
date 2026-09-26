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

function thenable<T>(value: T) {
  const chain: any = {
    eq: () => chain,
    order: () => chain,
    single: async () => value,
    then: (resolve: (v: T) => void) => resolve(value),
  };
  return chain;
}

const fakeSvc = {
  rpc: async (fn: string) => {
    calls.push(`rpc:${fn}`);
    return fn === "claim_next_batch" ? { data: [batch], error: null } : { data: null, error: null };
  },
  from: (table: string) => ({
    select: () => {
      if (table === "messages") {
        return thenable({ data: [{ id: "m1", body: "hola", meta: {}, type: "text" }], error: null });
      }
      if (table === "conversations") {
        return thenable({
          data: { id: "conv_1", workspace_id: "ws_1", contact_id: "contact_1", ai_enabled: true, summary: null },
          error: null,
        });
      }
      return thenable({ data: null, error: null });
    },
    update: (row: Row) => {
      if (table === "message_batches") batchUpdates.push(row);
      return thenable({ error: null });
    },
    insert: async (row: Row) => {
      if (table === "events") eventInserts.push(row);
      return { error: null };
    },
  }),
};
mock.module("@supabase/supabase-js", { exports: { createClient: () => fakeSvc } });

let decideResult: Row = { decision: "respond", reason: "normal", availableTools: [], reservationId: "res_1" };
const decideArgs: Row[] = [];
mock.module("./decision-engine.ts", {
  exports: {
    decide: async (opts: Row) => {
      decideArgs.push(opts);
      calls.push("decide");
      return decideResult;
    },
    applyTransition: async () => undefined,
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
mock.module("./cost-tracker.ts", {
  exports: { recordLlmUsage: async (opts: Row) => void usageRecords.push(opts) },
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
mock.module("./openrouter.ts", {
  exports: {
    generateWithTools: async (opts: Row) => {
      calls.push("generate");
      generateArgs.push(opts);
      return { text: "¡Hola!", inputTokens: 120, outputTokens: 30, toolCallsExecuted: 1 };
    },
    getWorkspaceModel: async () => "openai/gpt-4.1",
  },
});

let dispatchError: Error | null = null;
mock.module("./dispatch.ts", {
  exports: {
    dispatchText: async () => {
      calls.push("dispatch");
      if (dispatchError) throw dispatchError;
      return { ok: true };
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

const { processNextBatch } = await import("./buffer.ts");

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

test("once the turn's tokens are recorded, a later failure retries with a fresh reservation", async () => {
  reset();
  dispatchError = new Error("provider down");
  const result = await processNextBatch();
  assert.equal(result.processed, false);
  assert.equal(usageRecords[0].reservationId, "res_1");
  const meta = batchUpdates.at(-1)!.meta as Row;
  // Reusing res_1 would overwrite the tokens this attempt already spent.
  assert.equal("llm_reservation_id" in meta, false);
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
