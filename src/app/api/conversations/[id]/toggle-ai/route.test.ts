import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { NextRequest } from "next/server";

let currentUser: { id: string } | null = { id: "user_1" };
let convRow: {
  state: string;
  workspace_id: string;
  assigned_to?: string | null;
} | null = {
  state: "human_active",
  workspace_id: "ws_1",
};
const directUpdates: unknown[] = [];
// Role of the caller in the conversation's workspace; null = not a member.
let memberRole: string | null = "admin";

const membershipChain: any = {
  eq: () => membershipChain,
  maybeSingle: async () => ({
    data: memberRole ? { role: memberRole } : null,
    error: null,
  }),
};

const fakeSupabase = {
  auth: { getUser: async () => ({ data: { user: currentUser } }) },
  from: (table: string) =>
    table === "memberships"
      ? { select: () => membershipChain }
      : {
    select: () => ({
      eq: () => ({
        single: async () =>
          convRow
            ? { data: convRow, error: null }
            : { data: null, error: { message: "0 rows" } },
      }),
    }),
    update: (row: unknown) => {
      directUpdates.push(row);
      return { eq: () => ({ select: () => ({ single: async () => ({ data: row, error: null }) }) }) };
    },
  },
};
mock.module("@/lib/supabase/server.ts", {
  exports: { createClient: async () => fakeSupabase },
});

const transitions: unknown[] = [];
mock.module("@/features/inbox/services/decision-engine.ts", {
  exports: {
    applyTransition: async (...args: unknown[]) => {
      transitions.push(args);
    },
  },
});

const { PATCH } = await import("./route.ts");

function makeReq(body: unknown) {
  return new NextRequest("http://localhost/api/conversations/conv_1/toggle-ai", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}
const params = { params: Promise.resolve({ id: "conv_1" }) };

test("turning the AI on from human_active goes through applyTransition, never a direct update", async () => {
  transitions.length = 0;
  directUpdates.length = 0;
  convRow = { state: "human_active", workspace_id: "ws_1" };
  const res = await PATCH(makeReq({ ai_enabled: true }), params);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, ai_enabled: true, state: "ai_active" });
  assert.deepEqual(transitions[0], [
    "conv_1",
    "ai_active",
    { userId: "user_1", trigger: "manual", workspaceId: "ws_1" },
  ]);
  assert.equal(directUpdates.length, 0, "conversations.ai_enabled must not be written directly");
});

test("turning the AI off from ai_active transitions to human_active", async () => {
  transitions.length = 0;
  convRow = { state: "ai_active", workspace_id: "ws_1" };
  const res = await PATCH(makeReq({ ai_enabled: false }), params);
  assert.equal(res.status, 200);
  assert.equal((transitions[0] as unknown[])[1], "human_active");
});

test("is idempotent: already in the target state → 200 without a transition", async () => {
  transitions.length = 0;
  convRow = { state: "ai_active", workspace_id: "ws_1" };
  const res = await PATCH(makeReq({ ai_enabled: true }), params);
  assert.equal(res.status, 200);
  assert.equal(transitions.length, 0);
});

test("422 on a closed conversation", async () => {
  transitions.length = 0;
  convRow = { state: "closed", workspace_id: "ws_1" };
  const res = await PATCH(makeReq({ ai_enabled: true }), params);
  assert.equal(res.status, 422);
  assert.equal(transitions.length, 0);
});

test("404 when the conversation is not visible to the caller", async () => {
  transitions.length = 0;
  convRow = null;
  const res = await PATCH(makeReq({ ai_enabled: true }), params);
  assert.equal(res.status, 404);
  assert.equal(transitions.length, 0);
});

// The route transitions with the service role, so it must enforce the
// conversations UPDATE policy itself: admin/manager of the workspace, or the
// member the conversation is assigned to.
test("403 for a viewer not assigned to the conversation, without a transition", async () => {
  transitions.length = 0;
  memberRole = "viewer";
  convRow = { state: "ai_active", workspace_id: "ws_1", assigned_to: null };
  const res = await PATCH(makeReq({ ai_enabled: false }), params);
  assert.equal(res.status, 403);
  assert.equal(transitions.length, 0);
  memberRole = "admin";
});

test("403 for an agent not assigned to the conversation", async () => {
  transitions.length = 0;
  memberRole = "agent";
  convRow = { state: "ai_active", workspace_id: "ws_1", assigned_to: "user_2" };
  const res = await PATCH(makeReq({ ai_enabled: false }), params);
  assert.equal(res.status, 403);
  assert.equal(transitions.length, 0);
  memberRole = "admin";
});

test("403 when the caller is no longer an active member", async () => {
  transitions.length = 0;
  memberRole = null;
  convRow = { state: "ai_active", workspace_id: "ws_1", assigned_to: "user_1" };
  const res = await PATCH(makeReq({ ai_enabled: false }), params);
  assert.equal(res.status, 403);
  assert.equal(transitions.length, 0);
  memberRole = "admin";
});

test("200 for a manager not assigned to the conversation", async () => {
  transitions.length = 0;
  memberRole = "manager";
  convRow = { state: "ai_active", workspace_id: "ws_1", assigned_to: "user_2" };
  const res = await PATCH(makeReq({ ai_enabled: false }), params);
  assert.equal(res.status, 200);
  assert.equal(transitions.length, 1);
  memberRole = "admin";
});

test("200 for an agent the conversation is assigned to", async () => {
  transitions.length = 0;
  memberRole = "agent";
  convRow = { state: "ai_active", workspace_id: "ws_1", assigned_to: "user_1" };
  const res = await PATCH(makeReq({ ai_enabled: false }), params);
  assert.equal(res.status, 200);
  assert.equal(transitions.length, 1);
  memberRole = "admin";
});

test("400 when ai_enabled is not a boolean", async () => {
  convRow = { state: "ai_active", workspace_id: "ws_1" };
  const res = await PATCH(makeReq({ ai_enabled: "yes" }), params);
  assert.equal(res.status, 400);
});
