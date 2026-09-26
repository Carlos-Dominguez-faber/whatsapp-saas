import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { NextRequest, NextResponse } from "next/server";

let currentUser: { id: string } | null = { id: "user_1" };
let convRow = { workspace_id: "ws_1", window_expires_at: null, ai_enabled: false };

const fakeSupabase = {
  auth: { getUser: async () => ({ data: { user: currentUser } }) },
  from: () => ({
    select: () => ({ eq: () => ({ single: async () => ({ data: convRow, error: null }) }) }),
  }),
};
mock.module("@/lib/supabase/server.ts", {
  exports: { createClient: async () => fakeSupabase },
});

const memberCalls: unknown[] = [];
let memberResult: unknown = { ok: true, userId: "user_1", role: "agent" };
mock.module("@/lib/auth/workspace-access.ts", {
  exports: {
    requireWorkspaceMember: async (...args: unknown[]) => {
      memberCalls.push(args);
      return memberResult;
    },
    readJsonBody: async (req: Request) => ({ ok: true, body: await req.json() }),
  },
});

const dispatchCalls: unknown[] = [];
const transitions: unknown[] = [];
mock.module("@/features/inbox/services/dispatch.ts", {
  exports: {
    dispatchText: async (opts: unknown) => {
      dispatchCalls.push(opts);
      return { ok: true, wamid: "wamid.1" };
    },
  },
});
mock.module("@/features/inbox/services/decision-engine.ts", {
  exports: {
    applyTransition: async (...args: unknown[]) => {
      transitions.push(args);
    },
  },
});
mock.module("@/features/agents/services/active-agent.ts", {
  exports: { getActiveAgent: async () => null },
});

const { POST } = await import("./route.ts");

function makeReq(body: unknown) {
  return new NextRequest("http://localhost/api/conversations/conv_1/messages", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}
const params = { params: Promise.resolve({ id: "conv_1" }) };

test("requires at least the agent role on the conversation's workspace", async () => {
  memberCalls.length = 0;
  dispatchCalls.length = 0;
  memberResult = {
    ok: false,
    response: NextResponse.json({ error: "Permisos insuficientes" }, { status: 403 }),
  };
  const res = await POST(makeReq({ body: "hola" }), params);
  assert.equal(res.status, 403);
  assert.equal(dispatchCalls.length, 0, "a viewer must not send");
  assert.deepEqual(memberCalls[0], ["ws_1", { minRole: "agent" }]);
});

test("sending from an AI-active conversation sleeps the bot, scoped to the workspace", async () => {
  transitions.length = 0;
  memberResult = { ok: true, userId: "user_1", role: "agent" };
  convRow = { workspace_id: "ws_1", window_expires_at: null, ai_enabled: true };
  const res = await POST(makeReq({ body: "hola" }), params);
  assert.equal(res.status, 200);
  assert.deepEqual(transitions[0], [
    "conv_1",
    "human_active",
    { userId: "user_1", workspaceId: "ws_1" },
  ]);
  convRow = { workspace_id: "ws_1", window_expires_at: null, ai_enabled: false };
});

test("a viewer neither sends nor sleeps the bot", async () => {
  transitions.length = 0;
  dispatchCalls.length = 0;
  memberResult = {
    ok: false,
    response: NextResponse.json({ error: "Permisos insuficientes" }, { status: 403 }),
  };
  convRow = { workspace_id: "ws_1", window_expires_at: null, ai_enabled: true };
  const res = await POST(makeReq({ body: "hola" }), params);
  assert.equal(res.status, 403);
  assert.equal(dispatchCalls.length, 0);
  assert.equal(transitions.length, 0);
  convRow = { workspace_id: "ws_1", window_expires_at: null, ai_enabled: false };
});

test("an agent can send, through the conversation's own workspace", async () => {
  dispatchCalls.length = 0;
  memberResult = { ok: true, userId: "user_1", role: "agent" };
  const res = await POST(makeReq({ body: "hola" }), params);
  assert.equal(res.status, 200);
  assert.equal(dispatchCalls.length, 1);
  assert.equal(
    (dispatchCalls[0] as { workspaceId?: string }).workspaceId,
    convRow.workspace_id,
  );
});
