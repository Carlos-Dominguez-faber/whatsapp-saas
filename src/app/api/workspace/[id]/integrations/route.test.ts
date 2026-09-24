import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { NextRequest, NextResponse } from "next/server";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

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

const fakeSvc = {
  from: () => ({
    select: () => ({
      eq: async () => ({ data: [], error: null }),
    }),
  }),
};
mock.module("@supabase/supabase-js", {
  exports: { createClient: () => fakeSvc },
});

const { GET } = await import("./route.ts");
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
