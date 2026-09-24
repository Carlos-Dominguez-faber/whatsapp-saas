import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

interface QueueEntry {
  data?: unknown;
  error?: unknown;
}

let responseQueue: QueueEntry[] = [];
let updates: Array<{ table: string; row: unknown; eqArgs?: unknown[][] }> = [];
let inserts: Array<{ table: string; row: unknown }> = [];

function nextResponse(): QueueEntry {
  return responseQueue.shift() ?? { data: null, error: null };
}

function makeSelectChain() {
  const chain: any = {
    eq() {
      return chain;
    },
    single() {
      return Promise.resolve(nextResponse());
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
        const eqArgs: unknown[][] = [];
        const chain: any = {
          eq(column: string, value: unknown) {
            eqArgs.push([column, value]);
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
        return Promise.resolve(nextResponse());
      },
    };
  },
};

mock.module("@supabase/supabase-js", {
  exports: { createClient: () => fakeClient },
});

let rateLimitResult: { allowed: boolean; reason?: string; reservationId?: string } = {
  allowed: true,
};
mock.module("./cost-tracker.ts", {
  exports: {
    reserveLlmTurn: async () => rateLimitResult,
  },
});

let enabledTools: unknown[] = [];
mock.module("@/features/tools/services/tool-configs.ts", {
  exports: {
    getEnabledTools: async () => enabledTools,
  },
});

const notifyCalls: unknown[] = [];
let notifyShouldReject = false;
mock.module("./handoff-notifier.ts", {
  exports: {
    notifyHandoffPending: async (params: unknown) => {
      notifyCalls.push(params);
      if (notifyShouldReject) throw new Error("notify boom");
    },
  },
});

const { decide, applyTransition } = await import("./decision-engine.ts");

function reset() {
  responseQueue = [];
  updates = [];
  inserts = [];
  notifyCalls.length = 0;
  notifyShouldReject = false;
  rateLimitResult = { allowed: true };
  enabledTools = [];
}

// ── decide() ────────────────────────────────────────────────────────────

test("decide abstains when the conversation lookup fails", async () => {
  reset();
  responseQueue = [{ data: null, error: { message: "not found" } }];
  const result = await decide({
    workspaceId: "ws_1",
    conversationId: "conv_missing",
    mergedText: "hola",
    contactId: "contact_1",
  });
  assert.deepEqual(result, { decision: "abstain", reason: "conversation_not_found" });
});

test("decide abstains when the conversation is not in ai_active state", async () => {
  reset();
  responseQueue = [{ data: { state: "paused" }, error: null }];
  const result = await decide({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    mergedText: "hola",
    contactId: "contact_1",
  });
  assert.deepEqual(result, { decision: "abstain", reason: "state:paused" });
});

test("decide transitions to handoff_pending and returns 'handoff' when the message contains a handoff phrase", async () => {
  reset();
  responseQueue = [
    { data: { state: "ai_active" }, error: null },
    { data: { state: "ai_active", workspace_id: "ws_1" }, error: null },
    { error: null },
    { error: null },
  ];
  const result = await decide({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    mergedText: "quiero hablar con un humano",
    contactId: "contact_1",
  });
  assert.deepEqual(result, { decision: "handoff", reason: "handoff_trigger" });
  assert.equal(updates.length, 1);
  assert.equal((updates[0].row as { state: string }).state, "handoff_pending");
  assert.equal(notifyCalls.length, 1);
  assert.deepEqual(notifyCalls[0], {
    workspaceId: "ws_1",
    conversationId: "conv_1",
    trigger: "keyword",
  });
});

test("decide rejects when applying the transition itself fails, instead of reporting a successful handoff", async () => {
  reset();
  responseQueue = [
    { data: { state: "ai_active" }, error: null },
    { data: null, error: { message: "boom" } },
  ];
  await assert.rejects(
    () =>
      decide({
        workspaceId: "ws_1",
        conversationId: "conv_1",
        mergedText: "necesito hablar con alguien",
        contactId: "contact_1",
      }),
    /conversation not found: boom/,
  );
});

test("decide still returns 'handoff' when only the notification fails — the transition itself succeeded", async () => {
  reset();
  notifyShouldReject = true;
  responseQueue = [
    { data: { state: "ai_active" }, error: null },
    { data: { state: "ai_active", workspace_id: "ws_1" }, error: null },
    { error: null },
    { error: null },
  ];
  const result = await decide({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    mergedText: "quiero hablar con un humano",
    contactId: "contact_1",
  });
  assert.deepEqual(result, { decision: "handoff", reason: "handoff_trigger" });
  assert.equal(notifyCalls.length, 1);
});

test("decide returns 'rate_limited' when reserveLlmTurn denies", async () => {
  reset();
  responseQueue = [{ data: { state: "ai_active" }, error: null }];
  rateLimitResult = { allowed: false, reason: "rate_limit_contact_hour" };
  const result = await decide({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    mergedText: "hola, tengo una consulta",
    contactId: "contact_1",
  });
  assert.deepEqual(result, {
    decision: "rate_limited",
    reason: "rate_limit_contact_hour",
  });
});

test("decide returns 'respond' with the enabled tools and reservationId when all checks pass", async () => {
  reset();
  responseQueue = [{ data: { state: "ai_active" }, error: null }];
  const fakeTool = { name: "schedule_calcom" } as never;
  enabledTools = [fakeTool];
  rateLimitResult = { allowed: true, reservationId: "res_1" };
  const result = await decide({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    mergedText: "hola, tengo una consulta",
    contactId: "contact_1",
  });
  assert.deepEqual(result, {
    decision: "respond",
    reason: "normal",
    availableTools: [fakeTool],
    reservationId: "res_1",
  });
});

// ── applyTransition() ──────────────────────────────────────────────────

test("applyTransition throws when the conversation is not found", async () => {
  reset();
  responseQueue = [{ data: null, error: { message: "no rows" } }];
  await assert.rejects(
    () => applyTransition("conv_missing", "human_active"),
    /conversation not found/,
  );
});

test("applyTransition throws TransitionError on an invalid transition", async () => {
  reset();
  responseQueue = [{ data: { state: "closed", workspace_id: "ws_1" }, error: null }];
  await assert.rejects(
    () => applyTransition("conv_1", "ai_active"),
    /Invalid transition: closed → ai_active/,
  );
});

test("applyTransition sets assigned_to when transitioning to human_active with a userId", async () => {
  reset();
  responseQueue = [
    { data: { state: "ai_active", workspace_id: "ws_1" }, error: null },
    { error: null },
    { error: null },
  ];
  await applyTransition("conv_1", "human_active", { userId: "user_1", trigger: "manual" });
  assert.equal(updates.length, 1);
  const row = updates[0].row as Record<string, unknown>;
  assert.equal(row.state, "human_active");
  assert.equal(row.ai_enabled, false);
  assert.equal(row.assigned_to, "user_1");
});

test("applyTransition does not set assigned_to when no userId is given", async () => {
  reset();
  responseQueue = [
    { data: { state: "ai_active", workspace_id: "ws_1" }, error: null },
    { error: null },
    { error: null },
  ];
  await applyTransition("conv_1", "paused");
  const row = updates[0].row as Record<string, unknown>;
  assert.equal(row.ai_enabled, false);
  assert.equal("assigned_to" in row, false);
});

test("applyTransition logs a state_change event with from, to, actor, and trigger", async () => {
  reset();
  responseQueue = [
    { data: { state: "ai_active", workspace_id: "ws_1" }, error: null },
    { error: null },
    { error: null },
  ];
  await applyTransition("conv_1", "human_active", { userId: "user_1", trigger: "manual" });
  assert.equal(inserts.length, 1);
  assert.deepEqual(inserts[0].row, {
    type: "state_change",
    level: "info",
    workspace_id: "ws_1",
    conversation_id: "conv_1",
    payload: { from: "ai_active", to: "human_active", actor: "user_1", trigger: "manual" },
  });
});

test("applyTransition logs actor 'system' when no userId is given", async () => {
  reset();
  responseQueue = [
    { data: { state: "ai_active", workspace_id: "ws_1" }, error: null },
    { error: null },
    { error: null },
  ];
  await applyTransition("conv_1", "paused");
  const payload = (inserts[0].row as { payload: { actor: string } }).payload;
  assert.equal(payload.actor, "system");
});

test("applyTransition notifies the contact when transitioning into handoff_pending", async () => {
  reset();
  responseQueue = [
    { data: { state: "ai_active", workspace_id: "ws_1" }, error: null },
    { error: null },
    { error: null },
  ];
  await applyTransition("conv_1", "handoff_pending", { trigger: "keyword" });
  assert.equal(notifyCalls.length, 1);
  assert.deepEqual(notifyCalls[0], {
    workspaceId: "ws_1",
    conversationId: "conv_1",
    trigger: "keyword",
  });
});

test("applyTransition does not throw when notifyHandoffPending rejects — the transition already committed", async () => {
  reset();
  notifyShouldReject = true;
  responseQueue = [
    { data: { state: "ai_active", workspace_id: "ws_1" }, error: null },
    { error: null },
    { error: null },
  ];
  await applyTransition("conv_1", "handoff_pending", { trigger: "keyword" });
  assert.equal(updates.length, 1);
  assert.equal((updates[0].row as { state: string }).state, "handoff_pending");
  assert.equal(notifyCalls.length, 1);
});

test("applyTransition does not notify anyone for a transition other than handoff_pending", async () => {
  reset();
  responseQueue = [
    { data: { state: "ai_active", workspace_id: "ws_1" }, error: null },
    { error: null },
    { error: null },
  ];
  await applyTransition("conv_1", "paused");
  assert.equal(notifyCalls.length, 0);
});

test("applyTransition throws when the DB update fails", async () => {
  reset();
  responseQueue = [
    { data: { state: "ai_active", workspace_id: "ws_1" }, error: null },
    { error: { message: "db down" } },
  ];
  await assert.rejects(
    () => applyTransition("conv_1", "paused"),
    /failed to apply transition: db down/,
  );
});

test("applyTransition scopes both the lookup and the update to workspaceId when it is given", async () => {
  responseQueue = [
    { data: { state: "ai_active", workspace_id: "ws_1" }, error: null }, // lookup
    { error: null }, // update
    { error: null }, // events insert
  ];
  updates = [];
  await applyTransition("conv_1", "human_active", {
    userId: "user_1",
    workspaceId: "ws_1",
  });
  const update = updates.find((u) => u.table === "conversations");
  assert.ok(update, "conversations update must run");
  assert.deepEqual(update!.eqArgs, [
    ["id", "conv_1"],
    ["workspace_id", "ws_1"],
  ]);
});

test("applyTransition treats a conversation from another workspace as not found", async () => {
  // A scoped lookup returns no row → same failure as a missing conversation.
  responseQueue = [{ data: null, error: { message: "0 rows" } }];
  updates = [];
  await assert.rejects(
    () =>
      applyTransition("conv_other_ws", "human_active", {
        workspaceId: "ws_1",
      }),
    /conversation not found/,
  );
  assert.equal(updates.length, 0);
});
