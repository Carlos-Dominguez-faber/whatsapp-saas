import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

// applyTransition() tests, ported from 14aefa2 (PR #8) together with the
// workspace scope they cover. decide() is exercised by the route tests.

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
mock.module("./cost-tracker.ts", {
  exports: { checkRateLimits: async () => ({ allowed: true }) },
});
mock.module("@/features/tools/services/tool-configs.ts", {
  exports: { getEnabledTools: async () => [] },
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

const { applyTransition } = await import("./decision-engine.ts");

const FOUND = { data: { state: "ai_active", workspace_id: "ws_1" }, error: null };

function reset(queue: QueueEntry[] = [FOUND, { error: null }, { error: null }]) {
  responseQueue = queue;
  lookups = [];
  updates = [];
  inserts = [];
  notifyCalls.length = 0;
  notifyShouldReject = false;
}

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
