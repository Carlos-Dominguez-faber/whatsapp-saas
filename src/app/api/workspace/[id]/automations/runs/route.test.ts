import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { NextRequest, NextResponse } from "next/server";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

type Member = { ok: true; userId: string; role: string } | { ok: false; response: NextResponse };
let member: Member = { ok: true, userId: "user_1", role: "manager" };
const checks: Array<string | undefined> = [];
mock.module("@/lib/auth/workspace-access.ts", {
  exports: {
    requireWorkspaceMember: async (_ws: string, opts?: { minRole?: string }) => {
      checks.push(opts?.minRole);
      return member;
    },
  },
});

const filters: Array<[string, ...unknown[]]> = [];
let rows: unknown[] = [{ id: "r1", status: "failed", created_at: "2026-10-01T00:00:00Z" }];
const q: any = {
  select: () => q,
  eq: (c: string, v: unknown) => (filters.push(["eq", c, v]), q),
  in: () => q,
  or: (f: string) => (filters.push(["or", f]), q),
  order: () => q,
  limit: async () => ({ data: rows, error: null }),
};
mock.module("@supabase/supabase-js", { exports: { createClient: () => ({ from: () => q }) } });

const { GET } = await import("./route.ts");
const get = (qs = "") =>
  GET(new NextRequest(`http://localhost/api/workspace/ws_1/automations/runs${qs}`), {
    params: Promise.resolve({ id: "ws_1" }),
  });

test("admins and managers read the workspace's runs", async () => {
  member = { ok: true, userId: "user_1", role: "manager" };
  filters.length = 0;
  const res = await get("?status=failed");
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).runs, rows);
  assert.equal(checks.at(-1), "manager");
  assert.ok(filters.some(([k, c, v]) => k === "eq" && c === "workspace_id" && v === "ws_1"));
});

test("below manager the route refuses before reading anything", async () => {
  member = { ok: false, response: NextResponse.json({ error: "Permisos insuficientes" }, { status: 403 }) };
  filters.length = 0;
  const res = await get();
  assert.equal(res.status, 403);
  assert.equal(filters.length, 0);
});

test("a malformed cursor is ignored, not passed into the filter", async () => {
  member = { ok: true, userId: "user_1", role: "admin" };
  filters.length = 0;
  await get("?before=2026-10-01T00:00:00Z),id.gt.(0&beforeId=x");
  assert.ok(!filters.some(([k]) => k === "or"));
});
