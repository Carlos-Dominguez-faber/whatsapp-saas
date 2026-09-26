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
