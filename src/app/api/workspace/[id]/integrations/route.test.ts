import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { NextRequest, NextResponse } from "next/server";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

const memberCalls: unknown[] = [];
let memberResult: unknown = { ok: true, userId: "user_1", role: "manager" };
mock.module("@/lib/auth/workspace-access.ts", {
  exports: {
    requireWorkspaceMember: async (...args: unknown[]) => {
      memberCalls.push(args);
      return memberResult;
    },
    readJsonBody: async (req: Request) => ({ ok: true, body: await req.json() }),
  },
});

// The stored row the PUT merges into, and what it upserts.
let existingRow: { credentials: object; config: object; oauth_tokens: object } | null = null;
const upserts: unknown[] = [];
const fakeSvc = {
  from: () => ({
    select: () => {
      const chain: any = {
        eq: () => chain,
        single: async () => ({ data: existingRow, error: existingRow ? null : { message: "0 rows" } }),
        then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
      };
      return chain;
    },
    upsert: async (row: unknown) => {
      upserts.push(row);
      return { error: null };
    },
  }),
};
mock.module("@supabase/supabase-js", {
  exports: { createClient: () => fakeSvc },
});

const { GET, PUT } = await import("./route.ts");
const params = { params: Promise.resolve({ id: "ws_1" }) };
const req = new NextRequest("http://localhost/api/workspace/ws_1/integrations");

test("GET requires the manager role", async () => {
  memberCalls.length = 0;
  memberResult = { ok: true, userId: "user_1", role: "manager" };
  const res = await GET(req, params);
  assert.equal(res.status, 200);
  assert.deepEqual(memberCalls[0], ["ws_1", { minRole: "manager" }]);
});

test("GET returns the 403 from the membership helper for a viewer", async () => {
  memberResult = {
    ok: false,
    response: NextResponse.json({ error: "Permisos insuficientes" }, { status: 403 }),
  };
  const res = await GET(req, params);
  assert.equal(res.status, 403);
});

test("PUT asks the membership helper for the admin role (integrations_write_admins)", async () => {
  memberCalls.length = 0;
  memberResult = {
    ok: false,
    response: NextResponse.json({ error: "Permisos insuficientes" }, { status: 403 }),
  };
  const putReq = new NextRequest("http://localhost/api/workspace/ws_1/integrations", {
    method: "PUT",
    body: JSON.stringify({ provider: "ycloud", credentials: { api_key: "k" } }),
  });
  const res = await PUT(putReq, params);
  // A manager gets the helper's 403 and nothing is written.
  assert.equal(res.status, 403);
  assert.deepEqual(memberCalls[0], ["ws_1", { minRole: "admin" }]);
});

function putOpenRouter(config: Record<string, unknown>) {
  return PUT(
    new NextRequest("http://localhost/api/workspace/ws_1/integrations", {
      method: "PUT",
      body: JSON.stringify({ provider: "openrouter", config }),
    }),
    params,
  );
}

test("PUT refuses an OpenRouter model outside the catalog", async () => {
  memberResult = { ok: true, userId: "user_1", role: "admin" };
  existingRow = null;
  upserts.length = 0;
  const res = await putOpenRouter({ default_model: "some/unlisted-model" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /catálogo/);
  assert.equal(upserts.length, 0);
});

test("PUT accepts a catalog model, and an older stored model sent back unchanged", async () => {
  memberResult = { ok: true, userId: "user_1", role: "admin" };
  existingRow = { credentials: {}, config: { default_model: "legacy/model-x" }, oauth_tokens: {} };
  upserts.length = 0;
  const res = await putOpenRouter({ default_model: "legacy/model-x", fallback_model: "openai/gpt-4.1" });
  assert.equal(res.status, 200);
  assert.equal(upserts.length, 1);

  const changed = await putOpenRouter({ default_model: "legacy/model-y" });
  assert.equal(changed.status, 400);
});

test("PUT also checks the legacy `model` key the workspace default can come from", async () => {
  memberResult = { ok: true, userId: "user_1", role: "admin" };
  existingRow = { credentials: {}, config: {}, oauth_tokens: {} };
  upserts.length = 0;
  const res = await putOpenRouter({ model: "some/unlisted-model" });
  assert.equal(res.status, 400);
  assert.equal(upserts.length, 0);
});
