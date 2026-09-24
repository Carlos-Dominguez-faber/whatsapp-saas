import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { NextRequest, NextResponse } from "next/server";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

const RAW = 'duplicate key value violates unique constraint "users_email_key"';

let provisionImpl: () => Promise<{ userId: string; password?: string }> = async () => ({
  userId: "user_new",
  password: "x",
});
let upsertError: { message: string } | null = null;

mock.module("@/lib/auth/workspace-access.ts", {
  exports: {
    requireWorkspaceMember: async () => ({ ok: true, userId: "user_1", role: "admin" }),
    readJsonBody: async (req: Request) => {
      try {
        return { ok: true, body: await req.json() };
      } catch {
        return { ok: false, response: NextResponse.json({ error: "JSON inválido" }, { status: 400 }) };
      }
    },
  },
});
mock.module("@/lib/auth/provision-user.ts", {
  exports: { provisionWorkspaceUser: () => provisionImpl() },
});
mock.module("@supabase/supabase-js", {
  exports: {
    createClient: () => ({
      from: () => ({ upsert: async () => ({ error: upsertError }) }),
    }),
  },
});

const { POST } = await import("./route.ts");

const params = { params: Promise.resolve({ id: "ws_1" }) };
function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/workspace/ws_1/team", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

let errorLogs: unknown[][] = [];
const originalError = console.error;
function reset() {
  provisionImpl = async () => ({ userId: "user_new", password: "x" });
  upsertError = null;
  errorLogs = [];
  console.error = (...args: unknown[]) => {
    errorLogs.push(args);
  };
}
function restore() {
  console.error = originalError;
}

test("POST provisions the user and returns the credentials", async () => {
  reset();
  try {
    const res = await POST(postReq({ email: "ana@example.com", role: "agent" }), params);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      credentials: { email: "ana@example.com", password: "x" },
    });
  } finally {
    restore();
  }
});

test("POST rejects an invalid email with 400", async () => {
  reset();
  try {
    const res = await POST(postReq({ email: "no-es-correo", role: "agent" }), params);
    assert.equal(res.status, 400);
  } finally {
    restore();
  }
});

test("POST hides the provisioning error from the body and logs it", async () => {
  reset();
  provisionImpl = async () => {
    throw new Error(RAW);
  };
  try {
    const res = await POST(postReq({ email: "ana@example.com", role: "agent" }), params);
    assert.equal(res.status, 400);
    const body = JSON.stringify(await res.json());
    assert.ok(!body.includes(RAW), `raw error leaked: ${body}`);
    assert.ok(errorLogs.some((a) => a.map(String).join(" ").includes(RAW)));
  } finally {
    restore();
  }
});

test("POST hides the membership upsert error from the body and logs it", async () => {
  reset();
  upsertError = { message: RAW };
  try {
    const res = await POST(postReq({ email: "ana@example.com", role: "agent" }), params);
    assert.equal(res.status, 500);
    const body = JSON.stringify(await res.json());
    assert.ok(!body.includes(RAW), `raw error leaked: ${body}`);
    assert.ok(errorLogs.some((a) => a.map(String).join(" ").includes(RAW)));
  } finally {
    restore();
  }
});
