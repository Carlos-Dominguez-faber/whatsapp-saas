import assert from "node:assert/strict";
import { test, mock, beforeEach } from "node:test";

// ── @/lib/auth/workspace-access ─────────────────────────────────────────────
let accessResult:
  | { ok: true; userId: string; role: string }
  | { ok: false; status: 401 | 403 } = { ok: true, userId: "user_1", role: "agent" };
let checkCalls: Array<{ workspaceId: string; minRole?: string }> = [];

mock.module("@/lib/auth/workspace-access.ts", {
  exports: {
    checkWorkspaceMember: async (workspaceId: string, opts?: { minRole?: string }) => {
      checkCalls.push({ workspaceId, minRole: opts?.minRole });
      return accessResult;
    },
  },
});

// ── @/lib/supabase/server: any authenticated user, member or not ────────────
mock.module("@/lib/supabase/server.ts", {
  exports: {
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: { id: "user_1" } }, error: null }) },
    }),
  },
});

// ── ./highlevel-client ──────────────────────────────────────────────────────
let syncCalls: Array<[string, string]> = [];
mock.module("./highlevel-client.ts", {
  exports: {
    syncContactToHL: async (workspaceId: string, contactId: string) => {
      syncCalls.push([workspaceId, contactId]);
      return { hl_id: "hl_1" };
    },
  },
});

const { syncContactHL } = await import("./contact-actions.ts");

beforeEach(() => {
  accessResult = { ok: true, userId: "user_1", role: "agent" };
  checkCalls = [];
  syncCalls = [];
});

test("syncContactHL syncs when the caller is an agent of the workspace", async () => {
  const result = await syncContactHL("ct_1", "ws_1");

  assert.deepEqual(result, { ok: true, data: { hl_id: "hl_1" } });
  assert.deepEqual(checkCalls, [{ workspaceId: "ws_1", minRole: "agent" }]);
  assert.deepEqual(syncCalls, [["ws_1", "ct_1"]]);
});

test("syncContactHL rejects a signed-in user who is not a member, without syncing", async () => {
  accessResult = { ok: false, status: 403 };

  const result = await syncContactHL("ct_1", "ws_other");

  assert.equal(result.ok, false);
  assert.deepEqual(syncCalls, [], "a non-member must not trigger a sync");
});
