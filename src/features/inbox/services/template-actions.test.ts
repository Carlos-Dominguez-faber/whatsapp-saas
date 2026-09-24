import assert from "node:assert/strict";
import { test, mock } from "node:test";

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
const templateRows = [{ id: "tpl_1", name: "welcome" }];

mock.module("./templates.ts", {
  exports: {
    listTemplates: async (workspaceId: string, status: string) => {
      listTemplatesCalls.push([workspaceId, status]);
      return templateRows;
    },
  },
});

// ── ./dispatch ───────────────────────────────────────────────────────────────
let dispatchCalls: unknown[] = [];
let dispatchResult: { ok: boolean; error?: string } = { ok: true };

mock.module("./dispatch.ts", {
  exports: {
    dispatchTemplate: async (params: unknown) => {
      dispatchCalls.push(params);
      return dispatchResult;
    },
  },
});

const { getApprovedTemplates, sendTemplateAction } = await import(
  "./template-actions.ts"
);

function reset() {
  accessResult = { ok: true, userId: "user_1" };
  checkCalls = [];
  listTemplatesCalls = [];
  dispatchCalls = [];
  dispatchResult = { ok: true };
}

// ── getApprovedTemplates ─────────────────────────────────────────────────────

test("getApprovedTemplates: legitimate member gets the rows, scoped to their workspace", async () => {
  reset();
  const rows = await getApprovedTemplates("ws_1");
  assert.deepEqual(rows, templateRows);
  assert.deepEqual(listTemplatesCalls, [["ws_1", "approved"]]);
  assert.equal(checkCalls[0]?.workspaceId, "ws_1");
  assert.equal(checkCalls[0]?.minRole, undefined);
});

test("getApprovedTemplates: non-member throws and never reaches listTemplates", async () => {
  reset();
  accessResult = { ok: false, status: 403 };
  await assert.rejects(() => getApprovedTemplates("ws_1"));
  assert.equal(listTemplatesCalls.length, 0);
});

test("getApprovedTemplates: no session throws and never reaches listTemplates", async () => {
  reset();
  accessResult = { ok: false, status: 401 };
  await assert.rejects(() => getApprovedTemplates("ws_1"));
  assert.equal(listTemplatesCalls.length, 0);
});

// ── sendTemplateAction ───────────────────────────────────────────────────────

test("sendTemplateAction: agent role dispatches and returns ok", async () => {
  reset();
  const result = await sendTemplateAction(
    "ws_1",
    "conv_1",
    "welcome",
    "es",
    [],
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(dispatchCalls.length, 1);
  assert.equal(checkCalls[0]?.minRole, "agent");
});

test("sendTemplateAction: passes the authenticated member's userId as senderUserId", async () => {
  reset();
  accessResult = { ok: true, userId: "user_42" };
  await sendTemplateAction("ws_1", "conv_1", "welcome", "es", []);
  assert.equal(dispatchCalls.length, 1);
  assert.equal(
    (dispatchCalls[0] as { senderUserId?: string }).senderUserId,
    "user_42",
  );
});

test("sendTemplateAction: non-member returns ok:false and never dispatches", async () => {
  reset();
  accessResult = { ok: false, status: 403 };
  const result = await sendTemplateAction(
    "ws_1",
    "conv_1",
    "welcome",
    "es",
    [],
  );
  assert.equal(result.ok, false);
  assert.equal(dispatchCalls.length, 0);
});

test("sendTemplateAction: no session returns ok:false and never dispatches", async () => {
  reset();
  accessResult = { ok: false, status: 401 };
  const result = await sendTemplateAction(
    "ws_1",
    "conv_1",
    "welcome",
    "es",
    [],
  );
  assert.equal(result.ok, false);
  assert.equal(dispatchCalls.length, 0);
});

test("sendTemplateAction: insufficient role (viewer) returns ok:false and never dispatches", async () => {
  reset();
  accessResult = { ok: false, status: 403 };
  const result = await sendTemplateAction(
    "ws_1",
    "conv_1",
    "welcome",
    "es",
    [],
  );
  assert.equal(result.ok, false);
  assert.equal(dispatchCalls.length, 0);
  assert.equal(checkCalls[0]?.minRole, "agent");
});
