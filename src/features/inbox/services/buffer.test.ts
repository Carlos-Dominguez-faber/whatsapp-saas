import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

interface QueueEntry {
  data?: unknown;
  error?: unknown;
}

let responseQueue: QueueEntry[] = [];
let rpcQueue: QueueEntry[] = [];
let rpcCalls: Array<{ fn: string; args: unknown }> = [];
let updates: Array<{ table: string; row: unknown; eqArgs: unknown[][] }> = [];
let inserts: Array<{ table: string; row: unknown }> = [];
let selectFilters: Array<[string, string, unknown]> = [];

function nextResponse(): QueueEntry {
  return responseQueue.shift() ?? { data: null, error: null };
}

function makeSelectChain() {
  const chain: any = {
    eq(col: string, val: unknown) {
      selectFilters.push(["eq", col, val]);
      return chain;
    },
    is(col: string, val: unknown) {
      selectFilters.push(["is", col, val]);
      return chain;
    },
    lt(col: string, val: unknown) {
      selectFilters.push(["lt", col, val]);
      return chain;
    },
    gt(col: string, val: unknown) {
      selectFilters.push(["gt", col, val]);
      return chain;
    },
    order() {
      return chain;
    },
    limit() {
      return chain;
    },
    maybeSingle() {
      return Promise.resolve(nextResponse());
    },
    single() {
      return Promise.resolve(nextResponse());
    },
    then(resolve: (v: QueueEntry) => void) {
      resolve(nextResponse());
    },
  };
  return chain;
}

const fakeClient = {
  from(table: string) {
    return {
      select() {
        return makeSelectChain();
      },
      update(row: unknown) {
        // Supports both a single .eq() and a chained .eq().eq() (e.g. the
        // "still buffering"/"still processing" status guards) — the whole
        // statement is only awaited once, at the end of the chain, so `eq`
        // returns the same thenable chain instead of resolving immediately.
        const eqArgs: unknown[][] = [];
        const chain: any = {
          eq(column: string, value: unknown) {
            eqArgs.push([column, value]);
            return chain;
          },
          select() {
            return chain;
          },
          then(resolve: (v: QueueEntry) => void) {
            updates.push({ table, row, eqArgs: [...eqArgs] });
            resolve(nextResponse());
          },
        };
        return chain;
      },
      insert(row: unknown) {
        inserts.push({ table, row });
        return {
          select() {
            return {
              single() {
                return Promise.resolve(nextResponse());
              },
            };
          },
          then(resolve: (v: QueueEntry) => void) {
            resolve(nextResponse());
          },
        };
      },
    };
  },
  rpc(fn: string, args: unknown) {
    rpcCalls.push({ fn, args });
    return Promise.resolve(rpcQueue.shift() ?? { data: null, error: null });
  },
};

mock.module("@supabase/supabase-js", {
  exports: { createClient: () => fakeClient },
});

let decisionResult: {
  decision: string;
  reason: string;
  availableTools?: unknown[];
  reservationId?: string;
} = { decision: "respond", reason: "normal", availableTools: [] };
const applyTransitionCalls: unknown[][] = [];
let applyTransitionShouldThrow = false;
mock.module("./decision-engine.ts", {
  exports: {
    decide: async () => decisionResult,
    applyTransition: async (...args: unknown[]) => {
      applyTransitionCalls.push(args);
      if (applyTransitionShouldThrow) {
        throw new Error("transition failed");
      }
    },
  },
});

// Se mockea a propósito: la RPC ya la cubre conversation-actions.test.ts, y sin
// el mock cada test del setter tendría que encolar a mano la respuesta de
// append_contact_tags en rpcQueue — una cola posicional más para desincronizar.
const addTagCalls: unknown[] = [];
let addTagShouldThrow = false;
const requestHandoffCalls: unknown[] = [];
mock.module("./conversation-actions.ts", {
  exports: {
    addTagToContact: async (params: unknown) => {
      addTagCalls.push(params);
      if (addTagShouldThrow) {
        throw new Error("append_contact_tags: permission denied");
      }
      return true;
    },
    requestHandoff: async (params: unknown) => {
      requestHandoffCalls.push(params);
      return true;
    },
    ConfigError: class ConfigError extends Error {},
  },
});

const recordLlmUsageCalls: unknown[] = [];
let recordLlmUsageShouldThrow = false;
let checkRateLimitsResult: { allowed: boolean; reason?: string } = {
  allowed: true,
};
mock.module("./cost-tracker.ts", {
  exports: {
    recordLlmUsage: async (opts: unknown) => {
      recordLlmUsageCalls.push(opts);
      if (recordLlmUsageShouldThrow) {
        throw new Error("Failed to update llm_usage reservation res_1: db down");
      }
    },
    checkRateLimits: async () => checkRateLimitsResult,
  },
});

let costPolicyResult: { policy: string; reason: string; fallbackModel?: string } = {
  policy: "allow",
  reason: "within_budget",
};
mock.module("./cost-enforcer.ts", {
  exports: {
    enforceCostPolicy: async () => costPolicyResult,
    buildCostAwareSystemPrompt: async (
      _ws: string,
      base: string,
      policy: string,
    ) => (policy === "cut" ? { systemPrompt: "fallback" } : { systemPrompt: base }),
  },
});

const dispatchTemplateCalls: unknown[] = [];
let dispatchTemplateResult: {
  ok: boolean;
  error?: string;
  errorCode?: string;
} = { ok: true };
const dispatchTextCalls: unknown[] = [];
let dispatchTextResult: {
  ok: boolean;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
} = { ok: true };
mock.module("./dispatch.ts", {
  exports: {
    dispatchText: async (opts: unknown) => {
      dispatchTextCalls.push(opts);
      return dispatchTextResult;
    },
    dispatchTemplate: async (opts: unknown) => {
      dispatchTemplateCalls.push(opts);
      return dispatchTemplateResult;
    },
  },
});

let generateWithToolsResult = {
  text: "hola!",
  inputTokens: 100,
  outputTokens: 20,
};
mock.module("./openrouter.ts", {
  exports: {
    generateWithTools: async () => generateWithToolsResult,
    getWorkspaceModel: async () => "openai/gpt-4o-mini",
  },
});

mock.module("./prompt-resolver.ts", {
  exports: { resolveSystemPrompt: async () => null },
});
mock.module("./prompt-builder.ts", {
  exports: { buildSystemPrompt: (opts: { promptBase: string }) => opts.promptBase },
});
let activeAgentResult: {
  type: string;
  name: string;
  config: Record<string, unknown>;
} | null = null;
mock.module("@/features/agents/services/active-agent.ts", {
  exports: { getActiveAgent: async () => activeAgentResult },
});
mock.module("@/features/agents/services/auto-tagging.ts", {
  exports: { maybeAutoProcess: async () => {} },
});
mock.module("./business-info.ts", {
  exports: {
    getBusinessInfo: async () => null,
    buildBusinessInfoContext: () => "",
    buildNowContext: () => "",
  },
});
mock.module("./kb-service.ts", {
  exports: {
    searchKb: async () => [],
    formatKbContext: () => "",
    listKbSourceLinks: async () => [],
    formatKbReferenceLinks: () => "",
  },
});
mock.module("./conversation-history.ts", {
  exports: { getConversationHistory: async () => [] },
});
let setterConfigResult: { id: string; post_action: Record<string, unknown> } | null = null;
let evaluateLeadResult = {
  score: 0,
  qualified: false,
  knocked_out: false,
  summary: "",
  knockout_reason: undefined as string | undefined,
};
mock.module("./setter.ts", {
  exports: {
    getSetterConfig: async () => setterConfigResult,
    evaluateLead: async () => evaluateLeadResult,
  },
});
let hlOpportunityResult: { id: string } | null = null;
const hlOpportunityCalls: unknown[][] = [];
mock.module("./highlevel-client.ts", {
  exports: {
    syncContactToHL: async () => {},
    createHLOpportunity: async (...args: unknown[]) => {
      hlOpportunityCalls.push(args);
      return hlOpportunityResult;
    },
  },
});

let hubspotDealResult: { id: string } | null = null;
const hubspotDealCalls: unknown[][] = [];
mock.module("./hubspot-client.ts", {
  exports: {
    createHubSpotDeal: async (...args: unknown[]) => {
      hubspotDealCalls.push(args);
      return hubspotDealResult;
    },
  },
});

/** CRM que `crmStatus` reporta como EL activo; null = ninguno o conflicto; "error" = lectura fallida. */
let activeCrmName: "highlevel" | "hubspot" | "error" | null = null;
mock.module("./crm-sync.ts", {
  exports: {
    crmStatus: async (_ws: string, name: string) =>
      activeCrmName === "error" ? "error" : name === activeCrmName ? "active" : "inactive",
  },
});

const { upsertBatch, processNextBatch, reconcileOrphanedMessages } =
  await import("./buffer.ts");

function reset() {
  responseQueue = [];
  rpcQueue = [];
  rpcCalls = [];
  updates = [];
  inserts = [];
  selectFilters = [];
  recordLlmUsageCalls.length = 0;
  recordLlmUsageShouldThrow = false;
  checkRateLimitsResult = { allowed: true };
  dispatchTextCalls.length = 0;
  dispatchTextResult = { ok: true };
  decisionResult = { decision: "respond", reason: "normal", availableTools: [] };
  applyTransitionCalls.length = 0;
  applyTransitionShouldThrow = false;
  addTagCalls.length = 0;
  addTagShouldThrow = false;
  requestHandoffCalls.length = 0;
  dispatchTemplateCalls.length = 0;
  dispatchTemplateResult = { ok: true };
  costPolicyResult = { policy: "allow", reason: "within_budget" };
  generateWithToolsResult = { text: "hola!", inputTokens: 100, outputTokens: 20 };
  activeAgentResult = null;
  setterConfigResult = null;
  evaluateLeadResult = {
    score: 0,
    qualified: false,
    knocked_out: false,
    summary: "",
    knockout_reason: undefined,
  };
}

// ── upsertBatch ─────────────────────────────────────────────────────────

test("upsertBatch calls the atomic upsert_batch_and_link_message RPC with the right args and returns its batch id", async () => {
  reset();
  rpcQueue = [{ data: "batch_1", error: null }];
  const batchId = await upsertBatch({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    messageId: "msg_1",
  });
  assert.equal(batchId, "batch_1");
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].fn, "upsert_batch_and_link_message");
  assert.deepEqual(rpcCalls[0].args, {
    p_workspace_id: "ws_1",
    p_conversation_id: "conv_1",
    p_message_id: "msg_1",
    p_silence_ms: 30_000,
    p_force_new_batch: false,
  });
});

test("upsertBatch passes a custom silenceMs through to the RPC", async () => {
  reset();
  rpcQueue = [{ data: "batch_2", error: null }];
  await upsertBatch({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    messageId: "msg_2",
    silenceMs: 3000,
  });
  assert.equal(
    (rpcCalls[0].args as { p_silence_ms: number }).p_silence_ms,
    3000,
  );
});

test("upsertBatch passes forceNewBatch through to the RPC, defaulting to false", async () => {
  reset();
  rpcQueue = [{ data: "batch_forced", error: null }];
  await upsertBatch({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    messageId: "msg_forced",
    forceNewBatch: true,
  });
  assert.equal(
    (rpcCalls[0].args as { p_force_new_batch: boolean }).p_force_new_batch,
    true,
  );
});

test("upsertBatch throws after exhausting retries when the RPC keeps erroring", async () => {
  reset();
  rpcQueue = [
    { data: null, error: { message: "db down" } },
    { data: null, error: { message: "db down" } },
    { data: null, error: { message: "db down" } },
  ];
  await assert.rejects(
    () =>
      upsertBatch(
        { workspaceId: "ws_1", conversationId: "conv_1", messageId: "msg_1" },
        { delayMs: 0, sleep: async () => {} },
      ),
    /Failed to upsert batch/,
  );
  assert.equal(rpcCalls.length, 3);
});

test("upsertBatch retries the RPC and succeeds on a later attempt — a transient blip must not orphan the message", async () => {
  reset();
  rpcQueue = [
    { data: null, error: { message: "transient blip" } },
    { data: "batch_3", error: null },
  ];
  const batchId = await upsertBatch(
    { workspaceId: "ws_1", conversationId: "conv_1", messageId: "msg_1" },
    { delayMs: 0, sleep: async () => {} },
  );
  assert.equal(batchId, "batch_3");
  assert.equal(rpcCalls.length, 2);
});

// ── reconcileOrphanedMessages ───────────────────────────────────────────

test("reconcileOrphanedMessages relinks orphaned messages via upsertBatch and returns the recovered count", async () => {
  reset();
  responseQueue = [
    {
      data: [
        {
          id: "msg_orphan_1",
          workspace_id: "ws_1",
          conversation_id: "conv_1",
          conversations: { ai_enabled: true, contact_id: "contact_1" },
        },
        {
          id: "msg_orphan_2",
          workspace_id: "ws_1",
          conversation_id: "conv_2",
          conversations: { ai_enabled: true, contact_id: "contact_2" },
        },
      ],
      error: null,
    },
  ];
  rpcQueue = [
    { data: "batch_1", error: null },
    { data: "batch_2", error: null },
  ];
  const { recovered } = await reconcileOrphanedMessages({
    delayMs: 0,
    sleep: async () => {},
  });
  assert.equal(recovered, 2);
  assert.equal(rpcCalls.length, 2);
  assert.equal(
    (rpcCalls[0].args as { p_message_id: string }).p_message_id,
    "msg_orphan_1",
  );
});

test("reconcileOrphanedMessages recovers a message with silenceMs=0 and forceNewBatch=true so it never joins — or gets joined by — an unrelated in-flight batch", async () => {
  // Contract-level test: verifies the JS→RPC call, not the SQL invariant
  // itself (that lives in the migration, exercised against real Postgres —
  // see 20260825000000_isolate_reconciled_orphan_batches.sql). silenceMs=0
  // alone was tried first and failed an adversarial audit: the RPC matched
  // "any buffering batch" regardless of flush_at/origin, so a same-second
  // real message could still merge with (or absorb) the reconciled orphan.
  // forceNewBatch=true is what actually closes that — it skips the "join an
  // existing batch" lookup entirely on the SQL side.
  reset();
  responseQueue = [
    {
      data: [
        {
          id: "msg_orphan_1",
          workspace_id: "ws_1",
          conversation_id: "conv_1",
          conversations: { ai_enabled: true, contact_id: "contact_1" },
        },
      ],
      error: null,
    },
  ];
  rpcQueue = [{ data: "batch_1", error: null }];
  await reconcileOrphanedMessages({ delayMs: 0, sleep: async () => {} });
  assert.equal(
    (rpcCalls[0].args as { p_silence_ms: number }).p_silence_ms,
    0,
  );
  assert.equal(
    (rpcCalls[0].args as { p_force_new_batch: boolean }).p_force_new_batch,
    true,
  );
});

test("reconcileOrphanedMessages only looks 15 minutes back and lets the DB drop AI-off conversations", async () => {
  reset();
  const before = Date.now();
  responseQueue = [{ data: [], error: null }]; // lookup → nothing
  await reconcileOrphanedMessages({ attempts: 1, delayMs: 0, sleep: async () => {} });

  const lower = selectFilters.find(([op, col]) => op === "gt" && col === "created_at");
  assert.ok(lower, "expected a lower bound on created_at");
  const lowerMs = new Date(lower![2] as string).getTime();
  assert.ok(
    Math.abs(before - 15 * 60_000 - lowerMs) < 5_000,
    `lower bound ≈ now-15min, got ${lower![2]}`,
  );

  const upper = selectFilters.find(([op, col]) => op === "lt" && col === "created_at");
  assert.ok(upper, "the 2-minute upper bound must stay");

  assert.ok(
    selectFilters.some(
      ([op, col, val]) =>
        op === "eq" && col === "conversations.ai_enabled" && val === true,
    ),
    "ai_enabled must be filtered server-side via the inner join",
  );
});

test("reconcileOrphanedMessages counts only the messages it actually recovers, skipping ones that still fail", async () => {
  reset();
  responseQueue = [
    {
      data: [
        {
          id: "msg_orphan_1",
          workspace_id: "ws_1",
          conversation_id: "conv_1",
          conversations: { ai_enabled: true, contact_id: "contact_1" },
        },
        {
          id: "msg_orphan_2",
          workspace_id: "ws_1",
          conversation_id: "conv_2",
          conversations: { ai_enabled: true, contact_id: "contact_2" },
        },
      ],
      error: null,
    },
  ];
  rpcQueue = [
    { data: "batch_1", error: null },
    { data: null, error: { message: "still failing" } },
    { data: null, error: { message: "still failing" } },
    { data: null, error: { message: "still failing" } },
  ];
  const { recovered } = await reconcileOrphanedMessages({
    delayMs: 0,
    sleep: async () => {},
  });
  assert.equal(recovered, 1);
});

test("a failing lookup is a PHASE failure — recovered 0 plus a code, never a bare 0", async () => {
  reset();
  responseQueue = [{ data: null, error: { message: "db down" } }];
  const errorLogs: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errorLogs.push(args);
  };
  try {
    const result = await reconcileOrphanedMessages({
      delayMs: 0,
      sleep: async () => {},
    });
    // Without the code, a broken lookup reads exactly like "there were no
    // orphans" and the tick answers 200 {ok:true} forever.
    assert.deepEqual(result, { recovered: 0, error: "reconcile_failed" });
    assert.ok(errorLogs.length > 0);
    // The PostgREST text stays in the log, never in the returned code.
    assert.ok(!JSON.stringify(result).includes("db down"));
  } finally {
    console.error = originalError;
  }
});

test("reconcileOrphanedMessages skips a message whose conversation currently has ai_enabled=false, without calling upsertBatch", async () => {
  reset();
  responseQueue = [
    {
      data: [
        {
          id: "msg_orphan_1",
          workspace_id: "ws_1",
          conversation_id: "conv_1",
          conversations: { ai_enabled: false, contact_id: "contact_1" },
        },
      ],
      error: null,
    },
  ];
  const { recovered } = await reconcileOrphanedMessages({
    delayMs: 0,
    sleep: async () => {},
  });
  assert.equal(recovered, 0);
  assert.equal(rpcCalls.length, 0);
});

test("reconcileOrphanedMessages skips a message whose contact is currently rate-limited, without calling upsertBatch", async () => {
  reset();
  responseQueue = [
    {
      data: [
        {
          id: "msg_orphan_1",
          workspace_id: "ws_1",
          conversation_id: "conv_1",
          conversations: { ai_enabled: true, contact_id: "contact_1" },
        },
      ],
      error: null,
    },
  ];
  checkRateLimitsResult = { allowed: false, reason: "hourly_cap" };
  const { recovered } = await reconcileOrphanedMessages({
    delayMs: 0,
    sleep: async () => {},
  });
  assert.equal(recovered, 0);
  assert.equal(rpcCalls.length, 0);
});

// ── processNextBatch ────────────────────────────────────────────────────

test("a failing claim_next_batch is flagged as a PHASE failure, not as one more failed batch", async () => {
  reset();
  rpcQueue = [{ data: null, error: { message: "db down" } }];
  const result = await processNextBatch();
  assert.deepEqual(result, {
    processed: false,
    error: "db down",
    phaseError: "claim_failed",
  });
});

test("processNextBatch returns not-processed when there is no batch ready", async () => {
  reset();
  rpcQueue = [{ data: [], error: null }];
  const result = await processNextBatch();
  assert.deepEqual(result, { processed: false });
});

test("processNextBatch does not respond and marks the batch processed when decide() abstains", async () => {
  reset();
  decisionResult = { decision: "abstain", reason: "state:paused" };
  rpcQueue = [
    {
      data: [
        {
          id: "batch_1",
          workspace_id: "ws_1",
          conversation_id: "conv_1",
          status: "processing",
          meta: {},
        },
      ],
      error: null,
    },
  ];
  responseQueue = [
    { data: [], error: null }, // consolidateBatch messages
    { data: { id: "conv_1", workspace_id: "ws_1", contact_id: "contact_1", ai_enabled: true }, error: null },
    { error: null }, // markBatchProcessed update
  ];
  const result = await processNextBatch();
  assert.deepEqual(result, { processed: true, conversationId: "conv_1" });
  assert.equal(dispatchTextCalls.length, 0);
});

test("processNextBatch escalates to a human (handoff_pending) when the cost policy cuts, without calling the LLM", async () => {
  reset();
  costPolicyResult = { policy: "cut", reason: "daily_hard_limit" };
  rpcQueue = [
    {
      data: [
        {
          id: "batch_1",
          workspace_id: "ws_1",
          conversation_id: "conv_1",
          status: "processing",
          meta: {},
        },
      ],
      error: null,
    },
  ];
  responseQueue = [
    { data: [], error: null },
    { data: { id: "conv_1", workspace_id: "ws_1", contact_id: "contact_1", ai_enabled: true }, error: null },
    { data: null, error: null }, // kapso integration config lookup (maybeSingle)
    { error: null }, // markBatchProcessed update
  ];
  const result = await processNextBatch();
  assert.deepEqual(result, { processed: true, conversationId: "conv_1" });
  assert.equal(dispatchTextCalls.length, 0, "no LLM reply and no fallback spam");
  assert.deepEqual(applyTransitionCalls, [
    ["conv_1", "handoff_pending", { trigger: "cost_cut", workspaceId: "ws_1" }],
  ]);
});

test("processNextBatch still marks the batch processed when the cost-cut handoff transition throws", async () => {
  reset();
  costPolicyResult = { policy: "cut", reason: "daily_hard_limit" };
  applyTransitionShouldThrow = true;
  rpcQueue = [
    {
      data: [
        {
          id: "batch_1",
          workspace_id: "ws_1",
          conversation_id: "conv_1",
          status: "processing",
          meta: {},
        },
      ],
      error: null,
    },
  ];
  responseQueue = [
    { data: [], error: null },
    { data: { id: "conv_1", workspace_id: "ws_1", contact_id: "contact_1", ai_enabled: true }, error: null },
    { data: null, error: null }, // kapso integration config lookup (maybeSingle)
    { error: null }, // markBatchProcessed update
  ];
  const result = await processNextBatch();
  assert.deepEqual(result, { processed: true, conversationId: "conv_1" });
  assert.equal(dispatchTextCalls.length, 0, "still nothing sent to the contact");
  assert.ok(
    updates.some(
      (u) =>
        u.table === "message_batches" &&
        (u.row as { status?: string }).status === "processed",
    ),
    "the batch is closed even though the transition failed",
  );
});

test("processNextBatch dispatches the reply and passes the reservationId through to recordLlmUsage", async () => {
  reset();
  decisionResult = {
    decision: "respond",
    reason: "normal",
    availableTools: [],
    reservationId: "res_1",
  };
  rpcQueue = [
    {
      data: [
        {
          id: "batch_1",
          workspace_id: "ws_1",
          conversation_id: "conv_1",
          status: "processing",
          meta: {},
        },
      ],
      error: null,
    },
  ];
  responseQueue = [
    { data: [], error: null }, // consolidateBatch
    { data: { id: "conv_1", workspace_id: "ws_1", contact_id: "contact_1", ai_enabled: true }, error: null },
    { data: null, error: null }, // kapso config lookup
    { data: { credentials: {}, config: {} }, error: null }, // kapso integration (dispatch)
    { data: { state: "ai_active" }, error: null }, // live state re-check before dispatch
    { error: null }, // markBatchProcessed
  ];
  const result = await processNextBatch();
  assert.deepEqual(result, { processed: true, conversationId: "conv_1" });
  assert.equal(dispatchTextCalls.length, 1);
  assert.equal(recordLlmUsageCalls.length, 1);
  assert.equal((recordLlmUsageCalls[0] as { reservationId?: string }).reservationId, "res_1");
});

// Shared fixture for the dispatch-failure tests: one claimed batch, happy
// path up to the dispatch call. Same queue order as the test above.
function primeHappyPathUntilDispatch() {
  reset();
  decisionResult = {
    decision: "respond",
    reason: "normal",
    availableTools: [],
    reservationId: "res_1",
  };
  rpcQueue = [
    {
      data: [
        {
          id: "batch_1",
          workspace_id: "ws_1",
          conversation_id: "conv_1",
          status: "processing",
          meta: {},
        },
      ],
      error: null,
    },
  ];
  responseQueue = [
    { data: [], error: null }, // consolidateBatch
    { data: { id: "conv_1", workspace_id: "ws_1", contact_id: "contact_1", ai_enabled: true }, error: null },
    { data: null, error: null }, // kapso config lookup
    { data: { credentials: {}, config: {} }, error: null }, // kapso integration
    { data: { state: "ai_active" }, error: null }, // live state re-check before dispatch
    { error: null }, // markBatchProcessed OR retry update
  ];
}

test("processNextBatch re-queues the batch with a retry when Kapso fails with a retryable error", async () => {
  primeHappyPathUntilDispatch();
  dispatchTextResult = {
    ok: false,
    error: "Espera un momento",
    errorCode: "SEND_FAILED",
    retryable: true,
  };
  const result = await processNextBatch();
  assert.equal(result.processed, false);
  assert.match(result.error ?? "", /retryable/);
  const requeue = updates.find(
    (u) => u.table === "message_batches" && (u.row as { status?: string }).status === "buffering",
  );
  assert.ok(requeue, "batch must go back to buffering");
  assert.equal((requeue!.row as { meta: { retry_count: number } }).meta.retry_count, 1);
  assert.ok(
    !updates.some((u) => (u.row as { status?: string }).status === "processed"),
    "must not be marked processed",
  );
});

test("processNextBatch marks the batch processed when the send failure is permanent (message already failed in the inbox)", async () => {
  primeHappyPathUntilDispatch();
  dispatchTextResult = {
    ok: false,
    error: "Número inválido",
    errorCode: "SEND_FAILED",
    retryable: false,
  };
  const result = await processNextBatch();
  assert.deepEqual(result, { processed: true, conversationId: "conv_1" });
  assert.ok(updates.some((u) => (u.row as { status?: string }).status === "processed"));
});

test("processNextBatch treats an empty LLM reply as a batch error (retry) instead of sending an empty message", async () => {
  primeHappyPathUntilDispatch();
  generateWithToolsResult = { text: "   ", inputTokens: 10, outputTokens: 0 };
  const result = await processNextBatch();
  assert.equal(result.processed, false);
  assert.match(result.error ?? "", /empty reply/);
  assert.equal(dispatchTextCalls.length, 0);
  generateWithToolsResult = { text: "hola!", inputTokens: 100, outputTokens: 20 };
});

test("processNextBatch records the tokens of an empty LLM reply before failing the batch", async () => {
  primeHappyPathUntilDispatch();
  generateWithToolsResult = { text: "", inputTokens: 37, outputTokens: 5 };
  const result = await processNextBatch();
  // The call was made and paid for: it must count against the daily budget
  // even though the batch fails and will be retried.
  assert.equal(recordLlmUsageCalls.length, 1);
  const usage = recordLlmUsageCalls[0] as { promptTokens: number; completionTokens: number; reservationId?: string };
  assert.equal(usage.promptTokens, 37);
  assert.equal(usage.completionTokens, 5);
  assert.equal(usage.reservationId, "res_1");
  assert.equal(result.processed, false);
  assert.match(result.error ?? "", /empty reply/);
  assert.equal(dispatchTextCalls.length, 0);
  generateWithToolsResult = { text: "hola!", inputTokens: 100, outputTokens: 20 };
});

test("processNextBatch still fails an empty LLM reply as before when recording its usage throws", async () => {
  primeHappyPathUntilDispatch();
  recordLlmUsageShouldThrow = true;
  generateWithToolsResult = { text: "", inputTokens: 37, outputTokens: 5 };
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await processNextBatch();
    assert.equal(recordLlmUsageCalls.length, 1);
    assert.equal(result.processed, false);
    assert.match(result.error ?? "", /empty reply/);
    assert.equal(dispatchTextCalls.length, 0);
  } finally {
    console.error = originalError;
    generateWithToolsResult = { text: "hola!", inputTokens: 100, outputTokens: 20 };
  }
});

test("processNextBatch skips the dispatch when a human took the thread while the LLM was generating", async () => {
  primeHappyPathUntilDispatch();
  // Replace the re-check entry primed by the helper: the thread is now human_active.
  const idx = responseQueue.findIndex((e) => (e.data as { state?: string } | null)?.state === "ai_active");
  responseQueue[idx] = { data: { state: "human_active" }, error: null };
  const result = await processNextBatch();
  assert.deepEqual(result, { processed: true, conversationId: "conv_1" });
  assert.equal(dispatchTextCalls.length, 0);
  assert.ok(
    updates.some(
      (u) => u.table === "message_batches" && (u.row as { status?: string }).status === "processed",
    ),
  );
});

test("processNextBatch dispatches anyway (fail-open) and logs when the live state re-check errors", async () => {
  primeHappyPathUntilDispatch();
  // Replace the re-check entry primed by the helper: the read itself fails.
  const idx = responseQueue.findIndex((e) => (e.data as { state?: string } | null)?.state === "ai_active");
  responseQueue[idx] = { data: null, error: { message: "boom" } };
  const errorLogs: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errorLogs.push(args);
  };
  try {
    const result = await processNextBatch();
    assert.deepEqual(result, { processed: true, conversationId: "conv_1" });
    assert.equal(dispatchTextCalls.length, 1, "a transient read blip must not silence the bot");
    assert.ok(
      errorLogs.some((args) => String(args[0]).includes("live state re-check failed")),
      "the degraded guard must be visible in the logs",
    );
  } finally {
    console.error = originalError;
  }
});

test("processNextBatch dispatches the reply and marks the batch processed even when recordLlmUsage throws after exhausting its retries", async () => {
  reset();
  recordLlmUsageShouldThrow = true;
  rpcQueue = [
    {
      data: [
        {
          id: "batch_1",
          workspace_id: "ws_1",
          conversation_id: "conv_1",
          status: "processing",
          meta: {},
        },
      ],
      error: null,
    },
  ];
  responseQueue = [
    { data: [], error: null }, // consolidateBatch
    {
      data: { id: "conv_1", workspace_id: "ws_1", contact_id: "contact_1", ai_enabled: true },
      error: null,
    },
    { data: null, error: null }, // kapso config lookup
    { data: { credentials: {}, config: {} }, error: null }, // kapso integration (dispatch)
    { data: { state: "ai_active" }, error: null }, // live state re-check before dispatch
    { error: null }, // markBatchProcessed
  ];
  const errorLogs: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errorLogs.push(args);
  };
  try {
    const result = await processNextBatch();
    assert.deepEqual(result, { processed: true, conversationId: "conv_1" });
    assert.equal(dispatchTextCalls.length, 1);
    assert.equal(recordLlmUsageCalls.length, 1);
    const requeued = updates.find(
      (u) =>
        u.table === "message_batches" &&
        (u.row as { status?: string }).status === "buffering",
    );
    assert.equal(requeued, undefined);
    assert.ok(
      errorLogs.some((args) => String(args[0]).includes("recordLlmUsage failed")),
    );
  } finally {
    console.error = originalError;
  }
});

test("processNextBatch requeues with backoff on error, incrementing retry_count", async () => {
  reset();
  rpcQueue = [
    {
      data: [
        {
          id: "batch_1",
          workspace_id: "ws_1",
          conversation_id: "conv_1",
          status: "processing",
          meta: { retry_count: 0 },
        },
      ],
      error: null,
    },
  ];
  responseQueue = [
    { data: [], error: null }, // consolidateBatch
    { data: null, error: { message: "conv lookup failed" } }, // conversation lookup fails
    { error: null }, // requeue update
  ];
  const result = await processNextBatch();
  assert.equal(result.processed, false);
  assert.match(result.error ?? "", /Conversation not found/);
  const requeue = updates.find((u) => u.table === "message_batches");
  assert.ok(requeue);
  assert.equal((requeue!.row as { status: string; meta: { retry_count: number } }).status, "buffering");
  assert.equal((requeue!.row as { meta: { retry_count: number } }).meta.retry_count, 1);
});

test("processNextBatch dead-letters the batch after MAX_BATCH_RETRIES", async () => {
  reset();
  rpcQueue = [
    {
      data: [
        {
          id: "batch_1",
          workspace_id: "ws_1",
          conversation_id: "conv_1",
          status: "processing",
          meta: { retry_count: 3 },
        },
      ],
      error: null,
    },
  ];
  responseQueue = [
    { data: [], error: null },
    { data: null, error: { message: "conv lookup failed" } },
    { error: null }, // unused (cancel_batch goes through the rpc queue below)
    { error: null }, // batch_dead_letter insert
  ];
  rpcQueue.push({ data: null, error: null }); // cancel_batch RPC
  const result = await processNextBatch();
  assert.equal(result.processed, false);
  assert.match(result.error ?? "", /cancelled after 3 retries/);
});

// ── setter evaluation (runSetterEvaluation / executeSetterPostAction) ─────

test("processNextBatch runs the setter evaluation and tags the contact as qualified", async () => {
  reset();
  activeAgentResult = { type: "setter", name: "Setter", config: {} };
  setterConfigResult = { id: "cfg_1", post_action: { type: "add_tag", tag: "caliente" } };
  evaluateLeadResult = {
    score: 90,
    qualified: true,
    knocked_out: false,
    summary: "Interesado",
    knockout_reason: undefined,
  };
  rpcQueue = [
    {
      data: [
        { id: "batch_1", workspace_id: "ws_1", conversation_id: "conv_1", status: "processing", meta: {} },
      ],
      error: null,
    },
  ];
  responseQueue = [
    { data: [], error: null }, // consolidateBatch
    { data: { id: "conv_1", workspace_id: "ws_1", contact_id: "contact_1", ai_enabled: true }, error: null },
    { data: null, error: null }, // kapso config lookup
    { data: { credentials: {}, config: {} }, error: null }, // kapso integration
    { data: { state: "ai_active" }, error: null }, // live state re-check before dispatch
    { error: null }, // markBatchProcessed
    { data: { tags: [], custom_fields: {}, stage: "lead" }, error: null }, // contact lookup (setter)
    { error: null }, // contacts update (tags/stage)
    { error: null }, // setter_evaluation event insert
  ];
  const result = await processNextBatch();
  assert.deepEqual(result, { processed: true, conversationId: "conv_1" });
  const contactsUpdates = updates.filter((u) => u.table === "contacts");
  assert.equal(
    contactsUpdates.length,
    1,
    "la etiqueta la escribe la RPC; el único update de contacts es el de stage",
  );
  assert.deepEqual(addTagCalls, [
    { workspaceId: "ws_1", contactId: "contact_1", tag: "caliente" },
  ]);
});

test("processNextBatch's setter evaluation is dormant when no setter config exists", async () => {
  reset();
  activeAgentResult = { type: "setter", name: "Setter", config: {} };
  setterConfigResult = null;
  rpcQueue = [
    {
      data: [
        { id: "batch_1", workspace_id: "ws_1", conversation_id: "conv_1", status: "processing", meta: {} },
      ],
      error: null,
    },
  ];
  responseQueue = [
    { data: [], error: null },
    { data: { id: "conv_1", workspace_id: "ws_1", contact_id: "contact_1", ai_enabled: true }, error: null },
    { data: null, error: null },
    { data: { credentials: {}, config: {} }, error: null },
    { data: { state: "ai_active" }, error: null }, // live state re-check before dispatch
    { error: null },
  ];
  const result = await processNextBatch();
  assert.deepEqual(result, { processed: true, conversationId: "conv_1" });
  assert.equal(updates.filter((u) => u.table === "contacts").length, 0);
});

test("processNextBatch's setter evaluation logs an error event and does not throw the batch when it fails", async () => {
  reset();
  activeAgentResult = { type: "setter", name: "Setter", config: {} };
  setterConfigResult = { id: "cfg_1", post_action: { type: "add_tag", tag: "caliente" } };
  rpcQueue = [
    {
      data: [
        { id: "batch_1", workspace_id: "ws_1", conversation_id: "conv_1", status: "processing", meta: {} },
      ],
      error: null,
    },
  ];
  responseQueue = [
    { data: [], error: null },
    { data: { id: "conv_1", workspace_id: "ws_1", contact_id: "contact_1", ai_enabled: true }, error: null },
    { data: null, error: null },
    { data: { credentials: {}, config: {} }, error: null },
    { data: { state: "ai_active" }, error: null }, // live state re-check before dispatch
    { error: null }, // markBatchProcessed
    { data: null, error: { message: "contact lookup failed" } }, // contact lookup fails inside try
  ];
  const result = await processNextBatch();
  assert.deepEqual(result, { processed: true, conversationId: "conv_1" });
  const errorEvents = inserts.filter(
    (i) =>
      i.table === "events" &&
      (i.row as { type: string }).type === "setter_evaluation" &&
      (i.row as { level: string }).level === "error",
  );
  assert.equal(errorEvents.length, 1);
});

test("el post_action handoff delega en requestHandoff, con el workspace acotado", async () => {
  reset();
  activeAgentResult = { type: "setter", name: "Setter", config: {} };
  setterConfigResult = { id: "cfg_1", post_action: { type: "handoff" } };
  evaluateLeadResult = {
    score: 90,
    qualified: true,
    knocked_out: false,
    summary: "Interesado",
    knockout_reason: undefined,
  };
  rpcQueue = [
    {
      data: [
        { id: "batch_1", workspace_id: "ws_1", conversation_id: "conv_1", status: "processing", meta: {} },
      ],
      error: null,
    },
  ];
  responseQueue = [
    { data: [], error: null }, // consolidateBatch
    { data: { id: "conv_1", workspace_id: "ws_1", contact_id: "contact_1", ai_enabled: true }, error: null },
    { data: null, error: null }, // kapso config lookup
    { data: { credentials: {}, config: {} }, error: null }, // kapso integration
    { data: { state: "ai_active" }, error: null }, // live state re-check
    { error: null }, // markBatchProcessed
    { data: { tags: [], custom_fields: {}, stage: "lead" }, error: null }, // contact lookup
    { error: null }, // contacts update (stage/custom_fields)
    { error: null }, // setter_evaluation event insert
  ];
  await processNextBatch();
  assert.deepEqual(requestHandoffCalls, [
    { workspaceId: "ws_1", conversationId: "conv_1", reason: "agent" },
  ]);
  // El UPDATE de conversations lo hace applyTransition dentro de
  // requestHandoff, nunca este archivo.
  assert.equal(updates.filter((u) => u.table === "conversations").length, 0);
});

test("un add_tag que LANZA no tumba el batch ya procesado, y deja rastro en la línea de tiempo", async () => {
  reset();
  addTagShouldThrow = true;
  activeAgentResult = { type: "setter", name: "Setter", config: {} };
  setterConfigResult = { id: "cfg_1", post_action: { type: "add_tag", tag: "caliente" } };
  evaluateLeadResult = {
    score: 90,
    qualified: true,
    knocked_out: false,
    summary: "Interesado",
    knockout_reason: undefined,
  };
  rpcQueue = [
    {
      data: [
        { id: "batch_1", workspace_id: "ws_1", conversation_id: "conv_1", status: "processing", meta: {} },
      ],
      error: null,
    },
  ];
  responseQueue = [
    { data: [], error: null },
    { data: { id: "conv_1", workspace_id: "ws_1", contact_id: "contact_1", ai_enabled: true }, error: null },
    { data: null, error: null },
    { data: { credentials: {}, config: {} }, error: null },
    { data: { state: "ai_active" }, error: null },
    { error: null }, // markBatchProcessed
    { data: { tags: [], custom_fields: {}, stage: "lead" }, error: null },
    { error: null }, // contacts update
    { error: null }, // setter_evaluation event insert
    { error: null }, // setter_evaluation event insert (nivel error, del catch)
  ];
  const result = await processNextBatch();
  assert.deepEqual(result, { processed: true, conversationId: "conv_1" });
  // Si se borra el `throw` de arriba (addTagShouldThrow = false), esta
  // aserción debe caer: sin ella el test quedaba verde lance o no lance.
  const failures = inserts.filter(
    (i) =>
      i.table === "events" &&
      (i.row as { type: string }).type === "setter_post_action_failed",
  );
  assert.equal(
    failures.length,
    1,
    "un add_tag que lanza no debe quedar sin rastro en la línea de tiempo",
  );
  const failure = failures[0].row as {
    level: string;
    payload: Record<string, unknown>;
  };
  assert.equal(failure.level, "warn");
  assert.equal(failure.payload.action, "add_tag");
});

test("un send_template fallido deja rastro en la línea de tiempo", async () => {
  reset();
  dispatchTemplateResult = {
    ok: false,
    error: "La ventana de 24 horas está cerrada",
    errorCode: "WINDOW_EXPIRED",
  };
  activeAgentResult = { type: "setter", name: "Setter", config: {} };
  setterConfigResult = {
    id: "cfg_1",
    post_action: { type: "send_template", template_name: "seguimiento" },
  };
  evaluateLeadResult = {
    score: 90,
    qualified: true,
    knocked_out: false,
    summary: "Interesado",
    knockout_reason: undefined,
  };
  rpcQueue = [
    {
      data: [
        { id: "batch_1", workspace_id: "ws_1", conversation_id: "conv_1", status: "processing", meta: {} },
      ],
      error: null,
    },
  ];
  responseQueue = [
    { data: [], error: null },
    { data: { id: "conv_1", workspace_id: "ws_1", contact_id: "contact_1", ai_enabled: true }, error: null },
    { data: null, error: null },
    { data: { credentials: {}, config: {} }, error: null },
    { data: { state: "ai_active" }, error: null },
    { error: null }, // markBatchProcessed
    { data: { tags: [], custom_fields: {}, stage: "lead" }, error: null },
    { error: null }, // contacts update
    { error: null }, // setter_evaluation event insert
    { error: null }, // setter_post_action_failed insert
  ];
  await processNextBatch();
  const failures = inserts.filter(
    (i) =>
      i.table === "events" &&
      (i.row as { type: string }).type === "setter_post_action_failed",
  );
  assert.equal(failures.length, 1, "ignorar el resultado dejaba el fallo invisible");
  const payload = (failures[0].row as { payload: Record<string, unknown> }).payload;
  assert.equal(payload.action, "send_template");
  assert.equal(payload.reason, "La ventana de 24 horas está cerrada");
});

test("un send_template exitoso NO escribe ningún evento de fallo", async () => {
  reset();
  activeAgentResult = { type: "setter", name: "Setter", config: {} };
  setterConfigResult = {
    id: "cfg_1",
    post_action: { type: "send_template", template_name: "seguimiento" },
  };
  evaluateLeadResult = {
    score: 90,
    qualified: true,
    knocked_out: false,
    summary: "Interesado",
    knockout_reason: undefined,
  };
  rpcQueue = [
    {
      data: [
        { id: "batch_1", workspace_id: "ws_1", conversation_id: "conv_1", status: "processing", meta: {} },
      ],
      error: null,
    },
  ];
  responseQueue = [
    { data: [], error: null },
    { data: { id: "conv_1", workspace_id: "ws_1", contact_id: "contact_1", ai_enabled: true }, error: null },
    { data: null, error: null },
    { data: { credentials: {}, config: {} }, error: null },
    { data: { state: "ai_active" }, error: null },
    { error: null }, // markBatchProcessed
    { data: { tags: [], custom_fields: {}, stage: "lead" }, error: null },
    { error: null }, // contacts update
    { error: null }, // setter_evaluation event insert
  ];
  await processNextBatch();
  assert.equal(dispatchTemplateCalls.length, 1);
  assert.equal(
    inserts.filter(
      (i) =>
        i.table === "events" &&
        (i.row as { type: string }).type === "setter_post_action_failed",
    ).length,
    0,
  );
});

// ── Acciones de CRM del setter: cada una actúa solo si su CRM es EL activo ──

function qualifiedSetterRun(postAction: Record<string, unknown>) {
  activeAgentResult = { type: "setter", name: "Setter", config: {} };
  setterConfigResult = { id: "cfg_1", post_action: postAction };
  evaluateLeadResult = { score: 90, qualified: true, knocked_out: false, summary: "Interesado", knockout_reason: undefined };
  rpcQueue = [
    { data: [{ id: "batch_1", workspace_id: "ws_1", conversation_id: "conv_1", status: "processing", meta: {} }], error: null },
  ];
  responseQueue = [
    { data: [], error: null },
    { data: { id: "conv_1", workspace_id: "ws_1", contact_id: "contact_1", ai_enabled: true }, error: null },
    { data: null, error: null },
    { data: { credentials: {}, config: {} }, error: null },
    { data: { state: "ai_active" }, error: null },
    { error: null }, // markBatchProcessed
    { data: { tags: [], custom_fields: {}, stage: "lead" }, error: null },
    { error: null }, // contacts update
    { error: null }, // setter_evaluation
    { error: null }, // setter_post_action(_failed)
  ];
}

function setterEvents(type: string): Array<Record<string, unknown>> {
  return inserts
    .filter((i) => i.table === "events" && (i.row as { type: string }).type === type)
    .map((i) => (i.row as { payload: Record<string, unknown> }).payload);
}

function resetCrmMocks() {
  hubspotDealCalls.length = 0;
  hlOpportunityCalls.length = 0;
  hubspotDealResult = null;
  hlOpportunityResult = null;
}

test("create_hubspot_deal con HubSpot activo crea el negocio y deja el evento de éxito", async () => {
  reset();
  resetCrmMocks();
  activeCrmName = "hubspot";
  hubspotDealResult = { id: "deal_1" };
  qualifiedSetterRun({ type: "create_hubspot_deal" });
  await processNextBatch();
  assert.deepEqual(hubspotDealCalls, [["ws_1", "contact_1"]]);
  assert.deepEqual(setterEvents("setter_post_action"), [{ action: "create_hubspot_deal", contact_id: "contact_1", deal_id: "deal_1" }]);
});

test("un create_hubspot_deal fallido deja el motivo para el operador", async () => {
  reset();
  resetCrmMocks();
  activeCrmName = "hubspot";
  qualifiedSetterRun({ type: "create_hubspot_deal" });
  await processNextBatch();
  assert.deepEqual(setterEvents("setter_post_action_failed"), [
    { action: "create_hubspot_deal", contact_id: "contact_1", reason: "no se pudo crear el negocio (revisa el token, el pipeline y la etapa de HubSpot)" },
  ]);
});

test("create_hubspot_deal sin HubSpot como CRM activo (HighLevel activo o conflicto) no llama a HubSpot", async () => {
  for (const active of ["highlevel", null] as const) {
    reset();
    resetCrmMocks();
    activeCrmName = active;
    qualifiedSetterRun({ type: "create_hubspot_deal" });
    await processNextBatch();
    assert.equal(hubspotDealCalls.length, 0);
    assert.deepEqual(setterEvents("setter_post_action_failed"), [
      { action: "create_hubspot_deal", contact_id: "contact_1", reason: "HubSpot no es el CRM activo de este espacio de trabajo" },
    ]);
  }
});

test("create_hl_opportunity sin HighLevel como CRM activo no llama a HighLevel", async () => {
  for (const active of ["hubspot", null] as const) {
    reset();
    resetCrmMocks();
    activeCrmName = active;
    qualifiedSetterRun({ type: "create_hl_opportunity" });
    await processNextBatch();
    assert.equal(hlOpportunityCalls.length, 0);
    assert.deepEqual(setterEvents("setter_post_action_failed"), [
      { action: "create_hl_opportunity", contact_id: "contact_1", reason: "HighLevel no es el CRM activo de este espacio de trabajo" },
    ]);
  }
});

test("si no se pudo leer el CRM activo, ni el negocio ni la oportunidad se crean y el motivo lo dice", async () => {
  for (const action of ["create_hubspot_deal", "create_hl_opportunity"] as const) {
    reset();
    resetCrmMocks();
    activeCrmName = "error";
    qualifiedSetterRun({ type: action });
    await processNextBatch();
    assert.equal(hubspotDealCalls.length + hlOpportunityCalls.length, 0);
    assert.deepEqual(setterEvents("setter_post_action_failed"), [
      { action, contact_id: "contact_1", reason: "no se pudo verificar cuál es el CRM activo (falló la lectura de la base)" },
    ]);
  }
});

test("create_hl_opportunity con HighLevel activo sigue funcionando como antes", async () => {
  reset();
  resetCrmMocks();
  activeCrmName = "highlevel";
  hlOpportunityResult = { id: "opp_1" };
  qualifiedSetterRun({ type: "create_hl_opportunity" });
  await processNextBatch();
  assert.deepEqual(hlOpportunityCalls, [["ws_1", "contact_1"]]);
  assert.deepEqual(setterEvents("setter_post_action"), [{ action: "create_hl_opportunity", contact_id: "contact_1", opportunity_id: "opp_1" }]);
});
