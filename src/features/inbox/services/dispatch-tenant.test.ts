import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

// ── In-memory tables: two tenants, each with its own conversation ────────────
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
      workspace_id: "ws_a",
      provider: "ycloud",
      enabled: true,
      credentials: { ycloud_api_key: "test-key-a" },
      config: { phone_number: "+15559999999" },
    },
  ],
};

let inserted: Array<{ table: string; row: Row }> = [];

function query(table: string) {
  const filters: Array<[string, unknown]> = [];
  const rows = () =>
    (tables[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));
  const builder: any = {
    select: () => builder,
    eq(column: string, value: unknown) {
      filters.push([column, value]);
      return builder;
    },
    single: async () => {
      const r = rows();
      return r.length === 1
        ? { data: r[0], error: null }
        : { data: null, error: { message: "JSON object requested, multiple (or no) rows returned" } };
    },
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
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
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    };
  },
};

mock.module("@supabase/supabase-js", {
  exports: { createClient: () => fakeClient },
});

mock.module("@/shared/lib/integration-secrets.ts", {
  exports: { decryptCredentials: async (creds: Row) => creds },
});

let sends: Array<{ kind: string; to: string }> = [];
mock.module("./ycloud-client.ts", {
  exports: {
    YCloudError: class YCloudError extends Error {},
    sendText: async (p: { to: string }) => {
      sends.push({ kind: "text", to: p.to });
      return { id: "yc_text", wamid: "wamid_text" };
    },
    sendTemplate: async (p: { to: string }) => {
      sends.push({ kind: "template", to: p.to });
      return { wamid: "wamid_tpl" };
    },
  },
});

const { dispatchText, dispatchTemplate } = await import("./dispatch.ts");

function reset() {
  inserted = [];
  sends = [];
  (tables.contacts[0] as Row).opt_in = true;
}

test("dispatchTemplate: own conversation sends to its contact and persists the message", async () => {
  reset();
  const res = await dispatchTemplate({
    workspaceId: "ws_a",
    conversationId: "conv_a",
    templateName: "welcome",
  });
  assert.equal(res.ok, true);
  assert.deepEqual(sends, [{ kind: "template", to: "+15550000001" }]);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0]?.row.workspace_id, "ws_a");
});

test("dispatchTemplate: a conversation from another workspace is not sent nor persisted", async () => {
  reset();
  const res = await dispatchTemplate({
    workspaceId: "ws_a",
    conversationId: "conv_b",
    templateName: "welcome",
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, "CONVERSATION_NOT_FOUND");
  assert.equal(sends.length, 0);
  assert.equal(inserted.length, 0);
});

test("dispatchText: own conversation sends and persists", async () => {
  reset();
  const res = await dispatchText({
    workspaceId: "ws_a",
    conversationId: "conv_a",
    body: "hola",
  });
  assert.equal(res.ok, true);
  assert.deepEqual(sends, [{ kind: "text", to: "+15550000001" }]);
  assert.equal(inserted.length, 1);
});

test("dispatchText: a conversation from another workspace is not sent nor persisted", async () => {
  reset();
  const res = await dispatchText({
    workspaceId: "ws_a",
    conversationId: "conv_b",
    body: "hola",
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, "CONVERSATION_NOT_FOUND");
  assert.equal(sends.length, 0);
  assert.equal(inserted.length, 0);
});

test("dispatchText: an opted-out contact is not sent to", async () => {
  reset();
  (tables.contacts[0] as Row).opt_in = false;
  const res = await dispatchText({
    workspaceId: "ws_a",
    conversationId: "conv_a",
    body: "hola",
  });
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /^OPT_OUT/);
  assert.equal(sends.length, 0);
  assert.equal(inserted.length, 0);
});
