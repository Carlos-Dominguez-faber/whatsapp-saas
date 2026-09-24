import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { NextRequest } from "next/server";

type ConvRow = { state: string; workspace_id: string } | null;
let currentUser: { id: string } | null = { id: "user_1" };
let convRow: ConvRow = { state: "handoff_pending", workspace_id: "ws_1" };
// Role of the caller in the conversation's workspace; null = not an active member.
let memberRole: string | null = "agent";

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
let transitionError: Error | null = null;
mock.module("@/features/inbox/services/decision-engine.ts", {
  exports: {
    applyTransition: async (...args: unknown[]) => {
      if (transitionError) throw transitionError;
      transitions.push(args);
    },
  },
});

const { POST } = await import("./route.ts");

const req = () =>
  new NextRequest("http://localhost/api/conversations/conv_1/take", { method: "POST" });
const params = { params: Promise.resolve({ id: "conv_1" }) };

function reset() {
  transitions.length = 0;
  transitionError = null;
  currentUser = { id: "user_1" };
  memberRole = "agent";
  convRow = { state: "handoff_pending", workspace_id: "ws_1" };
}

test("an agent takes an unassigned pending conversation, scoped to its workspace", async () => {
  reset();
  const res = await POST(req(), params);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, state: "human_active" });
  assert.deepEqual(transitions[0], [
    "conv_1",
    "human_active",
    { userId: "user_1", workspaceId: "ws_1" },
  ]);
});

test("403 for a viewer, without a transition", async () => {
  reset();
  memberRole = "viewer";
  const res = await POST(req(), params);
  assert.equal(res.status, 403);
  assert.equal(transitions.length, 0);
});

test("403 when the caller is no longer an active member", async () => {
  reset();
  memberRole = null;
  const res = await POST(req(), params);
  assert.equal(res.status, 403);
  assert.equal(transitions.length, 0);
});

test("401 without a session", async () => {
  reset();
  currentUser = null;
  const res = await POST(req(), params);
  assert.equal(res.status, 401);
  assert.equal(transitions.length, 0);
});

test("404 when the conversation is not visible to the caller", async () => {
  reset();
  convRow = null;
  const res = await POST(req(), params);
  assert.equal(res.status, 404);
  assert.equal(transitions.length, 0);
});

test("422 when the conversation is not pending a handoff", async () => {
  reset();
  convRow = { state: "ai_active", workspace_id: "ws_1" };
  const res = await POST(req(), params);
  assert.equal(res.status, 422);
  assert.equal(transitions.length, 0);
});

test("422 with a readable message when the transition is rejected", async () => {
  reset();
  transitionError = new Error("Invalid transition: closed -> human_active");
  const res = await POST(req(), params);
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.doesNotMatch(body.error, /Invalid transition/);
});
