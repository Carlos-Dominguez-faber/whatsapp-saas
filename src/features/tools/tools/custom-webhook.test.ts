import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { registry } from "../registry.ts";
import type { ToolContext } from "../core/tool";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

interface QueueEntry {
  data?: unknown;
  error?: unknown;
}

let responseQueue: QueueEntry[] = [];

function nextResponse(): QueueEntry {
  return responseQueue.shift() ?? { data: null, error: null };
}

function makeChain() {
  const chain: any = {
    eq() {
      return chain;
    },
    order() {
      return chain;
    },
    limit() {
      return chain;
    },
    single() {
      return Promise.resolve(nextResponse());
    },
    maybeSingle() {
      return Promise.resolve(nextResponse());
    },
  };
  return chain;
}

const fakeClient = {
  from() {
    return { select: () => makeChain() };
  },
};

mock.module("@supabase/supabase-js", {
  exports: { createClient: () => fakeClient },
});

let sslCheckError: string | null = null;
let resolvedIp: string | undefined = "8.8.8.8";
const pinnedIps: string[] = [];
mock.module("../services/ssrf-guard.ts", {
  exports: {
    validateWebhookUrl: async () => ({ error: sslCheckError, resolvedIp }),
    // Delegates to globalThis.fetch so each test can stub the network, while
    // recording which IP the request was pinned to.
    fetchPinned: async (
      url: string,
      ip: string,
      opts: { method: string; headers: Record<string, string>; body?: string },
    ) => {
      pinnedIps.push(ip);
      const res = await globalThis.fetch(url, {
        method: opts.method,
        headers: opts.headers,
        body: opts.body,
      });
      return { status: res.status, bodyText: "", truncated: false };
    },
  },
});

const { customWebhookTool } = await import("./custom-webhook.ts");

const ctx: ToolContext = { workspaceId: "ws_1", conversationId: "conv_1", contactId: "contact_1" };
const playgroundCtx: ToolContext = { workspaceId: "ws_1", conversationId: null, contactId: null };

function reset() {
  responseQueue = [];
  sslCheckError = null;
  resolvedIp = "8.8.8.8";
  pinnedIps.length = 0;
}

// ──────────────────────────────────────────────────────────────────────────────
// customWebhookTool.run() in isolation — config lookup, SSRF gate, payload
// resolution. These call `.run()` directly and do NOT exercise the real
// production dispatch path: see the "registry.run() production gate" test
// below for what actually happens when this tool is invoked for real.
// ──────────────────────────────────────────────────────────────────────────────

test("returns an error when no webhook_url is configured", async () => {
  reset();
  responseQueue = [
    { data: { id: "tool_1" }, error: null }, // tools lookup
    { data: { config: {} }, error: null }, // tool_configs lookup — no webhook_url
  ];
  const result = await customWebhookTool.run({}, ctx);
  assert.deepEqual(result, { ok: false, output: null, error: "No webhook URL configured" });
});

test("returns the SSRF validation error and never calls fetch when the URL fails validation", async () => {
  reset();
  sslCheckError = "Cannot resolve hostname";
  responseQueue = [
    { data: { id: "tool_1" }, error: null },
    { data: { config: { webhook_url: "https://blocked.invalid/hook" } }, error: null },
  ];
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const result = await customWebhookTool.run({}, ctx);
    assert.deepEqual(result, { ok: false, output: null, error: "Cannot resolve hostname" });
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("posts the default payload shape when no payload_fields are configured", async () => {
  reset();
  responseQueue = [
    { data: { id: "tool_1" }, error: null },
    { data: { config: { webhook_url: "https://hooks.example/wh" } }, error: null },
    { data: { name: "Ana", phone: "+15550000001", email: "ana@example.com" }, error: null }, // contacts
    { data: { body: "hola, tengo una consulta" }, error: null }, // last inbound message
    { data: { structured: { name: "Mi Negocio" } }, error: null }, // business_info
  ];
  const originalFetch = globalThis.fetch;
  let capturedBody: unknown;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const result = await customWebhookTool.run({ note: "urgente" }, ctx);
    assert.equal(result.ok, true);
    assert.deepEqual(result.output, { status: 200 });
    assert.deepEqual(capturedBody, {
      workspace_id: "ws_1",
      payload: {
        contact_name: "Ana",
        contact_phone: "+15550000001",
        last_user_message: "hola, tengo una consulta",
        note: "urgente",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pins the request to the IP that validateWebhookUrl resolved (no second DNS lookup)", async () => {
  reset();
  resolvedIp = "93.184.216.34";
  responseQueue = [
    { data: { id: "tool_1" }, error: null },
    { data: { config: { webhook_url: "https://hooks.example/wh" } }, error: null },
    { data: null, error: null }, // contacts
    { data: null, error: null }, // last inbound message
    { data: null, error: null }, // business_info
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
  try {
    const result = await customWebhookTool.run({}, ctx);
    assert.equal(result.ok, true);
    assert.deepEqual(pinnedIps, ["93.184.216.34"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refuses to send when validation returns no resolved IP to pin to", async () => {
  reset();
  resolvedIp = undefined;
  responseQueue = [
    { data: { id: "tool_1" }, error: null },
    { data: { config: { webhook_url: "https://hooks.example/wh" } }, error: null },
  ];
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const result = await customWebhookTool.run({}, ctx);
    assert.equal(result.ok, false);
    assert.equal(fetchCalled, false);
    assert.equal(pinnedIps.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("skips the contacts lookup in the test-chat playground (contactId: null)", async () => {
  reset();
  responseQueue = [
    { data: { id: "tool_1" }, error: null },
    { data: { config: { webhook_url: "https://hooks.example/wh" } }, error: null },
    { data: { body: "hola" }, error: null }, // last inbound message (no contacts entry queued)
    { data: null, error: null }, // business_info
  ];
  const originalFetch = globalThis.fetch;
  let capturedBody: unknown;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const result = await customWebhookTool.run({}, playgroundCtx);
    assert.equal(result.ok, true);
    assert.deepEqual(capturedBody, {
      workspace_id: "ws_1",
      payload: { contact_name: "", contact_phone: "", last_user_message: "hola", note: "" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns ok:false with the HTTP status when the webhook responds with an error", async () => {
  reset();
  responseQueue = [
    { data: { id: "tool_1" }, error: null },
    { data: { config: { webhook_url: "https://hooks.example/wh" } }, error: null },
    { data: null, error: null },
    { data: null, error: null },
    { data: null, error: null },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;
  try {
    const result = await customWebhookTool.run({}, ctx);
    assert.deepEqual(result, { ok: false, output: { status: 500 }, error: "HTTP 500" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolves a configured payload field's {{token}} against the loaded variable values", async () => {
  reset();
  responseQueue = [
    { data: { id: "tool_1" }, error: null },
    {
      data: {
        config: {
          webhook_url: "https://hooks.example/wh",
          payload_fields: [{ key: "cliente", value: "{{contact.name}} ({{contact.phone}})" }],
        },
      },
      error: null,
    },
    { data: { name: "Ana", phone: "+15550000001", email: null }, error: null },
    { data: null, error: null },
    { data: null, error: null },
  ];
  const originalFetch = globalThis.fetch;
  let capturedBody: unknown;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await customWebhookTool.run({}, ctx);
    assert.deepEqual((capturedBody as { payload: unknown }).payload, {
      cliente: "Ana (+15550000001)",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// registry.run() production gate — the real dispatch path (see registry.ts:119
// and openrouter.ts, which calls registry.run() from the tool-calling loop, not
// customWebhookTool.run() directly). custom_webhook is marked `sensitivity:
// "sensitive"` (custom-webhook.ts:151), so registry.run() short-circuits BEFORE
// calling `.run()` and returns requiresConfirmation instead (registry.ts:120-129).
// There is currently no consumer anywhere in the codebase that acts on
// requiresConfirmation and re-invokes `.run()` — so today this tool never
// actually reaches the network in production. This test pins that (limited)
// reality down instead of the tests above accidentally implying otherwise.
// ──────────────────────────────────────────────────────────────────────────────

test("registry.run() gates custom_webhook behind sensitive-tool confirmation and never reaches the network", async () => {
  reset();
  registry.register(customWebhookTool);

  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    const result = await registry.run("custom_webhook", {}, ctx);
    assert.deepEqual(result, {
      ok: false,
      output: null,
      requiresConfirmation: true,
      error: "Sensitive tool requires human approval before execution",
    });
    assert.equal(
      fetchCalled,
      false,
      "a sensitive tool must never POST via registry.run() without a confirmation consumer",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
