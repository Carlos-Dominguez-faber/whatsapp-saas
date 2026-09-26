import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

// processNextBatch() wiring: which guard runs when, what a retry keeps, and
// where the turn's reservation ends up. Every collaborator is faked; the
// database is an in-memory fake that honors the filters, so a status guard or
// a workspace scope that is wrong makes the write miss, as it would for real.

type Row = Record<string, unknown>;

// ── in-memory tables ─────────────────────────────────────────────────────────

const tables: Record<string, Row[]> = {};
/** Every UPDATE that matched a row, per table: { patch, rows }. */
const updates: Array<{ table: string; patch: Row; matched: number }> = [];
const calls: string[] = [];
/** Return an error for an UPDATE of `table` whose patch passes the test. */
let failUpdate: (table: string, patch: Row) => boolean = () => false;

function get(row: Row, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (v, key) => (v && typeof v === "object" ? (v as Row)[key] : undefined),
    row,
  );
}

function contains(value: unknown, subset: Row): boolean {
  const obj = (value ?? {}) as Row;
  return Object.entries(subset).every(([k, v]) => obj[k] === v);
}

function query(table: string, mode: "select" | "update" | "delete", patch?: Row) {
  const filters: Array<(r: Row) => boolean> = [];
  let limit = Infinity;
  const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const run = () => {
    if (mode === "update") {
      if (failUpdate(table, patch!)) return { data: null, error: { message: "update failed" } };
      const hit = rows();
      hit.forEach((r) => Object.assign(r, structuredClone(patch)));
      updates.push({ table, patch: structuredClone(patch!), matched: hit.length });
      return { data: null, error: null };
    }
    if (mode === "delete") {
      const hit = new Set(rows());
      tables[table] = (tables[table] ?? []).filter((r) => !hit.has(r));
      return { data: null, error: null };
    }
    return { data: rows().slice(0, limit), error: null };
  };
  const b: any = {
    eq: (c: string, v: unknown) => (filters.push((r) => get(r, c) === v), b),
    is: (c: string, v: unknown) => (filters.push((r) => (get(r, c) ?? null) === v), b),
    gt: (c: string, v: string) => (filters.push((r) => String(get(r, c)) > v), b),
    lt: (c: string, v: string) => (filters.push((r) => String(get(r, c)) < v), b),
    lte: (c: string, v: string) => (filters.push((r) => String(get(r, c)) <= v), b),
    contains: (c: string, v: Row) => (filters.push((r) => contains(get(r, c), v)), b),
    not: (c: string, op: string, v: string) => {
      assert.equal(op, "cs", "the fake only knows not.cs");
      filters.push((r) => !contains(get(r, c), JSON.parse(v)));
      return b;
    },
    order: () => b,
    limit: (n: number) => ((limit = n), b),
    single: async () => {
      const r = rows();
      return r.length === 1
        ? { data: r[0], error: null }
        : { data: null, error: { message: `expected 1 row, got ${r.length}` } };
    },
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
      try {
        resolve(run());
      } catch (e) {
        reject?.(e);
      }
    },
  };
  return b;
}

let upsertRpc: (args: Row) => { data: unknown; error: unknown } = () => ({
  data: "batch_new",
  error: null,
});
const rpcCalls: Array<{ fn: string; args: unknown }> = [];

const fakeSvc = {
  rpc: async (fn: string, args: Row) => {
    calls.push(`rpc:${fn}`);
    rpcCalls.push({ fn, args });
    if (fn === "claim_next_batch") {
      const b = tables.message_batches?.find((r) => r.id === "batch_1");
      return { data: b ? [structuredClone(b)] : [], error: null };
    }
    if (fn === "cancel_batch") {
      const b = tables.message_batches?.find((r) => r.id === args.p_batch_id);
      if (b && b.status === "processing") b.status = "cancelled";
      return { data: null, error: null };
    }
    if (fn === "upsert_batch_and_link_message") return upsertRpc(args);
    return { data: null, error: null };
  },
  from: (table: string) => ({
    select: () => query(table, "select"),
    update: (patch: Row) => {
      if (table === "message_batches" && !patch.status && (patch.meta as Row | undefined)?.pending_reply) {
        calls.push("checkpoint:pending_reply");
      }
      if (table === "message_batches" && !patch.status && (patch.meta as Row | undefined)?.jev_verdict) {
        calls.push("checkpoint:jev_verdict");
      }
      return query(table, "update", patch);
    },
    delete: () => query(table, "delete"),
    insert: (row: Row) => {
      const stored = { id: `${table}_${(tables[table] ?? []).length + 1}`, ...structuredClone(row) };
      (tables[table] ??= []).push(stored);
      const done = { data: stored, error: null };
      return {
        select: () => ({ single: async () => done }),
        then: (resolve: (v: unknown) => void) => resolve({ error: null }),
      };
    },
  }),
};
mock.module("@supabase/supabase-js", { exports: { createClient: () => fakeSvc } });

// ── collaborators ────────────────────────────────────────────────────────────

let decideResult: Row | Error = {
  decision: "respond",
  reason: "normal",
  availableTools: [],
  reservationId: "res_1",
};
const decideArgs: Row[] = [];
const transitions: Array<{ to: string; trigger: unknown }> = [];
mock.module("./decision-engine.ts", {
  exports: {
    decide: async (opts: Row) => {
      decideArgs.push(opts);
      calls.push("decide");
      if (decideResult instanceof Error) throw decideResult;
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
    recordLlmUsage: async (opts: Row) => {
      calls.push("recordLlmUsage");
      usageRecords.push(opts);
    },
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
    applyJevToBatch: async (
      _sb: unknown,
      _input: unknown,
      hooks: { onVerdict?: (v: unknown) => Promise<void> } = {},
    ) => {
      calls.push("jev");
      await hooks.onVerdict?.(jevVerdict);
      calls.push("jev:side_effects");
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

type Execution = { name: string; sensitivity: string; ok: boolean | null };
const generateArgs: Row[] = [];
/** The model's turn: the tools it runs, then its text — or a throw. */
let generated: { text: string; tools?: Execution[]; throwAfterTools?: Error } = {
  text: "¡Hola!",
};
mock.module("./openrouter.ts", {
  exports: {
    generateWithTools: async (opts: Row & { onToolExecuted?: (e: Execution) => Promise<void> }) => {
      calls.push("generate");
      generateArgs.push(opts);
      for (const execution of generated.tools ?? []) {
        await opts.onToolExecuted?.(execution);
      }
      if (generated.throwAfterTools) throw generated.throwAfterTools;
      return {
        text: generated.text,
        inputTokens: 120,
        outputTokens: 30,
        toolCallsExecuted: generated.tools?.length ?? 0,
      };
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
const historyArgs: Row[] = [];
mock.module("./conversation-history.ts", {
  exports: {
    getConversationHistory: async (_conv: string, opts: Row) => {
      historyArgs.push(opts);
      return [];
    },
  },
});
mock.module("./setter.ts", { exports: { getSetterConfig: async () => null, evaluateLead: async () => null } });
mock.module("./highlevel-client.ts", {
  exports: { syncContactToHL: async () => undefined, createHLOpportunity: async () => undefined },
});

const { processNextBatch, upsertBatch, reconcileOrphanedMessages, hasTimeToClaim } = await import(
  "./buffer.ts"
);

// ── fixtures ─────────────────────────────────────────────────────────────────

function batchRow(): Row {
  return tables.message_batches.find((r) => r.id === "batch_1")!;
}
function batchUpdates(): Row[] {
  return updates.filter((u) => u.table === "message_batches" && u.matched > 0).map((u) => u.patch);
}
function notes(): Row[] {
  return (tables.messages ?? []).filter((m) => m.type === "system" && (m.meta as Row)?.internal);
}

function reset(meta: Row = {}) {
  for (const key of Object.keys(tables)) delete tables[key];
  tables.message_batches = [
    { id: "batch_1", workspace_id: "ws_1", conversation_id: "conv_1", status: "processing", meta },
    // Another workspace's batch with the same conversation id: scoping must skip it.
    { id: "batch_1", workspace_id: "ws_other", conversation_id: "conv_1", status: "processing", meta: {} },
  ];
  tables.conversations = [
    {
      id: "conv_1",
      workspace_id: "ws_1",
      contact_id: "contact_1",
      ai_enabled: true,
      summary: null,
      state: "ai_active",
    },
  ];
  tables.messages = [
    {
      id: "m1",
      workspace_id: "ws_1",
      conversation_id: "conv_1",
      batch_id: "batch_1",
      direction: "in",
      type: "text",
      body: "hola",
      meta: {},
      created_at: "2026-09-26T12:00:05Z",
    },
  ];
  tables.events = [];
  updates.length = 0;
  calls.length = 0;
  decideArgs.length = 0;
  usageRecords.length = 0;
  generateArgs.length = 0;
  historyArgs.length = 0;
  decideResult = { decision: "respond", reason: "normal", availableTools: [], reservationId: "res_1" };
  costPolicy = { policy: "allow", reason: "within_budget" };
  whatsappSettings = { provider: "ycloud", config: {} };
  jevVerdict = { suppressReply: false, ownsStage: false };
  modelPolicy = (model: string) => model;
  modelPolicyArgs.length = 0;
  dispatchError = null;
  dispatchResult = { ok: true };
  dispatchArgs.length = 0;
  generated = { text: "¡Hola!" };
  transitions.length = 0;
  rpcCalls.length = 0;
  rateAllowed = true;
  failUpdate = () => false;
  upsertRpc = () => ({ data: "batch_new", error: null });
}

// ── the turn ─────────────────────────────────────────────────────────────────

test("the turn's reservation reaches recordLlmUsage, so the turn counts once", async () => {
  reset();
  const result = await processNextBatch();
  assert.deepEqual(result, { processed: true, conversationId: "conv_1", batchId: "batch_1" });
  assert.equal(usageRecords.length, 1);
  assert.equal(usageRecords[0].reservationId, "res_1");
  assert.equal(usageRecords[0].promptTokens, 120);
  assert.equal(batchRow().status, "processed");
  const other = tables.message_batches.find((r) => r.workspace_id === "ws_other")!;
  assert.equal(other.status, "processing", "another workspace's batch is never touched");
});

test("order: decide → Jev → WhatsApp provider → budget → KB search → model", async () => {
  reset();
  await processNextBatch();
  const order = ["decide", "jev", "loadWhatsAppSettings", "enforceCostPolicy", "searchKb", "generate"];
  const positions = order.map((c) => calls.indexOf(c));
  assert.ok(positions.every((p) => p >= 0), calls.join(" → "));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, calls.join(" → "));
});

test("the history stops at this batch's last message", async () => {
  reset();
  await processNextBatch();
  assert.equal(historyArgs[0].until, "2026-09-26T12:00:05Z");
  assert.equal(historyArgs[0].workspaceId, "ws_1");
  assert.equal(historyArgs[0].excludeBatchId, "batch_1");
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
  assert.equal(batchRow().status, "processed");
});

test("a reply Jev suppresses is processed even without a WhatsApp provider", async () => {
  reset();
  jevVerdict = { suppressReply: true, ownsStage: false };
  whatsappSettings = null;
  const result = await processNextBatch();
  assert.equal(result.processed, true);
  assert.equal(batchRow().status, "processed");
  assert.ok(!calls.includes("enforceCostPolicy"));
});

test("Jev's verdict is saved on the batch before its side effects run", async () => {
  reset();
  await processNextBatch();
  const saved = calls.indexOf("checkpoint:jev_verdict");
  const sideEffects = calls.indexOf("jev:side_effects");
  assert.ok(saved >= 0 && saved < sideEffects, calls.join(" → "));
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
  assert.notEqual(batchRow().status, "processed");
  assert.ok(!calls.includes("generate"));
  const retry = batchUpdates().at(-1)!;
  assert.equal(retry.status, "buffering");
  const meta = retry.meta as Row;
  assert.equal(meta.retry_count, 1);
  assert.equal(meta.llm_reservation_id, "res_1");
  assert.deepEqual(meta.jev_verdict, { suppressReply: false, ownsStage: false });
  // Its reply is half-decided: new messages must open their own batch.
  assert.equal(meta.isolated, true);
});

test("a batch re-queued before any checkpoint stays open to new messages", async () => {
  reset();
  decideResult = new Error("decide failed");
  await processNextBatch();
  const retry = batchUpdates().at(-1)!;
  assert.equal(retry.status, "buffering");
  assert.equal((retry.meta as Row).isolated, undefined);
});

test("once the reply exists, a later failure keeps the reply and drops the spent reservation", async () => {
  reset();
  dispatchError = new Error("provider down");
  const result = await processNextBatch();
  assert.equal(result.processed, false);
  assert.equal(usageRecords[0].reservationId, "res_1");
  const meta = batchUpdates().at(-1)!.meta as Row;
  // Reusing res_1 would overwrite the tokens this attempt already spent.
  assert.equal("llm_reservation_id" in meta, false);
  assert.equal(meta.pending_reply, "¡Hola!");
  assert.equal(meta.isolated, true);
});

test("the spent reservation is dropped from the saved checkpoint right after recording usage", async () => {
  reset();
  await processNextBatch();
  const recordedAt = calls.indexOf("recordLlmUsage");
  const firstWithoutReservation = updates.findIndex(
    (u) =>
      u.table === "message_batches" &&
      !u.patch.status &&
      (u.patch.meta as Row).jev_verdict &&
      !("llm_reservation_id" in (u.patch.meta as Row)) &&
      !(u.patch.meta as Row).pending_reply,
  );
  assert.ok(recordedAt >= 0);
  assert.ok(firstWithoutReservation >= 0, "a checkpoint without the reservation is saved before the reply");
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
  assert.equal(batchRow().status, "processed");
});

test("the reply is saved on the batch before it is sent, and the send carries the batch id", async () => {
  reset();
  await processNextBatch();
  const checkpointAt = calls.indexOf("checkpoint:pending_reply");
  const dispatchAt = calls.indexOf("dispatch");
  assert.ok(checkpointAt > 0, calls.join(" → "));
  assert.ok(checkpointAt < dispatchAt, "saved before the send, so a crash can't lose it");
  assert.deepEqual(dispatchArgs[0].meta, { batch_id: "batch_1" });
  assert.equal(dispatchArgs[0].noteWhenBlocked, true);
});

test("a reply an earlier attempt already sent is not sent again", async () => {
  reset({ retry_count: 1, pending_reply: "¡Hola!" });
  tables.messages.push({
    id: "out_1",
    workspace_id: "ws_1",
    conversation_id: "conv_1",
    direction: "out",
    status: "sent",
    meta: { batch_id: "batch_1" },
  });
  const result = await processNextBatch();
  assert.equal(result.processed, true);
  assert.ok(!calls.includes("dispatch"));
  assert.equal(batchRow().status, "processed");
});

test("a send an earlier attempt left 'queued' is marked unconfirmed, never re-sent", async () => {
  reset({ retry_count: 1, pending_reply: "¡Hola!" });
  const row: Row = {
    id: "out_1",
    workspace_id: "ws_1",
    conversation_id: "conv_1",
    direction: "out",
    status: "queued",
    meta: { batch_id: "batch_1" },
  };
  tables.messages.push(row);
  await processNextBatch();
  assert.ok(!calls.includes("dispatch"));
  assert.equal(row.status, "failed");
  assert.match(String(row.error_message), /confirmar el envío/);
});

test("a batch that can't be closed after its reply is re-queued with the reply, not re-generated", async () => {
  reset();
  failUpdate = (table, patch) => table === "message_batches" && patch.status === "processed";
  const original = console.error;
  console.error = () => {};
  try {
    const result = await processNextBatch();
    assert.equal(result.processed, false);
  } finally {
    console.error = original;
  }
  const retry = batchUpdates().at(-1)!;
  assert.equal(retry.status, "buffering");
  assert.equal((retry.meta as Row).pending_reply, "¡Hola!");
});

test("a send WhatsApp didn't accept is retried with the same text, without a failed row", async () => {
  reset();
  dispatchResult = { ok: false, retryable: true, errorCode: "SEND_FAILED" };
  const result = await processNextBatch();
  assert.equal(result.processed, false);
  assert.equal(dispatchArgs[0].recordRetryableFailure, false);
  const retry = batchUpdates().at(-1)!;
  assert.equal(retry.status, "buffering");
  assert.equal((retry.meta as Row).pending_reply, "¡Hola!");
});

test("on the last attempt the failure is recorded for the team and the batch closes", async () => {
  reset({ retry_count: 3, pending_reply: "¡Hola!" });
  dispatchResult = { ok: false, retryable: true, errorCode: "SEND_FAILED" };
  const result = await processNextBatch();
  assert.equal(result.processed, true);
  assert.equal(dispatchArgs[0].recordRetryableFailure, true);
  assert.equal(batchRow().status, "processed");
});

test("a failure the message may have survived is not retried", async () => {
  reset();
  dispatchResult = { ok: false, retryable: false, errorCode: "SEND_FAILED" };
  const result = await processNextBatch();
  assert.equal(result.processed, true);
  assert.equal(batchRow().status, "processed");
});

test("if a person took the conversation during the turn, the reply is not sent", async () => {
  reset();
  tables.conversations[0].state = "human_active";
  const result = await processNextBatch();
  assert.equal(result.processed, true);
  assert.ok(!calls.includes("dispatch"));
  assert.equal(batchRow().status, "processed");
});

// ── write tools: never run twice ──────────────────────────────────────────────

test("a model failure after a write went through hands off instead of re-running it", async () => {
  reset();
  generated = {
    text: "",
    tools: [{ name: "schedule_highlevel", sensitivity: "write", ok: true }],
    throwAfterTools: new Error("provider 500 on step 3"),
  };
  const result = await processNextBatch();
  assert.equal(result.processed, true);
  assert.deepEqual(transitions, [{ to: "handoff_pending", trigger: "write_tool_unfinished" }]);
  assert.match(String(notes()[0]?.body), /schedule_highlevel/);
  assert.equal(batchRow().status, "processed");
});

test("a reclaimed batch whose write already ran hands off without running the turn", async () => {
  reset({ retry_count: 1, write_tools_ran: [{ name: "schedule_highlevel", ok: true }] });
  await processNextBatch();
  for (const skipped of ["decide", "jev", "generate", "dispatch"]) {
    assert.ok(!calls.includes(skipped), skipped);
  }
  assert.equal(transitions[0]?.trigger, "write_tool_unfinished");
});

test("each write is saved on the batch the moment it returns", async () => {
  reset();
  generated = {
    text: "Listo",
    tools: [{ name: "schedule_highlevel", sensitivity: "write", ok: true }],
  };
  await processNextBatch();
  const saved = batchUpdates().find((u) => Array.isArray((u.meta as Row | undefined)?.write_tools_ran));
  assert.deepEqual((saved!.meta as Row).write_tools_ran, [{ name: "schedule_highlevel", ok: true }]);
});

test("a write the tool reported as failed, or a read, is not counted", async () => {
  reset();
  generated = {
    text: "",
    tools: [
      { name: "check_availability", sensitivity: "read", ok: true },
      { name: "schedule_highlevel", sensitivity: "write", ok: false },
    ],
  };
  const result = await processNextBatch();
  assert.equal(result.processed, false, "nothing was written: the turn is regenerated");
  assert.deepEqual(transitions, []);
  assert.equal(batchUpdates().at(-1)!.status, "buffering");
});

// ── empty replies, the budget cut and dead letters ────────────────────────────

test("an empty reply with no write done is regenerated on retry", async () => {
  reset();
  generated = { text: "  " };
  const result = await processNextBatch();
  assert.equal(result.processed, false);
  assert.ok(!calls.includes("dispatch"));
  assert.equal(batchUpdates().at(-1)!.status, "buffering");
});

test("an empty reply after a write went through hands off instead of running it again", async () => {
  reset();
  generated = { text: "", tools: [{ name: "schedule_highlevel", sensitivity: "write", ok: true }] };
  const result = await processNextBatch();
  assert.equal(result.processed, true);
  assert.deepEqual(transitions, [{ to: "handoff_pending", trigger: "empty_reply" }]);
  assert.ok(!calls.includes("dispatch"));
  assert.equal(batchRow().status, "processed");
});

test("an empty reply after a write that timed out hands off too (it may have happened)", async () => {
  reset();
  generated = { text: "", tools: [{ name: "schedule_highlevel", sensitivity: "write", ok: null }] };
  const result = await processNextBatch();
  assert.equal(result.processed, true);
  assert.equal(transitions[0]?.trigger, "write_tool_unfinished");
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

test("out of retries, a person takes over and the thread says why", async () => {
  reset({ retry_count: 3 });
  generated = { text: "" };
  const original = console.error;
  console.error = () => {};
  try {
    const result = await processNextBatch();
    assert.equal(result.processed, false);
  } finally {
    console.error = original;
  }
  assert.ok(rpcCalls.some((c) => c.fn === "cancel_batch"));
  assert.equal(batchRow().status, "cancelled");
  assert.deepEqual(transitions, [{ to: "handoff_pending", trigger: "batch_dead_letter" }]);
  assert.equal((notes()[0]?.meta as Row).reason, "batch_dead_letter");
  assert.ok(tables.events.some((e) => e.type === "batch_dead_letter"));
});

// ── upsertBatch, the orphan reconciler and the time budget ────────────────────

test("upsertBatch links through the atomic RPC", async () => {
  reset();
  const id = await upsertBatch({ workspaceId: "ws_1", conversationId: "conv_1", messageId: "m1" });
  assert.equal(id, "batch_new");
  assert.equal(rpcCalls[0].fn, "upsert_batch_and_link_message");
  assert.equal((rpcCalls[0].args as Row).p_force_new_batch, false);
});

test("before db-push, upsertBatch keeps batching the old way — never into an isolated batch", async () => {
  reset();
  tables.message_batches = [
    { id: "retry", workspace_id: "ws_1", conversation_id: "conv_2", status: "buffering", message_count: 1, meta: { isolated: true } },
  ];
  tables.messages.push({ id: "m9", workspace_id: "ws_1", conversation_id: "conv_2", direction: "in", meta: {} });
  upsertRpc = () => ({
    data: null,
    error: {
      code: "PGRST202",
      message: "Could not find the function",
      // #9's 4-parameter version is installed.
      hint: "Perhaps you meant to call the function public.upsert_batch_and_link_message(p_conversation_id, p_message_id, p_silence_ms, p_workspace_id)",
    },
  });
  const original = console.error;
  console.error = () => {};
  try {
    const id = await upsertBatch({ workspaceId: "ws_1", conversationId: "conv_2", messageId: "m9" });
    assert.notEqual(id, "retry");
  } finally {
    console.error = original;
  }
  assert.equal(tables.message_batches.length, 2, "a new batch, not the isolated one");
  assert.equal(tables.messages.find((m) => m.id === "m9")!.batch_id, tables.message_batches[1].id);
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
  const now = Date.now();
  const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();
  tables.messages = [
    { id: "o1", workspace_id: "ws_1", conversation_id: "conv_1", batch_id: null, direction: "in", created_at: minutesAgo(5), conversations: { ai_enabled: true, contact_id: "c1" } },
    { id: "o2", workspace_id: "ws_1", conversation_id: "conv_2", batch_id: null, direction: "in", created_at: minutesAgo(5), conversations: { ai_enabled: false, contact_id: "c2" } },
    { id: "o3", workspace_id: "ws_1", conversation_id: "conv_3", batch_id: null, direction: "in", created_at: minutesAgo(40), conversations: { ai_enabled: true, contact_id: "c3" } },
  ];
  assert.equal(await reconcileOrphanedMessages(), 1);
  const args = rpcCalls.find((c) => c.fn === "upsert_batch_and_link_message")!.args as Row;
  assert.equal(args.p_message_id, "o1");
  assert.equal(args.p_force_new_batch, true);
  assert.equal(args.p_silence_ms, 0);

  reset();
  tables.messages = [
    { id: "o1", workspace_id: "ws_1", conversation_id: "conv_1", batch_id: null, direction: "in", created_at: minutesAgo(5), conversations: { ai_enabled: true, contact_id: "c1" } },
  ];
  rateAllowed = false;
  assert.equal(await reconcileOrphanedMessages(), 0);
});

test("a batch is claimed only with 90 s of the function's time left", () => {
  const start = 1_000_000;
  assert.equal(hasTimeToClaim(start, 300, start + 200_000), true);
  assert.equal(hasTimeToClaim(start, 300, start + 211_000), false);
  assert.equal(hasTimeToClaim(start, 120, start + 31_000), false);
});
