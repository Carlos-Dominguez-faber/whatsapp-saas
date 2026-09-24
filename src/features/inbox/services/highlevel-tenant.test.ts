import assert from "node:assert/strict";
import { test, mock, beforeEach } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

// ── In-memory tables: two tenants, only ws_a has HighLevel connected ─────────
type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {
  contacts: [
    { id: "ct_a", workspace_id: "ws_a", name: "Ana A", phone: "+15550000001", email: null, tags: [], hl_contact_id: null },
    { id: "ct_b", workspace_id: "ws_b", name: "Bea B", phone: "+15550000002", email: null, tags: [], hl_contact_id: null },
  ],
  integrations: [
    {
      workspace_id: "ws_a",
      provider: "highlevel",
      enabled: true,
      credentials: { highlevel_pit: "pit-a" },
      config: { location_id: "loc_a", pipeline_id: "pipe_a", pipeline_stage_id: "stage_a" },
    },
  ],
};

let updates: Array<{ table: string; filters: Array<[string, unknown]> }> = [];

function filtered(table: string, filters: Array<[string, unknown]>) {
  return (tables[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));
}

function selectQuery(table: string) {
  const filters: Array<[string, unknown]> = [];
  const builder: any = {
    eq(column: string, value: unknown) {
      filters.push([column, value]);
      return builder;
    },
    single: async () => {
      const r = filtered(table, filters);
      return r.length === 1
        ? { data: r[0], error: null }
        : { data: null, error: { message: "JSON object requested, multiple (or no) rows returned" } };
    },
    maybeSingle: async () => ({ data: filtered(table, filters)[0] ?? null, error: null }),
  };
  return builder;
}

function updateQuery(table: string) {
  const filters: Array<[string, unknown]> = [];
  updates.push({ table, filters });
  const builder: any = {
    eq(column: string, value: unknown) {
      filters.push([column, value]);
      return builder;
    },
    then(resolve: (v: unknown) => void) {
      resolve({ error: null });
    },
  };
  return builder;
}

const fakeClient = {
  from(table: string) {
    return {
      select: () => selectQuery(table),
      update: () => updateQuery(table),
    };
  },
};

mock.module("@supabase/supabase-js", {
  exports: { createClient: () => fakeClient },
});

mock.module("@/shared/lib/integration-secrets.ts", {
  exports: { decryptCredentials: async (creds: Row) => creds },
});

let fetches: string[] = [];
globalThis.fetch = (async (url: string) => {
  fetches.push(String(url));
  return new Response(
    JSON.stringify({ contact: { id: "hl_new" }, opportunity: { id: "opp_new" } }),
    { status: 200 },
  );
}) as typeof fetch;

const { syncContactToHL, createHLOpportunity } = await import("./highlevel-client.ts");

beforeEach(() => {
  fetches = [];
  updates = [];
});

test("syncContactToHL pushes and links a contact of the caller's own workspace", async () => {
  const result = await syncContactToHL("ws_a", "ct_a");

  assert.deepEqual(result, { hl_id: "hl_new" });
  assert.equal(fetches.length, 1);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].filters, [
    ["id", "ct_a"],
    ["workspace_id", "ws_a"],
  ]);
});

test("syncContactToHL does not read or push a contact from another workspace", async () => {
  const result = await syncContactToHL("ws_a", "ct_b");

  assert.equal(result, null);
  assert.equal(fetches.length, 0, "the foreign contact must not reach HighLevel");
  assert.equal(updates.length, 0, "the foreign contact must not be written");
});

test("createHLOpportunity links and opens an opportunity for a contact of the caller's own workspace", async () => {
  const result = await createHLOpportunity("ws_a", "ct_a");

  assert.deepEqual(result, { id: "opp_new" });
  assert.equal(fetches.length, 2);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].filters, [
    ["id", "ct_a"],
    ["workspace_id", "ws_a"],
  ]);
});

test("createHLOpportunity does not read or push a contact from another workspace", async () => {
  const result = await createHLOpportunity("ws_a", "ct_b");

  assert.equal(result, null);
  assert.equal(fetches.length, 0, "the foreign contact must not reach HighLevel");
  assert.equal(updates.length, 0, "the foreign contact must not be written");
});
