import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { NextRequest } from "next/server";

// ── Fakes ────────────────────────────────────────────────────────────────────
type ConvRow = { workspace_id: string } | null;
let currentUser: { id: string } | null = { id: "user_1" };
let convRow: ConvRow = { workspace_id: "ws_1" };

const fakeSupabase = {
  auth: { getUser: async () => ({ data: { user: currentUser } }) },
  from: () => ({
    select: () => ({
      eq: () => ({
        single: async () =>
          convRow
            ? { data: convRow, error: null }
            : { data: null, error: { message: "0 rows" } },
      }),
    }),
  }),
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
