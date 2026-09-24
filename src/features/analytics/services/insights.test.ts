import assert from "node:assert/strict";
import { mock, test } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

let member: unknown = { ok: true, userId: "u1", role: "viewer" };
let memberOpts: unknown = null;
mock.module("@/lib/auth/workspace-access.ts", {
  exports: {
    checkWorkspaceMember: async (_ws: string, opts: unknown) => {
      memberOpts = opts;
      return member;
    },
  },
});

let tz: string | null = "America/Santiago";
mock.module("@/features/automations/lib/workspace-timezone.ts", {
  exports: { resolveWorkspaceTimezone: async () => tz, DEFAULT_TIMEZONE: "UTC" },
});

const rawInsights = {
  base: { conversations: 10, booked: 3, handed_off: 1, tags: {} },
  prev_conversations: 5,
  prev_booked: 1,
  prev_handed_off: 0,
  topics: [],
  trend: [],
  partial_conversations: 0,
  oldest_pending: null,
};
let rpcResults: Record<string, { data: unknown; error: { code: string } | null }> = {};
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let topicsResult: { data: unknown; error: { code: string } | null } = { data: [], error: null };

mock.module("@supabase/supabase-js", {
  exports: {
    createClient: () => ({
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        return rpcResults[fn];
      },
      from: () => {
        const q = { select: () => q, eq: () => q, order: async () => topicsResult };
        return q;
      },
    }),
  },
});

const { loadInsights } = await import("./insights.ts");
const WS = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-15T15:00:00Z");

function reset() {
  member = { ok: true, userId: "u1", role: "viewer" };
  tz = "America/Santiago";
  rpcCalls = [];
  rpcResults = {
    get_insights: { data: rawInsights, error: null },
    get_workspace_tags: { data: [{ tag: "frio" }, { tag: "vip" }], error: null },
  };
  topicsResult = { data: [{ id: "t1", name: "Precio", description: "x", status: "active", backfill_status: "done", created_at: "2026-09-01" }], error: null };
}

test("viewer carga el dashboard: exige viewer, pasa rango y zona a la RPC, no puede gestionar", async () => {
  reset();
  const r = await loadInsights(WS, { range: "7", tags: ["vip"] }, NOW);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(memberOpts, { minRole: "viewer" });
  assert.deepEqual(rpcCalls.find((c) => c.fn === "get_insights")?.args, {
    p_workspace_id: WS,
    // El preset de 7 días termina AYER (2026-09-14), así que va del 8 al 14
    // y el corte exclusivo es el inicio de hoy en Santiago.
    p_from: "2026-09-08T03:00:00.000Z",
    p_to: "2026-09-15T03:00:00.000Z",
    p_tags: ["vip"],
    p_tz: "America/Santiago",
  });
  assert.equal(r.view.bookedPct, 30);
  assert.deepEqual(r.availableTags, ["frio", "vip"]);
  assert.equal(r.topics.length, 1);
  assert.equal(r.canManage, false);
});

test("manager y admin pueden gestionar", async () => {
  reset();
  member = { ok: true, userId: "u1", role: "manager" };
  const r = await loadInsights(WS, {}, NOW);
  assert.ok(r.ok && r.canManage);
  member = { ok: true, userId: "u1", role: "admin" };
  const r2 = await loadInsights(WS, {}, NOW);
  assert.ok(r2.ok && r2.canManage);
});

test("no miembro → forbidden sin consultar datos", async () => {
  reset();
  member = { ok: false, status: 403 };
  const r = await loadInsights(WS, {}, NOW);
  assert.deepEqual(r, { ok: false, kind: "forbidden", message: "No tienes acceso al análisis de este espacio." });
  assert.equal(rpcCalls.length, 0);
});

test("filtro inválido → invalid con el mensaje del validador, sin consultar", async () => {
  reset();
  const r = await loadInsights(WS, { from: "ayer", to: "2026-09-07" }, NOW);
  assert.deepEqual(r, { ok: false, kind: "invalid", message: "Las fechas del filtro no son válidas." });
  assert.equal(rpcCalls.length, 0);
});

test("zona ilegible (null) → error natural, NO se cae al default", async () => {
  reset();
  tz = null;
  const r = await loadInsights(WS, { range: "7" }, NOW);
  assert.deepEqual(r, { ok: false, kind: "error", message: "No se pudo cargar el análisis, intenta de nuevo en unos minutos." });
  // No se consulta nada con una zona inventada.
  assert.equal(rpcCalls.length, 0);
});

test("sin zona configurada el helper ya devuelve el default y eso sí se usa", async () => {
  reset();
  tz = "UTC";
  const r = await loadInsights(WS, { range: "7" }, NOW);
  assert.ok(r.ok);
  assert.equal(rpcCalls.find((c) => c.fn === "get_insights")?.args.p_tz, "UTC");
});

test("error de la RPC → mensaje natural, sin código ni detalle", async () => {
  reset();
  rpcResults.get_insights = { data: null, error: { code: "57014" } };
  const r = await loadInsights(WS, {}, NOW);
  assert.deepEqual(r, { ok: false, kind: "error", message: "No se pudo cargar el análisis, intenta de nuevo en unos minutos." });
});

test("error al leer temas → mismo mensaje natural", async () => {
  reset();
  topicsResult = { data: null, error: { code: "42501" } };
  const r = await loadInsights(WS, {}, NOW);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.kind, "error");
});
