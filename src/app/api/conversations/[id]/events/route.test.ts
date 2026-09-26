import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { NextRequest } from "next/server";

type ConvRow = { id: string; workspace_id: string } | null;
let currentUser: { id: string } | null = { id: "user_1" };
let convRow: ConvRow = { id: "conv_1", workspace_id: "ws_2" };
// Role of the caller in the conversation's workspace; null = not an active member.
let memberRole: string | null = "manager";
const membershipFilters: unknown[][] = [];

const membershipChain: any = {
  eq: (...args: unknown[]) => {
    membershipFilters.push(args);
    return membershipChain;
  },
  maybeSingle: async () => ({
    data: memberRole ? { role: memberRole } : null,
    error: null,
  }),
};

const fakeSupabase = {
  auth: { getUser: async () => ({ data: { user: currentUser }, error: null }) },
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

let reads = 0;
mock.module("@/features/inbox/services/observability.ts", {
  exports: {
    getConversationMetrics: async () => {
      reads++;
      return { turns: 1 };
    },
    getConversationEvents: async () => {
      reads++;
      return [];
    },
  },
});

const { GET } = await import("./route.ts");

const req = () => new NextRequest("http://localhost/api/conversations/conv_1/events");
const params = { params: Promise.resolve({ id: "conv_1" }) };

function reset() {
  currentUser = { id: "user_1" };
  convRow = { id: "conv_1", workspace_id: "ws_2" };
  memberRole = "manager";
  membershipFilters.length = 0;
  reads = 0;
}

test("a manager reads the events of a conversation in any of their workspaces", async () => {
  reset();
  const res = await GET(req(), params);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { metrics: { turns: 1 }, events: [] });
  // The role is checked in the conversation's own workspace, not a first membership.
  assert.ok(membershipFilters.some(([col, val]) => col === "workspace_id" && val === "ws_2"));
});

test("403 for an agent or a viewer, without reading events (events_select is admin/manager)", async () => {
  for (const role of ["agent", "viewer"]) {
    reset();
    memberRole = role;
    const res = await GET(req(), params);
    assert.equal(res.status, 403, role);
    assert.equal(reads, 0, role);
  }
});

test("404 when RLS hides the conversation", async () => {
  reset();
  convRow = null;
  const res = await GET(req(), params);
  assert.equal(res.status, 404);
  assert.equal(reads, 0);
});

test("401 without a session", async () => {
  reset();
  currentUser = null;
  const res = await GET(req(), params);
  assert.equal(res.status, 401);
});
