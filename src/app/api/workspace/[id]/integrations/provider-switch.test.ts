import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { NextRequest } from "next/server";

// PUT /api/workspace/[id]/integrations — saving a WhatsApp provider (YCloud or
// Kapso). The switch itself (disable the old row, carry the workspace settings,
// upsert the new one) happens in save_whatsapp_integration(), pinned by pgTAP;
// this covers what the route decides before calling it.

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

mock.module("@/lib/auth/workspace-access.ts", {
  exports: {
    requireWorkspaceMember: async () => ({ ok: true, userId: "user_1", role: "manager" }),
    readJsonBody: async (req: Request) => ({ ok: true, body: await req.json() }),
  },
});

let failEncrypt = false;
const encryptOrder: string[] = [];
mock.module("@/shared/lib/integration-secrets.ts", {
  exports: {
    encryptCredentials: async (c: Record<string, unknown>) => {
      encryptOrder.push("encrypt");
      if (failEncrypt) throw new Error("bad key");
      return Object.fromEntries(
        Object.entries(c).map(([k, v]) => [
          k,
          typeof v === "string" && v && !v.startsWith("enc:") ? `enc:${v}` : v,
        ]),
      );
    },
    decryptCredentials: async (c: unknown) => c ?? {},
  },
});

mock.module("@/features/inbox/services/country-code.ts", {
  exports: { workspaceCountryCode: async () => "52" },
});

type Stored = { credentials: Record<string, unknown>; config: Record<string, unknown> };
let stored: Record<string, Stored> = {};
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let upserts: Array<Record<string, unknown>> = [];
let rpcResult: { data: unknown; error: { message: string } | null } = { data: null, error: null };

const fakeSvc = {
  from: () => ({
    select: () => {
      const filters: Record<string, unknown> = {};
      const q: any = {
        eq: (c: string, v: unknown) => ((filters[c] = v), q),
        single: async () => {
          const row = stored[filters.provider as string];
          return row ? { data: row, error: null } : { data: null, error: { message: "0 rows" } };
        },
      };
      return q;
    },
    upsert: async (row: Record<string, unknown>) => {
      upserts.push(row);
      return { error: null };
    },
  }),
  rpc: async (fn: string, args: Record<string, unknown>) => {
    encryptOrder.push("rpc");
    rpcCalls.push({ fn, args });
    return rpcResult;
  },
};
mock.module("@supabase/supabase-js", { exports: { createClient: () => fakeSvc } });

const { PUT } = await import("./route.ts");
const params = { params: Promise.resolve({ id: "ws_1" }) };
const put = (body: unknown) =>
  PUT(
    new NextRequest("http://localhost/api/workspace/ws_1/integrations", {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    params,
  );

function reset() {
  failEncrypt = false;
  encryptOrder.length = 0;
  rpcCalls = [];
  upserts = [];
  rpcResult = { data: null, error: null };
  stored = {
    ycloud: {
      credentials: { ycloud_api_key: "enc:yk", webhook_signing_secret: "enc:ys" },
      config: { phone_number: "+5215550000000", message_history_window: 20 },
    },
  };
}

const KAPSO_READY = {
  provider: "kapso",
  credentials: { kapso_api_key: "kp", webhook_signing_secret: "ks" },
  config: { phone_number_id: "pn_1", waba_id: "waba_1", buffer_silence_seconds: 15 },
};

test("switching to Kapso saves it through the one-transaction RPC", async () => {
  reset();
  rpcResult = { data: "ycloud", error: null };
  const res = await put(KAPSO_READY);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.switchedFrom, "ycloud");
  assert.equal(rpcCalls.length, 1);
  const { fn, args } = rpcCalls[0];
  assert.equal(fn, "save_whatsapp_integration");
  assert.equal(args.p_workspace_id, "ws_1");
  assert.equal(args.p_provider, "kapso");
  assert.equal(args.p_enabled, true);
  assert.deepEqual(args.p_credentials, { kapso_api_key: "enc:kp", webhook_signing_secret: "enc:ks" });
  assert.deepEqual(args.p_config, KAPSO_READY.config, "only what the UI sent; the RPC merges");
  assert.ok((args.p_workspace_keys as string[]).includes("jev_enabled"));
  assert.equal(upserts.length, 0, "WhatsApp never takes the plain upsert path");
});

test("credentials are encrypted before anything is written", async () => {
  reset();
  await put(KAPSO_READY);
  assert.deepEqual(encryptOrder, ["encrypt", "rpc"]);
});

test("a failed encryption writes nothing", async () => {
  reset();
  failEncrypt = true;
  const res = await put(KAPSO_READY);
  assert.equal(res.status, 500);
  assert.equal(rpcCalls.length, 0, "the active provider is never touched");
});

test("activating a provider without its sender id is refused with 422", async () => {
  reset();
  const res = await put({ ...KAPSO_READY, config: { waba_id: "waba_1" } });
  const json = await res.json();
  assert.equal(res.status, 422);
  assert.deepEqual(json.missing, ["el Phone Number ID"]);
  assert.match(json.error, /Kapso/);
  assert.equal(rpcCalls.length, 0);
});

test("activating a provider without key or secret is refused with 422", async () => {
  reset();
  const res = await put({ provider: "kapso", config: { phone_number_id: "pn_1" } });
  assert.equal(res.status, 422);
  assert.deepEqual((await res.json()).missing, ["la API Key", "el Webhook Signing Secret"]);
  assert.equal(rpcCalls.length, 0);
});

test("masked values count as the stored ones", async () => {
  reset();
  const res = await put({
    provider: "ycloud",
    credentials: { ycloud_api_key: "••••••", webhook_signing_secret: "••••••" },
    config: { buffer_silence_seconds: 40 },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(rpcCalls[0].args.p_credentials, {
    ycloud_api_key: "enc:yk",
    webhook_signing_secret: "enc:ys",
  });
});

test("an explicitly emptied sender id is refused", async () => {
  reset();
  const res = await put({ provider: "ycloud", config: { phone_number: "" } });
  assert.equal(res.status, 422);
  assert.deepEqual((await res.json()).missing, ["el número de WhatsApp"]);
});

test("saving a provider disabled skips the check (kept for later)", async () => {
  reset();
  const res = await put({ provider: "kapso", enabled: false, credentials: { kapso_api_key: "kp" } });
  assert.equal(res.status, 200);
  assert.equal(rpcCalls[0].args.p_enabled, false);
});

test("saving the active provider again is not a switch", async () => {
  reset();
  const res = await put({ provider: "ycloud", config: { buffer_silence_seconds: 40 } });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.switchedFrom, undefined);
});

test("a failed save reports 500 (the RPC rolled everything back)", async () => {
  reset();
  rpcResult = { data: null, error: { message: "boom" } };
  const res = await put(KAPSO_READY);
  assert.equal(res.status, 500);
});

test("other integrations (OpenRouter) never touch the WhatsApp provider", async () => {
  reset();
  const res = await put({ provider: "openrouter", credentials: { openrouter_api_key: "or" }, config: {} });
  assert.equal(res.status, 200);
  assert.equal(rpcCalls.length, 0);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].provider, "openrouter");
});

// ── YCloud's number, normalized on save ──────────────────────────────────────

/** YCloud's phoneNumbers endpoint for the next PUT; null = unreachable. */
function ycloudLists(numbers: string[] | null): { keys: string[]; restore: () => void } {
  const keys: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    keys.push(String((init?.headers as Record<string, string>)?.["X-API-Key"]));
    if (!numbers) return new Response("{}", { status: 503 });
    return new Response(
      JSON.stringify({ items: numbers.map((phoneNumber) => ({ phoneNumber, wabaId: "waba_1" })) }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { keys, restore: () => (globalThis.fetch = original) };
}

async function saveYCloudPhone(phone: string) {
  const res = await put({ provider: "ycloud", config: { phone_number: phone } });
  return { status: res.status, json: await res.json(), saved: rpcCalls[0]?.args.p_config as Record<string, unknown> };
}

test("a national YCloud number the account has is saved as YCloud lists it", async () => {
  reset();
  const { keys, restore } = ycloudLists(["+15550000001", "+5219981234567"]);
  try {
    for (const typed of ["998 123 4567", "(998) 123-4567"]) {
      rpcCalls = [];
      const { status, json, saved } = await saveYCloudPhone(typed);
      assert.equal(status, 200);
      assert.equal(saved.phone_number, "+5219981234567", typed);
      assert.equal(json.phoneNumber, "+5219981234567");
      assert.equal(json.warning, undefined);
    }
  } finally {
    restore();
  }
  assert.equal(keys[0], "enc:yk", "the stored key, decrypted");
});

test("a US number typed without its 1 is matched to the account's line, not given +52", async () => {
  reset();
  const { restore } = ycloudLists(["+15551234567"]);
  try {
    const { saved } = await saveYCloudPhone("555-123-4567");
    assert.equal(saved.phone_number, "+15551234567");
  } finally {
    restore();
  }
});

test("a number with its country code is saved in E.164, with a warning if the account lacks it", async () => {
  reset();
  const { restore } = ycloudLists(["+15550000001"]);
  try {
    const { status, saved, json } = await saveYCloudPhone("0052 998 123 4567");
    assert.equal(status, 200, "a warning, never a block");
    assert.equal(saved.phone_number, "+529981234567");
    assert.match(json.warning, /No encontramos \+529981234567/);
  } finally {
    restore();
  }
});

test("a national number YCloud can't confirm is kept as typed, with how to fix it", async () => {
  reset();
  const { restore } = ycloudLists(null);
  const original = console.warn;
  console.warn = () => {};
  try {
    const { status, saved, json } = await saveYCloudPhone("998 123 4567");
    assert.equal(status, 200);
    assert.equal(saved.phone_number, "998 123 4567", "no guessed country code");
    assert.match(json.warning, /lada internacional/);
  } finally {
    console.warn = original;
    restore();
  }
});

test("a typed 1 998 123 4567 never becomes +1…: YCloud's line if listed, else kept as typed", async () => {
  reset();
  const listed = ycloudLists(["+5219981234567"]);
  try {
    const { saved, json } = await saveYCloudPhone("1 998 123 4567");
    assert.equal(saved.phone_number, "+5219981234567");
    assert.equal(json.warning, undefined);
  } finally {
    listed.restore();
  }

  reset();
  const unreachable = ycloudLists(null);
  const original = console.warn;
  console.warn = () => {};
  try {
    const { saved, json } = await saveYCloudPhone("1 998 123 4567");
    assert.equal(saved.phone_number, "1 998 123 4567");
    assert.match(json.warning, /lada internacional/);
  } finally {
    console.warn = original;
    unreachable.restore();
  }
});

test("bare digits with the workspace's code are saved in E.164 even without YCloud to confirm", async () => {
  reset();
  const { restore } = ycloudLists(null);
  const original = console.warn;
  console.warn = () => {};
  try {
    const { saved, json } = await saveYCloudPhone("5219981234567");
    assert.equal(saved.phone_number, "+5219981234567");
    assert.equal(json.warning, undefined);
  } finally {
    console.warn = original;
    restore();
  }
});
