import assert from "node:assert/strict";
import { test } from "node:test";
import { isSignupOpen, markAsSuperAdmin } from "./signup-gate.ts";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

function headResponse(status: number, contentRange?: string): Response {
  const headers: Record<string, string> = {};
  if (contentRange) headers["content-range"] = contentRange;
  return new Response(null, { status, headers });
}

test("signup is open when there are zero users", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => headResponse(200, "0-0/0")) as typeof fetch;
  try {
    assert.equal(await isSignupOpen(), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("signup is closed once at least one user exists", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => headResponse(200, "0-0/1")) as typeof fetch;
  try {
    assert.equal(await isSignupOpen(), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fails closed (reports signup as closed) when the users count query errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => headResponse(500)) as typeof fetch;
  try {
    assert.equal(await isSignupOpen(), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fails closed (reports signup as closed) when the response is OK but the count header is missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => headResponse(200)) as typeof fetch; // sin content-range
  try {
    assert.equal(await isSignupOpen(), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("promotes a user to super admin via a PATCH to users", async () => {
  const originalFetch = globalThis.fetch;
  let patchedBody: unknown = null;
  let patchedUrl: string | null = null;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (init?.method === "PATCH" && String(input).includes("/rest/v1/users")) {
      patchedUrl = String(input);
      patchedBody = JSON.parse(String(init.body));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch call: ${String(input)}`);
  }) as typeof fetch;
  try {
    await markAsSuperAdmin("user_1");
    assert.deepEqual(patchedBody, { is_super_admin: true });
    // Must scope the PATCH to this exact row — otherwise every user in the
    // table gets promoted to super admin.
    assert.match(patchedUrl!, /id=eq\.user_1/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
