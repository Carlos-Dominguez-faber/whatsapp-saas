import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { NextResponse } from "next/server";

mock.module("next/headers", {
  exports: { cookies: async () => ({ getAll: () => [], set: () => {} }) },
});

type FakeUser = { id: string } | null;
type FakeMember = { role: string } | null;

function fakeSupabase(opts: {
  user: FakeUser;
  member?: FakeMember;
  eqCalls?: Array<[string, unknown]>;
}) {
  return {
    auth: { getUser: async () => ({ data: { user: opts.user } }) },
    from: () => ({
      select: () => ({
        eq(column: string, value: unknown) {
          opts.eqCalls?.push([column, value]);
          return this;
        },
        maybeSingle: async () => ({ data: opts.member ?? null }),
      }),
    }),
  };
}

let currentClient: ReturnType<typeof fakeSupabase>;
mock.module("@supabase/ssr", {
  exports: { createServerClient: () => currentClient },
});

const { requireWorkspaceMember, checkWorkspaceMember, readJsonBody } =
  await import("./workspace-access.ts");

test("401s when there is no authenticated user", async () => {
  currentClient = fakeSupabase({ user: null });
  const result = await requireWorkspaceMember("ws_1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.response.status, 401);
});

test("403s when the user is not an active member of the workspace", async () => {
  currentClient = fakeSupabase({ user: { id: "u1" }, member: null });
  const result = await requireWorkspaceMember("ws_1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.response.status, 403);
});

test("403s when the member's role is below the required minRole", async () => {
  currentClient = fakeSupabase({ user: { id: "u1" }, member: { role: "viewer" } });
  const result = await requireWorkspaceMember("ws_1", { minRole: "manager" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.response.status, 403);
});

test("succeeds when the member is active and meets minRole", async () => {
  const eqCalls: Array<[string, unknown]> = [];
  currentClient = fakeSupabase({
    user: { id: "u1" },
    member: { role: "admin" },
    eqCalls,
  });
  const result = await requireWorkspaceMember("ws_1", { minRole: "manager" });
  assert.deepEqual(result, { ok: true, userId: "u1", role: "admin" });
  // Anti-IDOR: the membership query must be scoped by all three filters —
  // dropping any one (especially user_id) would let a caller read another
  // user's membership row for this workspace.
  assert.deepEqual(eqCalls, [
    ["workspace_id", "ws_1"],
    ["user_id", "u1"],
    ["is_active", true],
  ]);
});

test("succeeds with no minRole as long as the member is active", async () => {
  currentClient = fakeSupabase({ user: { id: "u1" }, member: { role: "viewer" } });
  const result = await requireWorkspaceMember("ws_1");
  assert.deepEqual(result, { ok: true, userId: "u1", role: "viewer" });
});

test("denies access when the membership role is not a recognized WorkspaceRole (unmapped/typo role)", async () => {
  currentClient = fakeSupabase({ user: { id: "u1" }, member: { role: "owner" } });
  const result = await requireWorkspaceMember("ws_1", { minRole: "manager" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.response.status, 403);
});

test("denies access when the membership role is unrecognized even without a minRole requirement", async () => {
  currentClient = fakeSupabase({ user: { id: "u1" }, member: { role: "owner" } });
  const result = await requireWorkspaceMember("ws_1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.response.status, 403);
});

test("denies access when minRole itself is not a recognized WorkspaceRole (defensive: bypasses TypeScript)", async () => {
  currentClient = fakeSupabase({ user: { id: "u1" }, member: { role: "admin" } });
  const result = await requireWorkspaceMember("ws_1", {
    minRole: "owner" as unknown as import("./workspace-access.ts").WorkspaceRole,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.response.status, 403);
});

test("denies access when the membership role is 'constructor' (prototype-chain bypass of ROLE_RANK)", async () => {
  currentClient = fakeSupabase({ user: { id: "u1" }, member: { role: "constructor" } });
  const result = await requireWorkspaceMember("ws_1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.response.status, 403);
});

test("readJsonBody returns the parsed body on valid JSON", async () => {
  const req = new Request("https://example.com", {
    method: "POST",
    body: JSON.stringify({ foo: "bar" }),
  });
  const result = await readJsonBody<{ foo: string }>(req);
  assert.deepEqual(result, { ok: true, body: { foo: "bar" } });
});

test("readJsonBody returns a 400 response on malformed JSON", async () => {
  const req = new Request("https://example.com", {
    method: "POST",
    body: "not json",
  });
  const result = await readJsonBody(req);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.response.status, 400);
});

test("checkWorkspaceMember: succeeds with userId/role for an active member meeting minRole", async () => {
  currentClient = fakeSupabase({ user: { id: "u1" }, member: { role: "admin" } });
  const result = await checkWorkspaceMember("ws_1", { minRole: "manager" });
  assert.deepEqual(result, { ok: true, userId: "u1", role: "admin" });
});

test("checkWorkspaceMember: returns status 403 with reason 'not_member' when there's no membership row", async () => {
  currentClient = fakeSupabase({ user: { id: "u1" }, member: null });
  const result = await checkWorkspaceMember("ws_1");
  assert.deepEqual(result, { ok: false, status: 403, reason: "not_member" });
});

test("checkWorkspaceMember: returns status 403 with reason 'insufficient_role' when below minRole", async () => {
  currentClient = fakeSupabase({ user: { id: "u1" }, member: { role: "viewer" } });
  const result = await checkWorkspaceMember("ws_1", { minRole: "manager" });
  assert.deepEqual(result, {
    ok: false,
    status: 403,
    reason: "insufficient_role",
  });
});

test("checkWorkspaceMember: returns status 401 with no reason when unauthenticated", async () => {
  currentClient = fakeSupabase({ user: null });
  const result = await checkWorkspaceMember("ws_1");
  assert.deepEqual(result, { ok: false, status: 401 });
});

test("NextResponse import resolves under node --test (sanity check for the alias/next.js hook)", () => {
  assert.equal(typeof NextResponse.json, "function");
});
