import assert from "node:assert/strict";
import { test, mock } from "node:test";

// ── @/lib/supabase/server (RLS-bound client) ────────────────────────────────
// Maps conversationId → workspace_id for the conversations the caller can
// read. Anything missing behaves like RLS hiding a foreign conversation.
let visibleConversations: Record<string, string> = {};
let conversationLookups: string[] = [];

mock.module("@/lib/supabase/server.ts", {
  exports: {
    createClient: async () => ({
      from: (table: string) => {
        assert.equal(table, "conversations");
        let id = "";
        const builder = {
          select: () => builder,
          eq: (column: string, value: string) => {
            if (column === "id") id = value;
            return builder;
          },
          maybeSingle: async () => {
            conversationLookups.push(id);
            const ws = visibleConversations[id];
            return { data: ws ? { workspace_id: ws } : null, error: null };
          },
        };
        return builder;
      },
    }),
  },
});

// ── @/lib/auth/workspace-access ─────────────────────────────────────────────
let accessResult:
  | { ok: true; userId: string }
  | { ok: false; status: 401 | 403 } = {
  ok: true,
  userId: "user_1",
};
let checkCalls: Array<{ workspaceId: string; minRole?: string }> = [];

mock.module("@/lib/auth/workspace-access.ts", {
  exports: {
    checkWorkspaceMember: async (
      workspaceId: string,
      opts?: { minRole?: string },
    ) => {
      checkCalls.push({ workspaceId, minRole: opts?.minRole });
      return accessResult;
    },
  },
});

// ── ./templates ──────────────────────────────────────────────────────────────
let listTemplatesCalls: Array<[string, string]> = [];
const templateRows = [{ id: "tpl_1", name: "welcome", language: "es" }];

mock.module("./templates.ts", {
  exports: {
    listTemplates: async (workspaceId: string, status: string) => {
      listTemplatesCalls.push([workspaceId, status]);
      return templateRows;
    },
  },
});

// ── ./dispatch ───────────────────────────────────────────────────────────────
let dispatchCalls: Array<Record<string, unknown>> = [];
let dispatchResult: { ok: boolean; error?: string } = { ok: true };

mock.module("./dispatch.ts", {
  exports: {
    dispatchTemplate: async (params: Record<string, unknown>) => {
      dispatchCalls.push(params);
      return dispatchResult;
    },
  },
});

const { getApprovedTemplates, sendTemplateAction } = await import(
  "./template-actions.ts"
);

function reset() {
  visibleConversations = { conv_1: "ws_1" };
  conversationLookups = [];
  accessResult = { ok: true, userId: "user_1" };
  checkCalls = [];
  listTemplatesCalls = [];
  dispatchCalls = [];
  dispatchResult = { ok: true };
}

// ── getApprovedTemplates ─────────────────────────────────────────────────────

test("getApprovedTemplates: member gets the rows of the conversation's workspace", async () => {
  reset();
  const rows = await getApprovedTemplates("conv_1");
  assert.deepEqual(rows, templateRows);
  assert.deepEqual(listTemplatesCalls, [["ws_1", "approved"]]);
  assert.equal(checkCalls[0]?.workspaceId, "ws_1");
  assert.equal(checkCalls[0]?.minRole, undefined);
});

test("getApprovedTemplates: a conversation the caller cannot read yields [] without any check", async () => {
  reset();
  const rows = await getApprovedTemplates("conv_foreign");
  assert.deepEqual(rows, []);
  assert.equal(checkCalls.length, 0);
  assert.equal(listTemplatesCalls.length, 0);
});

test("getApprovedTemplates: non-member gets [] and never reaches listTemplates", async () => {
  reset();
  accessResult = { ok: false, status: 403 };
  assert.deepEqual(await getApprovedTemplates("conv_1"), []);
  assert.equal(listTemplatesCalls.length, 0);
});

test("getApprovedTemplates: no session gets [] and never reaches listTemplates", async () => {
  reset();
  accessResult = { ok: false, status: 401 };
  assert.deepEqual(await getApprovedTemplates("conv_1"), []);
  assert.equal(listTemplatesCalls.length, 0);
});

// ── sendTemplateAction ───────────────────────────────────────────────────────

test("sendTemplateAction: agent dispatches to the workspace resolved from the conversation", async () => {
  reset();
  const result = await sendTemplateAction("conv_1", "welcome", "es", []);
  assert.deepEqual(result, { ok: true });
  assert.equal(dispatchCalls.length, 1);
  assert.equal(dispatchCalls[0]?.workspaceId, "ws_1");
  assert.equal(dispatchCalls[0]?.conversationId, "conv_1");
  assert.equal(checkCalls[0]?.workspaceId, "ws_1");
  assert.equal(checkCalls[0]?.minRole, "agent");
});

test("sendTemplateAction: passes the authenticated member's userId as senderUserId", async () => {
  reset();
  accessResult = { ok: true, userId: "user_42" };
  await sendTemplateAction("conv_1", "welcome", "es", []);
  assert.equal(dispatchCalls[0]?.senderUserId, "user_42");
});

test("sendTemplateAction: an unknown or foreign conversation is denied before any check or dispatch", async () => {
  reset();
  const result = await sendTemplateAction(
    "00000000-0000-4000-8000-000000000000",
    "welcome",
    "es",
    [],
  );
  assert.deepEqual(result, { ok: false, error: "Acceso denegado" });
  assert.equal(checkCalls.length, 0);
  assert.equal(dispatchCalls.length, 0);
});

test("sendTemplateAction: insufficient role (viewer) is denied and never dispatches", async () => {
  reset();
  accessResult = { ok: false, status: 403 };
  const result = await sendTemplateAction("conv_1", "welcome", "es", []);
  assert.deepEqual(result, { ok: false, error: "Acceso denegado" });
  assert.equal(dispatchCalls.length, 0);
  assert.equal(checkCalls[0]?.minRole, "agent");
});

test("sendTemplateAction: no session is denied and never dispatches", async () => {
  reset();
  accessResult = { ok: false, status: 401 };
  const result = await sendTemplateAction("conv_1", "welcome", "es", []);
  assert.equal(result.ok, false);
  assert.equal(dispatchCalls.length, 0);
});

test("sendTemplateAction: a template the workspace has not approved is refused", async () => {
  reset();
  const byName = await sendTemplateAction("conv_1", "not_approved", "es", []);
  const byLanguage = await sendTemplateAction("conv_1", "welcome", "en_US", []);
  assert.equal(byName.ok, false);
  assert.equal(byLanguage.ok, false);
  assert.equal(dispatchCalls.length, 0);
});

test("sendTemplateAction: malformed input is rejected before touching the database", async () => {
  reset();
  const tooMany = Array.from({ length: 21 }, () => "x");
  const result = await sendTemplateAction("conv_1", "welcome", "es", tooMany);
  assert.equal(result.ok, false);
  assert.equal(conversationLookups.length, 0);
  assert.equal(dispatchCalls.length, 0);
});
