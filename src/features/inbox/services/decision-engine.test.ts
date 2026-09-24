import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

// decide() and applyTransition() tests, ported from 14aefa2 (PR #8) together
// with the workspace scope they cover.

interface QueueEntry {
  data?: unknown;
  error?: unknown;
}

let responseQueue: QueueEntry[] = [];
let lookups: unknown[][][] = [];
let updates: Array<{ table: string; row: unknown; eqArgs: unknown[][] }> = [];
let inserts: Array<{ table: string; row: unknown }> = [];

function nextResponse(): QueueEntry {
  return responseQueue.shift() ?? { data: null, error: null };
}

const fakeClient = {
  from(table: string) {
    return {
      select() {
        const eqArgs: unknown[][] = [];
        const chain: any = {
          eq(column: string, value: unknown) {
            eqArgs.push([column, value]);
            return chain;
          },
          single() {
            lookups.push(eqArgs);
            return Promise.resolve(nextResponse());
          },
          maybeSingle() {
            lookups.push(eqArgs);
            return Promise.resolve(nextResponse());
          },
        };
        return chain;
      },
      update(row: unknown) {
        const eqArgs: unknown[][] = [];
        const chain: any = {
          eq(column: string, value: unknown) {
            eqArgs.push([column, value]);
            return chain;
          },
          // The compare-and-swap asks for the updated row back: a queue entry
          // without `data` is a won race ({ id }); `data: null` a lost one.
          select() {
            return {
              maybeSingle() {
                updates.push({ table, row, eqArgs });
                const r = nextResponse();
                if (r.error) return Promise.resolve({ data: null, error: r.error });
                return Promise.resolve({
                  data: "data" in r ? r.data : { id: "conv_1" },
                  error: null,
                });
              },
            };
          },
          then(resolve: (v: QueueEntry) => void) {
            updates.push({ table, row, eqArgs });
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
let reserveCalls = 0;
mock.module("./cost-tracker.ts", {
  exports: {
    reserveLlmTurn: async () => {
      reserveCalls++;
      return rateLimitResult;
    },
  },
});
let enabledTools: unknown[] = [];
let enabledToolsError: Error | null = null;
mock.module("@/features/tools/services/tool-configs.ts", {
  exports: {
    getEnabledTools: async () => {
      if (enabledToolsError) throw enabledToolsError;
      return enabledTools;
    },
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

const FOUND = {
  data: { state: "ai_active", workspace_id: "ws_1", state_version: 3 },
  error: null,
};

function reset(queue: QueueEntry[] = [FOUND, { error: null }, { error: null }]) {
  responseQueue = queue;
  lookups = [];
  updates = [];
  inserts = [];
  notifyCalls.length = 0;
  notifyShouldReject = false;
  rateLimitResult = { allowed: true };
  reserveCalls = 0;
  enabledTools = [];
  enabledToolsError = null;
}

const DECIDE = {
  workspaceId: "ws_1",
  conversationId: "conv_1",
  mergedText: "hola, tengo una consulta",
  contactId: "contact_1",
};

// ── decide() ────────────────────────────────────────────────────────────

test("decide abstains when the conversation lookup fails", async () => {
  reset([{ data: null, error: { message: "not found" } }]);
  const result = await decide({ ...DECIDE, conversationId: "conv_missing" });
  assert.deepEqual(result, { decision: "abstain", reason: "conversation_not_found" });
});

test("decide abstains when the conversation is not in ai_active state", async () => {
  reset([{ data: { state: "paused" }, error: null }]);
  const result = await decide(DECIDE);
  assert.deepEqual(result, { decision: "abstain", reason: "state:paused" });
});

test("decide moves a handoff phrase to handoff_pending and returns 'handoff'", async () => {
  reset([{ data: { state: "ai_active" }, error: null }, FOUND, { error: null }, { error: null }]);
  const result = await decide({ ...DECIDE, mergedText: "quiero hablar con un humano" });
  assert.deepEqual(result, { decision: "handoff", reason: "handoff_trigger" });
  assert.equal(updates.length, 1);
  assert.equal((updates[0].row as { state: string }).state, "handoff_pending");
  assert.deepEqual(notifyCalls, [
    { workspaceId: "ws_1", conversationId: "conv_1", trigger: "keyword" },
  ]);
});

test("decide rejects when the transition itself fails, instead of reporting a handoff", async () => {
  reset([{ data: { state: "ai_active" }, error: null }, { data: null, error: { message: "boom" } }]);
  await assert.rejects(
    () => decide({ ...DECIDE, mergedText: "necesito hablar con alguien" }),
    /conversation not found: boom/,
  );
});

test("decide still returns 'handoff' when only the notification fails", async () => {
  reset([{ data: { state: "ai_active" }, error: null }, FOUND, { error: null }, { error: null }]);
  notifyShouldReject = true;
  const result = await decide({ ...DECIDE, mergedText: "quiero hablar con un humano" });
  assert.deepEqual(result, { decision: "handoff", reason: "handoff_trigger" });
  assert.equal(notifyCalls.length, 1);
});

test("decide returns 'rate_limited' when reserveLlmTurn denies", async () => {
  reset([{ data: { state: "ai_active" }, error: null }]);
  rateLimitResult = { allowed: false, reason: "rate_limit_contact_hour" };
  const result = await decide(DECIDE);
  assert.deepEqual(result, { decision: "rate_limited", reason: "rate_limit_contact_hour" });
});

test("decide returns 'respond' with the enabled tools and the reservationId", async () => {
  reset([{ data: { state: "ai_active" }, error: null }]);
  const fakeTool = { name: "check_availability" } as never;
  enabledTools = [fakeTool];
  rateLimitResult = { allowed: true, reservationId: "res_1" };
  const result = await decide(DECIDE);
  assert.deepEqual(result, {
    decision: "respond",
    reason: "normal",
    availableTools: [fakeTool],
    reservationId: "res_1",
  });
});

test("decide reuses the reservation an earlier attempt made instead of reserving again", async () => {
  reset([{ data: { state: "ai_active" }, error: null }]);
  // A fresh reservation would be denied: the contact is at the limit now,
  // counting the slot this batch itself took on its first attempt.
  rateLimitResult = { allowed: false, reason: "rate_limit_contact_hour" };
  const result = await decide({ ...DECIDE, reservationId: "res_prev" });
  assert.equal(reserveCalls, 0);
  assert.equal(result.decision, "respond");
  assert.equal(result.reservationId, "res_prev");
});

test("decide loads the tools before reserving, so a failure there spends no slot", async () => {
  reset([{ data: { state: "ai_active" }, error: null }]);
  enabledToolsError = new Error("tool_configs unavailable");
  await assert.rejects(() => decide(DECIDE), /tool_configs unavailable/);
  assert.equal(reserveCalls, 0);
});

// ── applyTransition() ──────────────────────────────────────────────────

test("scopes both the lookup and the update to workspaceId when it is given", async () => {
  reset();
  await applyTransition("conv_1", "human_active", {
    userId: "user_1",
    workspaceId: "ws_1",
  });
  assert.deepEqual(lookups[0], [
    ["id", "conv_1"],
    ["workspace_id", "ws_1"],
  ]);
  const update = updates.find((u) => u.table === "conversations");
  assert.ok(update, "conversations update must run");
  assert.deepEqual(update.eqArgs, [
    ["id", "conv_1"],
    ["state", "ai_active"],
    ["state_version", 3],
    ["workspace_id", "ws_1"],
  ]);
  // The state_change event is logged under the conversation's workspace.
  assert.equal((inserts[0].row as { workspace_id: string }).workspace_id, "ws_1");
});

test("when the scoped lookup finds nothing, nothing is written", async () => {
  reset([{ data: null, error: { message: "0 rows" } }]);
  await assert.rejects(
    () => applyTransition("conv_other_ws", "human_active", { workspaceId: "ws_1" }),
    /conversation not found/,
  );
  assert.equal(updates.length, 0);
  assert.equal(inserts.length, 0);
});

test("without workspaceId the lookup filters by id only (internal callers)", async () => {
  reset();
  await applyTransition("conv_1", "paused");
  assert.deepEqual(lookups[0], [["id", "conv_1"]]);
});

test("throws TransitionError on an invalid transition", async () => {
  reset([{ data: { state: "closed", workspace_id: "ws_1" }, error: null }]);
  await assert.rejects(
    () => applyTransition("conv_1", "ai_active"),
    /Invalid transition: closed → ai_active/,
  );
});

test("sets assigned_to when a user moves the thread to human_active", async () => {
  reset();
  await applyTransition("conv_1", "human_active", { userId: "user_1", trigger: "manual" });
  const row = updates[0].row as Record<string, unknown>;
  assert.equal(row.state, "human_active");
  assert.equal(row.ai_enabled, false);
  assert.equal(row.assigned_to, "user_1");
});

test("notifies the contact when entering handoff_pending", async () => {
  reset();
  await applyTransition("conv_1", "handoff_pending", { trigger: "keyword" });
  assert.deepEqual(notifyCalls, [
    { workspaceId: "ws_1", conversationId: "conv_1", trigger: "keyword" },
  ]);
});

test("a failing handoff notification does not undo the committed transition", async () => {
  reset();
  notifyShouldReject = true;
  await applyTransition("conv_1", "handoff_pending", { trigger: "keyword" });
  assert.equal((updates[0].row as { state: string }).state, "handoff_pending");
  assert.equal(notifyCalls.length, 1);
});

test("throws when the DB update fails", async () => {
  reset([FOUND, { error: { message: "db down" } }]);
  await assert.rejects(
    () => applyTransition("conv_1", "paused"),
    /failed to apply transition: db down/,
  );
});

// ── applyTransition(): compare-and-swap ────────────────────────────────

test("lost race to the same target: returns without a second event or notification", async () => {
  reset([FOUND, { data: null }, { data: { state: "handoff_pending" }, error: null }]);
  await applyTransition("conv_1", "handoff_pending", { trigger: "keyword" });
  assert.equal(inserts.length, 0, "no second state_change event");
  assert.equal(notifyCalls.length, 0, "no second notification");
});

test("lost race where the state moved elsewhere: throws state_mismatch", async () => {
  reset([FOUND, { data: null }, { data: { state: "closed" }, error: null }]);
  await assert.rejects(
    () => applyTransition("conv_1", "handoff_pending", { trigger: "keyword" }),
    (err: unknown) =>
      err instanceof Error &&
      err.name === "TransitionError" &&
      (err as { code?: string }).code === "state_mismatch",
  );
});

test("lost race with an assignment: the other operator won, so this one is told", async () => {
  reset([FOUND, { data: null }, { data: { state: "human_active" }, error: null }]);
  await assert.rejects(
    () => applyTransition("conv_1", "human_active", { userId: "user_2" }),
    /state moved under us/,
  );
});

test("before the migration (no state_version column) it compares on state only", async () => {
  reset([
    { data: null, error: { code: "42703", message: "column conversations.state_version does not exist" } },
    { data: { state: "ai_active", workspace_id: "ws_1" }, error: null },
    {},
    { error: null },
  ]);
  await applyTransition("conv_1", "paused");
  const update = updates.find((u) => u.table === "conversations");
  assert.ok(update);
  assert.deepEqual(update.eqArgs, [
    ["id", "conv_1"],
    ["state", "ai_active"],
  ]);
});

test("si el INSERT del evento state_change falla, queda registrado server-side", async () => {
  reset();
  responseQueue = [
    { data: { state: "ai_active", workspace_id: "ws_1" }, error: null },
    { error: null }, // UPDATE
    { error: { code: "57014", message: "connection string leaked" } }, // INSERT: falla
  ];
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => logged.push(a);
  try {
    await applyTransition("conv_1", "handoff_pending");
  } finally {
    console.error = original;
  }
  assert.ok(logged.some((a) => String(a[0]).includes("state_change insert failed")));
  // Y no se filtra el mensaje crudo del error.
  assert.ok(logged.every((a) => !JSON.stringify(a).includes("connection string")));
});
