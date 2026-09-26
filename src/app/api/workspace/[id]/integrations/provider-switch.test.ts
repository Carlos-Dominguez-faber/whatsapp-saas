import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { NextRequest } from "next/server";

// PUT /api/workspace/[id]/integrations — switching a workspace's WhatsApp
// provider between YCloud and Kapso.

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

mock.module("@/lib/auth/workspace-access.ts", {
  exports: {
    requireWorkspaceMember: async () => ({ ok: true, userId: "user_1", role: "manager" }),
    readJsonBody: async (req: Request) => ({ ok: true, body: await req.json() }),
  },
});
mock.module("@/shared/lib/integration-secrets.ts", {
  exports: {
    encryptCredentials: async (c: unknown) => c,
    decryptCredentials: async (c: unknown) => c ?? {},
  },
});

type Row = {
  id: string;
  workspace_id: string;
  provider: string;
  enabled: boolean;
  credentials: Record<string, unknown>;
  config: Record<string, unknown>;
};
let rows: Row[] = [];
let failUpsert = false;

// In-memory integrations table that also enforces the partial unique index
// (one enabled YCloud/Kapso row per workspace), like the database does.
function oneActiveViolation(candidate: Row): boolean {
  if (!candidate.enabled || !["ycloud", "kapso"].includes(candidate.provider)) return false;
  return rows.some(
    (r) =>
      r.id !== candidate.id &&
      r.workspace_id === candidate.workspace_id &&
      r.enabled &&
      ["ycloud", "kapso"].includes(r.provider),
  );
}

function selectQuery() {
  const filters: Array<(r: Row) => boolean> = [];
  const q: any = {
    eq: (c: string, v: unknown) => (filters.push((r) => (r as any)[c] === v), q),
    neq: (c: string, v: unknown) => (filters.push((r) => (r as any)[c] !== v), q),
    in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes((r as any)[c])), q),
    single: async () => {
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      return hit.length === 1 ? { data: hit[0], error: null } : { data: null, error: { message: "0 rows" } };
    },
    maybeSingle: async () => {
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      return hit.length > 1 ? { data: null, error: { message: "multiple" } } : { data: hit[0] ?? null, error: null };
    },
  };
  return q;
}

const fakeSvc = {
  from: () => ({
    select: () => selectQuery(),
    update: (patch: Partial<Row>) => {
      const filters: Array<(r: Row) => boolean> = [];
      const q: any = {
        eq: (c: string, v: unknown) => (filters.push((r) => (r as any)[c] === v), q),
        then: (resolve: (v: unknown) => void) => {
          for (const r of rows.filter((x) => filters.every((f) => f(x)))) Object.assign(r, patch);
          resolve({ error: null });
        },
      };
      return q;
    },
    upsert: async (row: Omit<Row, "id">) => {
      if (failUpsert) return { error: { message: "boom" } };
      const existing = rows.find((r) => r.workspace_id === row.workspace_id && r.provider === row.provider);
      const next = { ...(existing ?? { id: `int_${row.provider}` }), ...row } as Row;
      if (oneActiveViolation(next)) return { error: { message: "duplicate key uq_integrations_one_active_whatsapp" } };
      if (existing) Object.assign(existing, next);
      else rows.push(next);
      return { error: null };
    },
  }),
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
  failUpsert = false;
  rows = [
    {
      id: "int_ycloud",
      workspace_id: "ws_1",
      provider: "ycloud",
      enabled: true,
      credentials: { ycloud_api_key: "yk" },
      config: {
        phone_number: "+5215550000000",
        buffer_silence_seconds: 12,
        message_history_window: 20,
        jev_enabled: true,
      },
    },
  ];
}
const byProvider = (p: string) => rows.find((r) => r.provider === p)!;

test("enabling Kapso disables YCloud and carries the workspace settings over", async () => {
  reset();
  const res = await put({
    provider: "kapso",
    credentials: { kapso_api_key: "kp" },
    config: { phone_number_id: "pn_1", waba_id: "waba_1", buffer_silence_seconds: 15 },
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.switchedFrom, "ycloud");
  assert.equal(byProvider("ycloud").enabled, false);
  assert.equal(byProvider("kapso").enabled, true);
  const cfg = byProvider("kapso").config;
  assert.equal(cfg.buffer_silence_seconds, 15, "what the UI sends wins");
  assert.equal(cfg.message_history_window, 20, "carried from the active provider");
  assert.equal(cfg.jev_enabled, true, "Jev settings follow the workspace");
  assert.equal(cfg.phone_number, undefined, "the provider's own fields do not travel");
  assert.deepEqual(byProvider("ycloud").credentials, { ycloud_api_key: "yk" }, "old credentials are kept");
});

test("switching back reactivates the old row with the latest settings", async () => {
  reset();
  await put({ provider: "kapso", credentials: { kapso_api_key: "kp" }, config: { message_history_window: 30 } });
  const res = await put({ provider: "ycloud", config: {} });
  assert.equal((await res.json()).switchedFrom, "kapso");
  assert.equal(byProvider("ycloud").enabled, true);
  assert.equal(byProvider("kapso").enabled, false);
  assert.equal(byProvider("ycloud").config.message_history_window, 30, "stale value replaced");
  assert.equal(byProvider("ycloud").config.phone_number, "+5215550000000");
});

test("saving the active provider again is not a switch", async () => {
  reset();
  const res = await put({ provider: "ycloud", config: { buffer_silence_seconds: 40 } });
  const json = await res.json();
  assert.equal(json.switchedFrom, undefined);
  assert.equal(byProvider("ycloud").enabled, true);
  assert.equal(byProvider("ycloud").config.buffer_silence_seconds, 40);
});

test("if the new provider fails to save, the old one is re-enabled", async () => {
  reset();
  failUpsert = true;
  const res = await put({ provider: "kapso", credentials: { kapso_api_key: "kp" }, config: {} });
  assert.equal(res.status, 500);
  assert.equal(byProvider("ycloud").enabled, true, "the workspace keeps its WhatsApp");
});

test("other integrations (OpenRouter) never touch the WhatsApp provider", async () => {
  reset();
  await put({ provider: "openrouter", credentials: { openrouter_api_key: "or" }, config: {} });
  assert.equal(byProvider("ycloud").enabled, true);
});
