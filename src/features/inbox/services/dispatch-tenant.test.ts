import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

// ── In-memory tables: two tenants on DIFFERENT WhatsApp providers ────────────
// ws_a talks through YCloud, ws_b through Kapso; ws_b also keeps a disabled
// YCloud row from before it switched, which must never be used.
type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {
  conversations: [
    { id: "conv_a", workspace_id: "ws_a", contact_id: "ct_a", window_expires_at: null },
    { id: "conv_b", workspace_id: "ws_b", contact_id: "ct_b", window_expires_at: null },
  ],
  contacts: [
    { id: "ct_a", workspace_id: "ws_a", phone: "+15550000001", opt_in: true },
    { id: "ct_b", workspace_id: "ws_b", phone: "+15550000002", opt_in: true },
  ],
  integrations: [
    {
      id: "int_a",
      workspace_id: "ws_a",
      provider: "ycloud",
      enabled: true,
      credentials: { ycloud_api_key: "yc-key-a" },
      config: { phone_number: "+15559999999" },
    },
    {
      id: "int_b_old",
      workspace_id: "ws_b",
      provider: "ycloud",
      enabled: false,
      credentials: { ycloud_api_key: "yc-key-b-old" },
      config: { phone_number: "+15558888888" },
    },
    {
      id: "int_b",
      workspace_id: "ws_b",
      provider: "kapso",
      enabled: true,
      credentials: { kapso_api_key: "kp-key-b" },
      config: { phone_number_id: "pn_b" },
    },
  ],
};

let inserted: Array<{ table: string; row: Row }> = [];

function query(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const builder: any = {
    select: () => builder,
    eq(column: string, value: unknown) {
      filters.push((r) => r[column] === value);
      return builder;
    },
    in(column: string, values: unknown[]) {
      filters.push((r) => values.includes(r[column]));
      return builder;
    },
    single: async () => {
      const r = rows();
      return r.length === 1
        ? { data: r[0], error: null }
        : { data: null, error: { message: "JSON object requested, multiple (or no) rows returned" } };
    },
    maybeSingle: async () => {
      const r = rows();
      return r.length > 1
        ? { data: null, error: { message: "multiple rows" } }
        : { data: r[0] ?? null, error: null };
    },
    then(resolve: (v: unknown) => void) {
      resolve({ data: rows(), error: null });
    },
  };
  return builder;
}

const fakeClient = {
  from(table: string) {
    return {
      select: () => query(table),
      insert(row: Row) {
        inserted.push({ table, row });
        return Promise.resolve({ error: null });
      },
      update: () => {
        const chain: any = { eq: () => chain, then: (r: any) => r({ error: null }) };
        return chain;
      },
    };
  },
};

mock.module("@supabase/supabase-js", {
  exports: { createClient: () => fakeClient },
});

mock.module("@/shared/lib/integration-secrets.ts", {
  exports: { decryptCredentials: async (creds: Row) => creds ?? {} },
});

let sends: Array<Record<string, unknown>> = [];
mock.module("./ycloud-client.ts", {
  exports: {
    YCloudError: class YCloudError extends Error {},
    sendText: async (p: Record<string, unknown>) => {
      sends.push({ provider: "ycloud", kind: "text", ...p });
      return { id: "yc_text", wamid: "wamid_text" };
    },
    sendTemplate: async (p: Record<string, unknown>) => {
      sends.push({ provider: "ycloud", kind: "template", ...p });
      return { id: "yc_tpl", wamid: "wamid_tpl" };
    },
  },
});
mock.module("./kapso-client.ts", {
  exports: {
    KapsoError: class KapsoError extends Error {},
    sendText: async (p: Record<string, unknown>) => {
      sends.push({ provider: "kapso", kind: "text", ...p });
      return { id: "kp_text", wamid: "wamid_k_text" };
    },
    sendTemplate: async (p: Record<string, unknown>) => {
      sends.push({ provider: "kapso", kind: "template", ...p });
      return { id: "kp_tpl", wamid: "wamid_k_tpl" };
    },
  },
});

const { dispatchText, dispatchTemplate } = await import("./dispatch.ts");

function reset() {
  inserted = [];
  sends = [];
  (tables.contacts[0] as Row).opt_in = true;
}

test("a YCloud workspace sends through YCloud, from its E.164 number", async () => {
  reset();
  const res = await dispatchText({ workspaceId: "ws_a", conversationId: "conv_a", body: "hola" });
  assert.equal(res.ok, true);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].provider, "ycloud");
  assert.equal(sends[0].from, "+15559999999");
  assert.equal(sends[0].apiKey, "yc-key-a");
  assert.equal(sends[0].to, "+15550000001");
  assert.equal((inserted[0].row.meta as Row).ycloud_id, "yc_text");
});

test("a Kapso workspace sends through Kapso with its phone_number_id, never its old YCloud row", async () => {
  reset();
  const res = await dispatchText({ workspaceId: "ws_b", conversationId: "conv_b", body: "hola" });
  assert.equal(res.ok, true);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].provider, "kapso");
  assert.equal(sends[0].phoneNumberId, "pn_b");
  assert.equal(sends[0].apiKey, "kp-key-b");
  assert.equal(inserted[0].row.wamid, "wamid_k_text");
  assert.equal((inserted[0].row.meta as Row).ycloud_id, undefined);
});

test("templates follow the workspace's provider too", async () => {
  reset();
  await dispatchTemplate({ workspaceId: "ws_a", conversationId: "conv_a", templateName: "welcome" });
  await dispatchTemplate({ workspaceId: "ws_b", conversationId: "conv_b", templateName: "welcome" });
  assert.deepEqual(
    sends.map((s) => [s.provider, s.kind]),
    [
      ["ycloud", "template"],
      ["kapso", "template"],
    ],
  );
  assert.deepEqual(
    inserted.map((i) => i.row.workspace_id),
    ["ws_a", "ws_b"],
  );
});

test("a conversation from another workspace is not sent nor persisted", async () => {
  reset();
  const text = await dispatchText({ workspaceId: "ws_a", conversationId: "conv_b", body: "hola" });
  const tpl = await dispatchTemplate({ workspaceId: "ws_a", conversationId: "conv_b", templateName: "welcome" });
  assert.equal(text.error, "CONVERSATION_NOT_FOUND");
  assert.equal(tpl.error, "CONVERSATION_NOT_FOUND");
  assert.equal(sends.length, 0);
  assert.equal(inserted.length, 0);
});

test("an opted-out contact is not sent to", async () => {
  reset();
  (tables.contacts[0] as Row).opt_in = false;
  const res = await dispatchText({ workspaceId: "ws_a", conversationId: "conv_a", body: "hola" });
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /^OPT_OUT/);
  assert.equal(sends.length, 0);
  assert.equal(inserted.length, 0);
});

test("a workspace without an active WhatsApp provider fails loudly", async () => {
  reset();
  tables.conversations.push({ id: "conv_c", workspace_id: "ws_c", contact_id: "ct_c", window_expires_at: null });
  tables.contacts.push({ id: "ct_c", workspace_id: "ws_c", phone: "+15550000003", opt_in: true });
  await assert.rejects(
    () => dispatchText({ workspaceId: "ws_c", conversationId: "conv_c", body: "hola" }),
    /WhatsApp integration not found/,
  );
  assert.equal(sends.length, 0);
});
