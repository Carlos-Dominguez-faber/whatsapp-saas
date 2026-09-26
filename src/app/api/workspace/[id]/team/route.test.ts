import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { NextRequest, NextResponse } from "next/server";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

// ── Caller ───────────────────────────────────────────────────────────────────
let actorRole: "admin" | "manager" | "agent" | "viewer" = "manager";

mock.module("@/lib/auth/workspace-access.ts", {
  exports: {
    requireWorkspaceMember: async (
      _ws: string,
      opts?: { minRole?: string },
    ) => {
      const rank = { viewer: 0, agent: 1, manager: 2, admin: 3 } as const;
      if (opts?.minRole && rank[actorRole] < rank[opts.minRole as keyof typeof rank]) {
        return {
          ok: false,
          response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
        };
      }
      return { ok: true, userId: "actor", role: actorRole };
    },
    readJsonBody: async (req: NextRequest) => ({ ok: true, body: await req.json() }),
  },
});

// ── Service-role memberships table ───────────────────────────────────────────
type Membership = {
  workspace_id: string;
  user_id: string;
  role: string;
  is_active: boolean;
};
let memberships: Membership[] = [];
let writes: Array<{ kind: string; row: unknown; eqArgs?: unknown[][] }> = [];

function membershipsTable() {
  const filters: Array<(m: Membership) => boolean> = [];
  let countMode = false;
  const rows = () => memberships.filter((m) => filters.every((f) => f(m)));
  const q: any = {
    select: (_cols: string, opts?: { count?: string }) => {
      countMode = Boolean(opts?.count);
      return q;
    },
    eq: (col: string, val: unknown) => {
      filters.push((m) => (m as any)[col] === val);
      return q;
    },
    neq: (col: string, val: unknown) => {
      filters.push((m) => (m as any)[col] !== val);
      return q;
    },
    // Like PostgREST: more than one row is an error, not "the first one".
    maybeSingle: async () =>
      rows().length > 1
        ? { data: null, error: { message: "multiple rows" } }
        : { data: rows()[0] ?? null, error: null },
    then: (resolve: (v: unknown) => void) =>
      resolve(countMode ? { count: rows().length, error: null } : { data: rows(), error: null }),
  };
  return q;
}

mock.module("@supabase/supabase-js", {
  exports: {
    createClient: () => ({
      from: () => ({
        select: (cols: string, opts?: { count?: string }) =>
          membershipsTable().select(cols, opts),
        update: (row: unknown) => {
          const eqArgs: unknown[][] = [];
          writes.push({ kind: "update", row, eqArgs });
          const chain: any = {
            eq: (col: string, val: unknown) => {
              eqArgs.push([col, val]);
              return chain;
            },
            then: (r: any) => r({ error: null }),
          };
          return chain;
        },
        upsert: async (row: unknown) => {
          writes.push({ kind: "upsert", row });
          return { error: null };
        },
      }),
    }),
  },
});

mock.module("@/lib/auth/provision-user.ts", {
  exports: {
    provisionWorkspaceUser: async (_db: unknown, email: string) => ({
      userId: email === "boss@x.com" ? "u_admin" : "u_new",
      password: null,
      created: false,
    }),
  },
});

const { POST, PATCH, DELETE } = await import("./route.ts");

const params = { params: Promise.resolve({ id: "ws_1" }) };
function req(method: string, body: unknown) {
  return new NextRequest("http://localhost/api/workspace/ws_1/team", {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}
const U_ADMIN = "00000000-0000-4000-8000-00000000000a";
const U_MANAGER = "00000000-0000-4000-8000-00000000000b";
const U_AGENT = "00000000-0000-4000-8000-00000000000c";

function reset(role: typeof actorRole) {
  actorRole = role;
  writes = [];
  memberships = [
    { workspace_id: "ws_1", user_id: U_ADMIN, role: "admin", is_active: true },
    { workspace_id: "ws_1", user_id: U_MANAGER, role: "manager", is_active: true },
    { workspace_id: "ws_1", user_id: U_AGENT, role: "agent", is_active: true },
    { workspace_id: "ws_1", user_id: "u_admin", role: "admin", is_active: true },
    // Another tenant: must never count for, or leak into, ws_1's decisions.
    { workspace_id: "ws_2", user_id: U_AGENT, role: "admin", is_active: true },
    { workspace_id: "ws_2", user_id: "u_other_admin", role: "admin", is_active: true },
  ];
}

test("manager cannot promote anyone (themselves included) to admin or manager", async () => {
  reset("manager");
  for (const role of ["admin", "manager"]) {
    const res = await PATCH(req("PATCH", { userId: U_AGENT, role }), params);
    assert.equal(res.status, 403, `role ${role}`);
  }
  const self = await PATCH(req("PATCH", { userId: U_MANAGER, role: "admin" }), params);
  assert.equal(self.status, 403);
  assert.equal(writes.length, 0);
});

test("manager cannot demote or deactivate an admin", async () => {
  reset("manager");
  assert.equal((await PATCH(req("PATCH", { userId: U_ADMIN, role: "viewer" }), params)).status, 403);
  assert.equal((await PATCH(req("PATCH", { userId: U_ADMIN, is_active: false }), params)).status, 403);
  assert.equal((await DELETE(req("DELETE", { userId: U_ADMIN }), params)).status, 403);
  assert.equal(writes.length, 0);
});

test("manager can still manage agents and viewers, writing only this workspace", async () => {
  reset("manager");
  const res = await PATCH(req("PATCH", { userId: U_AGENT, role: "viewer" }), params);
  assert.equal(res.status, 200);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].eqArgs, [
    ["workspace_id", "ws_1"],
    ["user_id", U_AGENT],
  ]);
});

test("manager cannot invite an admin, nor re-invite an existing admin with a lower role", async () => {
  reset("manager");
  assert.equal(
    (await POST(req("POST", { email: "new@x.com", role: "admin" }), params)).status,
    403,
  );
  assert.equal(
    (await POST(req("POST", { email: "boss@x.com", role: "viewer" }), params)).status,
    403,
  );
  assert.equal(writes.length, 0);
  assert.equal(
    (await POST(req("POST", { email: "new@x.com", role: "agent" }), params)).status,
    200,
  );
});

test("admin can promote to admin", async () => {
  reset("admin");
  const res = await PATCH(req("PATCH", { userId: U_MANAGER, role: "admin" }), params);
  assert.equal(res.status, 200);
});

test("the last active admin cannot be demoted or deactivated", async () => {
  reset("admin");
  memberships = memberships.filter((m) => m.user_id !== "u_admin");
  assert.equal((await PATCH(req("PATCH", { userId: U_ADMIN, role: "manager" }), params)).status, 409);
  assert.equal((await DELETE(req("DELETE", { userId: U_ADMIN }), params)).status, 409);
  assert.equal(writes.length, 0);
});

test("an admin can step down while another active admin remains", async () => {
  reset("admin");
  const res = await PATCH(req("PATCH", { userId: U_ADMIN, role: "manager" }), params);
  assert.equal(res.status, 200);
});

test("unknown member → 404", async () => {
  reset("admin");
  const res = await PATCH(
    req("PATCH", { userId: "00000000-0000-4000-8000-0000000000ff", role: "agent" }),
    params,
  );
  assert.equal(res.status, 404);
});

test("an admin of another workspace does not count as ws_1's remaining admin", async () => {
  reset("admin");
  memberships = memberships.filter((m) => !(m.workspace_id === "ws_1" && m.user_id === "u_admin"));
  const res = await PATCH(req("PATCH", { userId: U_ADMIN, is_active: false }), params);
  assert.equal(res.status, 409);
  assert.equal(writes.length, 0);
});

test("the ceiling uses the target's role in THIS workspace, not in another one", async () => {
  reset("manager");
  // U_AGENT is admin in ws_2 but an agent in ws_1: a ws_1 manager may manage them.
  const res = await PATCH(req("PATCH", { userId: U_AGENT, role: "viewer" }), params);
  assert.equal(res.status, 200);
});
