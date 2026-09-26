import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { NextRequest } from "next/server";

// ── Fakes ────────────────────────────────────────────────────────────────────
type ConvRow = { workspace_id: string; assigned_to?: string | null } | null;
let currentUser: { id: string } | null = { id: "user_1" };
let convRow: ConvRow = { workspace_id: "ws_1" };
// Role of the caller in the conversation's workspace; null = not an active member.
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

const { POST } = await import("./route.ts");

function makeReq(body: unknown) {
  return new NextRequest("http://localhost/api/conversations/conv_1/handoff", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}
const params = { params: Promise.resolve({ id: "conv_1" }) };

// ── Tests ────────────────────────────────────────────────────────────────────
test("401 when there is no session", async () => {
  currentUser = null;
  const res = await POST(makeReq({ action: "request" }), params);
  assert.equal(res.status, 401);
  currentUser = { id: "user_1" };
});

test("404 when the conversation is not visible to the caller (other workspace)", async () => {
  transitions.length = 0;
  convRow = null;
  const res = await POST(makeReq({ action: "request" }), params);
  assert.equal(res.status, 404);
  assert.equal(transitions.length, 0, "must not touch the state machine");
  convRow = { workspace_id: "ws_1" };
});

test("400 on malformed JSON instead of a 500", async () => {
  const req = new NextRequest("http://localhost/api/conversations/conv_1/handoff", {
    method: "POST",
    body: "{not json",
    headers: { "content-type": "application/json" },
  });
  const res = await POST(req, params);
  assert.equal(res.status, 400);
});

test("passes the workspace scope through to applyTransition on success", async () => {
  transitions.length = 0;
  const res = await POST(makeReq({ action: "cancel" }), params);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, state: "ai_active" });
  assert.deepEqual(transitions[0], [
    "conv_1",
    "ai_active",
    { userId: "user_1", trigger: "manual", workspaceId: "ws_1" },
  ]);
});

// applyTransition writes with the service role, so the route itself must
// enforce the conversations UPDATE policy: admin/manager of the workspace, or
// the member the conversation is assigned to.
for (const action of ["request", "cancel"] as const) {
  test(`403 for a viewer not assigned to the conversation (${action}), without a transition`, async () => {
    transitions.length = 0;
    memberRole = "viewer";
    convRow = { workspace_id: "ws_1", assigned_to: null };
    const res = await POST(makeReq({ action }), params);
    assert.equal(res.status, 403);
    assert.equal(transitions.length, 0);
    memberRole = "admin";
  });
}

test("an agent can flag any thread for a human (request assigns nobody)", async () => {
  transitions.length = 0;
  memberRole = "agent";
  convRow = { workspace_id: "ws_1", assigned_to: null };
  const res = await POST(makeReq({ action: "request" }), params);
  assert.equal(res.status, 200);
  assert.equal(transitions.length, 1);
  memberRole = "admin";
});

test("403 when an agent hands back to the AI a thread assigned to someone else", async () => {
  transitions.length = 0;
  memberRole = "agent";
  convRow = { workspace_id: "ws_1", assigned_to: "user_2" };
  const res = await POST(makeReq({ action: "cancel" }), params);
  assert.equal(res.status, 403);
  assert.equal(transitions.length, 0);
  memberRole = "admin";
});

test("403 when the caller is no longer an active member", async () => {
  transitions.length = 0;
  memberRole = null;
  convRow = { workspace_id: "ws_1", assigned_to: "user_1" };
  const res = await POST(makeReq({ action: "request" }), params);
  assert.equal(res.status, 403);
  assert.equal(transitions.length, 0);
  memberRole = "admin";
});

test("200 for a manager not assigned to the conversation", async () => {
  transitions.length = 0;
  memberRole = "manager";
  convRow = { workspace_id: "ws_1", assigned_to: "user_2" };
  const res = await POST(makeReq({ action: "request" }), params);
  assert.equal(res.status, 200);
  assert.equal(transitions.length, 1);
  memberRole = "admin";
});

test("200 for a viewer handing back the thread assigned to them (the policy allows the assignee)", async () => {
  transitions.length = 0;
  memberRole = "viewer";
  convRow = { workspace_id: "ws_1", assigned_to: "user_1" };
  const res = await POST(makeReq({ action: "cancel" }), params);
  assert.equal(res.status, 200);
  assert.equal(transitions.length, 1);
  memberRole = "admin";
});

test("403 for a viewer flagging a thread for a human, even if assigned to them", async () => {
  transitions.length = 0;
  memberRole = "viewer";
  convRow = { workspace_id: "ws_1", assigned_to: "user_1" };
  const res = await POST(makeReq({ action: "request" }), params);
  assert.equal(res.status, 403);
  assert.equal(transitions.length, 0);
  memberRole = "admin";
});

test("400 when the action is not request or cancel", async () => {
  transitions.length = 0;
  const res = await POST(makeReq({ action: "steal" }), params);
  assert.equal(res.status, 400);
  assert.equal(transitions.length, 0);
});
