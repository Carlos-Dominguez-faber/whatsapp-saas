import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { AsyncLocalStorage } from "node:async_hooks";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

type Row = Record<string, unknown>;
let claimQueue: Array<{ data: Row[] | null; error: { message: string } | null }> = [];
const claims: unknown[] = [];
const finishes: Array<{ patch: Row; eqs: unknown[][] }> = [];
const events: Row[] = [];
/** Cuando true, el próximo cierre CAS afecta 0 filas (otra corrida ya reclamó y cerró el ítem). */
let finishAffectsNoRows = false;
/** Cuántos de los próximos cierres devuelven error de PostgREST. */
let finishErrors = 0;

mock.module("@supabase/supabase-js", {
  exports: {
    createClient: () => ({
      rpc: async (fn: string, args: unknown) => {
        assert.equal(fn, "claim_hubspot_conversation_log");
        claims.push(args);
        return claimQueue.shift() ?? { data: [], error: null };
      },
      from: (table: string) => {
        assert.equal(table, "hubspot_conversation_logs");
        return {
          update: (patch: Row) => {
            const eqs: unknown[][] = [];
            const c: any = {
              eq: (k: string, v: unknown) => { eqs.push([k, v]); return c; },
              select: async (_cols: string) => {
                finishes.push({ patch, eqs });
                const idEq = eqs.find(([k]) => k === "id");
                if (finishErrors > 0) {
                  finishErrors--;
                  return { data: null, error: { message: "db blip" } };
                }
                return { data: finishAffectsNoRows ? [] : [{ id: idEq?.[1] }], error: null };
              },
            };
            return c;
          },
        };
      },
    }),
  },
});

const als = new AsyncLocalStorage<number>();
let outcomes: Array<{ ok: true } | { ok: false; code: string } | "throw"> = [];
const logged: Array<{ args: unknown[]; deadline: number | undefined }> = [];
mock.module("./hubspot-client.ts", {
  exports: {
    hsDeadline: als,
    logHubSpotConversation: async (...args: unknown[]) => {
      logged.push({ args, deadline: als.getStore() });
      const next = outcomes.shift() ?? { ok: true };
      if (next === "throw") throw new Error("boom");
      return next;
    },
    recordHsEvent: async (
      workspaceId: string,
      type: string,
      payload: Row,
      conversationId: string | null = null,
    ) => {
      events.push({ type, level: "warn", workspace_id: workspaceId, conversation_id: conversationId, payload: { provider: "hubspot", ...payload } });
    },
  },
});

const { drainHubSpotConversationLogs, MAX_LOG_ATTEMPTS } = await import("./hubspot-log-queue.ts");

function row(attempts = 1): Row {
  return { id: "log_1", workspace_id: "ws_1", conversation_id: "conv_1", reason: "handoff", attempts };
}

function reset(rows: Row[] = []) {
  claimQueue = rows.map((r) => ({ data: [r], error: null }));
  claims.length = 0;
  finishes.length = 0;
  events.length = 0;
  outcomes = [];
  logged.length = 0;
  finishAffectsNoRows = false;
  finishErrors = 0;
}

const later = () => Date.now() + 50_000;

test("camino correcto: reclama con lease, procesa y cierra done con filtros de id, tenant, attempts y status pending (un cancelado en vuelo no revive)", async () => {
  reset([row()]);
  assert.deepEqual(await drainHubSpotConversationLogs(later()), { done: 1, retry: 0, failed: 0, cancelled: 0 });
  assert.deepEqual(claims[0], { p_lease_seconds: 120 });
  assert.deepEqual(logged[0].args, ["ws_1", "conv_1", "handoff"]);
  assert.equal(finishes[0].patch.status, "done");
  assert.deepEqual(finishes[0].eqs, [["id", "log_1"], ["workspace_id", "ws_1"], ["attempts", 1], ["status", "pending"]]);
});

test("cada ítem corre con un deadline propio acotado a 30 s y al de la corrida", async () => {
  reset([row()]);
  const deadline = Date.now() + 40_000;
  await drainHubSpotConversationLogs(deadline);
  const d = logged[0].deadline!;
  assert.ok(d <= deadline && d <= Date.now() + 30_000, `deadline del ítem ${d}`);
});

test("timeout de HubSpot: vuelve a pending con backoff y el código, para reintentar después", async () => {
  reset([row(2)]);
  outcomes = [{ ok: false, code: "timeout" }];
  const before = Date.now();
  assert.deepEqual(await drainHubSpotConversationLogs(later()), { done: 0, retry: 1, failed: 0, cancelled: 0 });
  const p = finishes[0].patch;
  assert.equal(p.status, "pending");
  assert.equal(p.last_error, "timeout");
  assert.ok(Date.parse(String(p.claimed_until)) >= before + 2 * 120_000, "backoff = attempts × 2 min");
  assert.equal(events.length, 0);
});

test("intentos agotados: failed con el código y un evento crm_sync_failed en la conversación", async () => {
  reset([row(MAX_LOG_ATTEMPTS)]);
  outcomes = [{ ok: false, code: "rate_limited" }];
  assert.deepEqual(await drainHubSpotConversationLogs(later()), { done: 0, retry: 0, failed: 1, cancelled: 0 });
  assert.deepEqual(finishes[0].patch.status, "failed");
  assert.equal(finishes[0].patch.last_error, "rate_limited");
  assert.deepEqual(events[0], {
    type: "crm_sync_failed",
    level: "warn",
    workspace_id: "ws_1",
    conversation_id: "conv_1",
    payload: { provider: "hubspot", code: "rate_limited", step: "conversation_log", attempts: MAX_LOG_ATTEMPTS },
  });
});

test("HubSpot desconectado: cancelled; conversación inexistente: failed de inmediato", async () => {
  reset([row(), { ...row(), id: "log_2" }]);
  outcomes = [{ ok: false, code: "not_configured" }, { ok: false, code: "conversation_not_found" }];
  assert.deepEqual(await drainHubSpotConversationLogs(later()), { done: 0, retry: 0, failed: 1, cancelled: 1 });
  assert.deepEqual(finishes.map((f) => f.patch.status), ["cancelled", "failed"]);
});

test("un cierre cancelled también emite crm_sync_failed, igual que failed: no queda silencioso", async () => {
  reset([row(), { ...row(), id: "log_2" }]);
  outcomes = [{ ok: false, code: "not_configured" }, { ok: false, code: "config_decrypt_failed" }];
  assert.deepEqual(await drainHubSpotConversationLogs(later()), { done: 0, retry: 0, failed: 0, cancelled: 2 });
  assert.deepEqual(events, [
    { type: "crm_sync_failed", level: "warn", workspace_id: "ws_1", conversation_id: "conv_1", payload: { provider: "hubspot", code: "not_configured", step: "conversation_log", attempts: 1 } },
    { type: "crm_sync_failed", level: "warn", workspace_id: "ws_1", conversation_id: "conv_1", payload: { provider: "hubspot", code: "config_decrypt_failed", step: "conversation_log", attempts: 1 } },
  ]);
});

test("db_error (lectura transitoria fallida) vuelve a pending con backoff, nunca cancelled/failed", async () => {
  reset([row(2)]);
  outcomes = [{ ok: false, code: "db_error" }];
  const before = Date.now();
  assert.deepEqual(await drainHubSpotConversationLogs(later()), { done: 0, retry: 1, failed: 0, cancelled: 0 });
  const p = finishes[0].patch;
  assert.equal(p.status, "pending");
  assert.equal(p.last_error, "db_error");
  assert.ok(Date.parse(String(p.claimed_until)) >= before + 2 * 120_000, "backoff = attempts × 2 min");
  assert.equal(events.length, 0);
});

test("cierre CAS que afecta 0 filas (otra corrida ya lo reclamó y cerró): no cuenta ni emite evento", async () => {
  reset([row(MAX_LOG_ATTEMPTS)]);
  outcomes = [{ ok: false, code: "rate_limited" }];
  finishAffectsNoRows = true;
  assert.deepEqual(await drainHubSpotConversationLogs(later()), { done: 0, retry: 0, failed: 0, cancelled: 0 });
  assert.equal(finishes.length, 1, "sí se intentó el cierre");
  assert.equal(events.length, 0, "no se emite un evento por un cierre que no pasó");
});

test("un cierre que devuelve error se cuenta y marca la fase (500 ok:false), sin emitir evento", async () => {
  reset([row(), { ...row(), id: "log_2" }]);
  finishErrors = 1;
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => errors.push(a);
  let tally;
  try {
    tally = await drainHubSpotConversationLogs(later());
  } finally {
    console.error = original;
  }
  // El segundo ítem igual se procesa: un blip no corta el resto de la cola.
  assert.deepEqual(tally, {
    done: 1, retry: 0, failed: 0, cancelled: 0, finish_failed: 1, error: "hubspot_logs_finish_failed",
  });
  assert.equal(events.length, 0);
  assert.ok(errors.every((a) => !JSON.stringify(a).includes("db blip")), "no se filtra el texto de PostgREST");
});

test("unauthorized y missing_scope cierran failed al primer intento, con evento de códigos", async () => {
  for (const code of ["unauthorized", "missing_scope"]) {
    reset([row(1)]);
    outcomes = [{ ok: false, code }];
    assert.deepEqual(await drainHubSpotConversationLogs(later()), { done: 0, retry: 0, failed: 1, cancelled: 0 }, code);
    assert.equal(finishes[0].patch.status, "failed");
    assert.equal(finishes[0].patch.last_error, code);
    assert.equal(finishes[0].patch.claimed_until, null);
    assert.deepEqual(events[0].payload, { provider: "hubspot", code, step: "conversation_log", attempts: 1 });
  }
});

test("si el procesamiento lanza, no rompe la fase: reintenta con código threw", async () => {
  reset([row()]);
  outcomes = ["throw"];
  assert.deepEqual(await drainHubSpotConversationLogs(later()), { done: 0, retry: 1, failed: 0, cancelled: 0 });
  assert.equal(finishes[0].patch.last_error, "threw");
});

test("con menos de 15 s de presupuesto no reclama nada", async () => {
  reset([row()]);
  assert.deepEqual(await drainHubSpotConversationLogs(Date.now() + 10_000), { done: 0, retry: 0, failed: 0, cancelled: 0 });
  assert.equal(claims.length, 0);
});

test("lo que el claim no devuelve (lease vigente o cola vacía) no se procesa", async () => {
  reset([]);
  assert.deepEqual(await drainHubSpotConversationLogs(later()), { done: 0, retry: 0, failed: 0, cancelled: 0 });
  assert.equal(logged.length, 0);
});

test("un claim que devuelve error es fallo de FASE, con código", async () => {
  reset();
  claimQueue = [{ data: null, error: { message: "permission denied" } }];
  assert.deepEqual(await drainHubSpotConversationLogs(later()), {
    done: 0, retry: 0, failed: 0, cancelled: 0, error: "hubspot_logs_claim_failed",
  });
});

test("tope de 10 ítems por tick", async () => {
  reset(Array.from({ length: 12 }, (_, i) => ({ ...row(), id: `log_${i}` })));
  const tally = await drainHubSpotConversationLogs(later());
  assert.equal(tally.done, 10);
  assert.equal(claims.length, 10);
});

// ── Tope de attempts: un ítem reclamado ya por encima del máximo no vuelve a llamar a HubSpot ──
// (el claim sube `attempts` sin tope, así que
// una corrida que muere a mitad de un ítem lo deja reclamable para siempre. Este corte evita que
// se siga llamando a HubSpot con un `attempts` que ya superó MAX_LOG_ATTEMPTS.)

test("un ítem reclamado con attempts > MAX_LOG_ATTEMPTS cierra failed/max_attempts sin llamar a HubSpot", async () => {
  reset([row(MAX_LOG_ATTEMPTS + 1)]);
  assert.deepEqual(await drainHubSpotConversationLogs(later()), { done: 0, retry: 0, failed: 1, cancelled: 0 });
  assert.equal(logged.length, 0, "no se llama a logHubSpotConversation ni a HubSpot");
  assert.equal(finishes[0].patch.status, "failed");
  assert.equal(finishes[0].patch.last_error, "max_attempts");
  assert.deepEqual(finishes[0].eqs, [["id", "log_1"], ["workspace_id", "ws_1"], ["attempts", MAX_LOG_ATTEMPTS + 1], ["status", "pending"]]);
  assert.deepEqual(events[0], {
    type: "crm_sync_failed",
    level: "warn",
    workspace_id: "ws_1",
    conversation_id: "conv_1",
    payload: { provider: "hubspot", code: "max_attempts", step: "conversation_log", attempts: MAX_LOG_ATTEMPTS + 1 },
  });
});
