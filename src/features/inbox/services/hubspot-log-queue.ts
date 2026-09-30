/**
 * hubspot-log-queue.ts — procesa la cola hubspot_conversation_logs. Es la fase hubspotLogs
 * de cron/automations: corre DESPUÉS del drenaje del motor y con el mismo deadline de la corrida
 * (RUN_BUDGET_MS, 50 s).
 *
 * - Reclamo con lease (RPC claim_hubspot_conversation_log, FOR UPDATE SKIP LOCKED).
 * - Cada ítem con deadline propio vía hsDeadline: cada llamada a HubSpot recorta su timeout.
 * - Intentos acotados (MAX_LOG_ATTEMPTS) con backoff; en last_error solo CÓDIGOS.
 * - El cierre filtra por id + workspace_id + attempts, y pide `.select("id")`: si el lease venció
 *   y otra corrida ya reclamó y cerró este ítem, el CAS no afecta ninguna fila y este worker ni
 *   cuenta el ítem en el tally ni emite su evento (evita un evento duplicado por el mismo cierre).
 * - La RPC del claim sube `attempts` sin tope: una corrida que muere a mitad de un
 *   ítem lo deja reclamable para siempre. Un ítem reclamado ya por encima de MAX_LOG_ATTEMPTS
 *   cierra failed/max_attempts de una, SIN llamar a logHubSpotConversation.
 * - `db_error` (lectura transitoria fallida en logHubSpotConversation: conversación, contacto,
 *   mensajes, proveedor de WhatsApp o config) se trata como cualquier otro código reintentable: pending +
 *   backoff, cuenta hacia MAX_LOG_ATTEMPTS. Nunca se lo confunde con "no hay datos".
 * - Un cierre `cancelled` (HubSpot desconectado o config ilegible) también emite
 *   `crm_sync_failed`, igual que `failed`: que quede visible, no solo silencioso en la fila.
 */

import { createClient as createSbClient } from "@supabase/supabase-js";
import { hsDeadline, logHubSpotConversation, recordHsEvent, type Outcome } from "./hubspot-client";
import { isMissingFunctionError, reportMissingFunctionOnce } from "@/shared/lib/db-errors";

export const MAX_LOG_ATTEMPTS = 5;
const LEASE_SECONDS = 120;
/** Presupuesto por ítem: enlace + comunicación son pocas llamadas de ≤ 10 s. Menor que el lease. */
const ITEM_BUDGET_MS = 30_000;
/** No se reclama un ítem si no queda al menos esto de la corrida. */
const MIN_REMAINING_MS = 15_000;
const MAX_ITEMS_PER_TICK = 10;
const BACKOFF_MS = 120_000;
/** Finished rows (done, failed, cancelled) are kept this long, then purged. */
export const LOG_RETENTION_DAYS = 30;

export interface HubSpotLogTally {
  done: number;
  retry: number;
  failed: number;
  cancelled: number;
  /** Waiting for the token to be fixed (see PARK_CODES). */
  parked?: number;
  /** Cierres cuyo UPDATE devolvió error (el ítem queda pending bajo su lease). */
  finish_failed?: number;
  error?: string;
}

interface ClaimedLog {
  id: string;
  workspace_id: string;
  conversation_id: string;
  reason: "handoff" | "closed";
  attempts: number;
}

type Bucket = "done" | "retry" | "failed" | "cancelled" | "parked";

/** Códigos que cierran cancelled, sin reintento: HubSpot desconectado o config ilegible. */
const CANCEL_CODES = new Set(["not_configured", "config_decrypt_failed"]);
/**
 * Token problems a person fixes: revoked or wrong token, missing scope, or a
 * connection not tested yet. Retrying doesn't fix them and would eat the
 * phase's budget, and failing them loses the entry: the log is PARKED, and
 * "Probar conexión" (mark_hubspot_ready, same portal) puts it back in line.
 */
const PARK_CODES = new Set(["unauthorized", "missing_scope", "properties_not_ready"]);
/**
 * Códigos permanentes: cierran failed al primer intento. El resto (incluido db_error,
 * deadline, timeout) sigue reintentándose.
 */
const PERMANENT_CODES = new Set(["conversation_not_found"]);

function nextState(outcome: Outcome, attempts: number): {
  bucket: Bucket;
  status: "done" | "pending" | "failed" | "cancelled" | "parked";
  last_error: string | null;
  claimed_until: string | null;
} {
  if (outcome.ok) return { bucket: "done", status: "done", last_error: null, claimed_until: null };
  const code = outcome.code;
  if (CANCEL_CODES.has(code)) return { bucket: "cancelled", status: "cancelled", last_error: code, claimed_until: null };
  if (PARK_CODES.has(code)) return { bucket: "parked", status: "parked", last_error: code, claimed_until: null };
  if (PERMANENT_CODES.has(code) || attempts >= MAX_LOG_ATTEMPTS) {
    return { bucket: "failed", status: "failed", last_error: code, claimed_until: null };
  }
  return {
    bucket: "retry",
    status: "pending",
    last_error: code,
    claimed_until: new Date(Date.now() + attempts * BACKOFF_MS).toISOString(),
  };
}

export async function drainHubSpotConversationLogs(deadline: number): Promise<HubSpotLogTally> {
  const tally: HubSpotLogTally = { done: 0, retry: 0, failed: 0, cancelled: 0 };
  const db = createSbClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  for (let i = 0; i < MAX_ITEMS_PER_TICK; i++) {
    if (deadline - Date.now() < MIN_REMAINING_MS) break;

    const { data, error } = await db.rpc("claim_hubspot_conversation_log", { p_lease_seconds: LEASE_SECONDS });
    if (error) {
      // Deployed before db-push: there is no queue yet, so there is nothing to
      // drain. Not a failed phase (it would turn every tick into a 500).
      if (isMissingFunctionError(error, "claim_hubspot_conversation_log")) {
        reportMissingFunctionOnce("claim_hubspot_conversation_log", "the HubSpot timeline queue is skipped");
        return tally;
      }
      console.error("[hubspot-logs] hubspot_logs_claim_failed");
      return { ...tally, error: "hubspot_logs_claim_failed" };
    }
    const row = ((data as ClaimedLog[] | null) ?? [])[0];
    if (!row) break;

    let next: ReturnType<typeof nextState>;
    if (row.attempts > MAX_LOG_ATTEMPTS) {
      // El claim no tiene tope: si una corrida murió a mitad de este ítem, quedaría
      // reclamable para siempre, llamando a HubSpot en cada tick. Se corta acá, sin llamar.
      next = { bucket: "failed", status: "failed", last_error: "max_attempts", claimed_until: null };
    } else {
      const itemDeadline = Math.min(deadline, Date.now() + ITEM_BUDGET_MS);
      let outcome: Outcome;
      try {
        outcome = await hsDeadline.run(itemDeadline, () =>
          logHubSpotConversation(row.workspace_id, row.conversation_id, row.reason),
        );
      } catch {
        outcome = { ok: false, code: "threw" };
      }
      next = nextState(outcome, row.attempts);
    }

    // .select("id"): si el CAS (id + workspace_id + attempts + status) no afectó ninguna fila,
    // otra corrida ya reclamó y cerró este ítem entretanto — no se cuenta en el tally ni se emite
    // un segundo evento por el mismo cierre. El `status = pending` impide revivir un ítem que
    // mark_hubspot_ready canceló en vuelo por cambio de portal (no toca `attempts`).
    const { data: finishRows, error: finishError } = await db
      .from("hubspot_conversation_logs")
      .update({
        status: next.status,
        last_error: next.last_error,
        claimed_until: next.claimed_until,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("workspace_id", row.workspace_id)
      .eq("attempts", row.attempts)
      .eq("status", "pending")
      .select("id");
    if (finishError) {
      // El ítem queda pending bajo su lease y se reprocesa en 120 s, quizás tras un POST que
      // HubSpot ya aceptó. Un tick con cierres fallidos no es sano: la fase lo DEVUELVE como
      // error y el cron responde 500 ok:false. Se sigue con el resto.
      console.error("[hubspot-logs] finish_failed", { id: row.id });
      tally.finish_failed = (tally.finish_failed ?? 0) + 1;
      tally.error = "hubspot_logs_finish_failed";
      continue;
    }
    if (!Array.isArray(finishRows) || finishRows.length === 0) continue;

    if (next.status === "failed" || next.status === "cancelled" || next.status === "parked") {
      await recordHsEvent(
        row.workspace_id,
        "crm_sync_failed",
        { code: next.last_error, step: "conversation_log", attempts: row.attempts },
        row.conversation_id,
      );
    }
    tally[next.bucket] = (tally[next.bucket] ?? 0) + 1;
  }
  await purgeFinishedLogs(deadline);
  return tally;
}

/**
 * Deletes finished rows older than LOG_RETENTION_DAYS, a bounded batch per
 * tick, with whatever time is left. Best-effort: a failure is logged and the
 * next tick tries again; it never fails the phase.
 */
async function purgeFinishedLogs(deadline: number): Promise<void> {
  if (deadline - Date.now() < 2_000) return;
  try {
    const db = createSbClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
    const { error } = await db.rpc("purge_hubspot_conversation_logs", {
      p_keep_days: LOG_RETENTION_DAYS,
      p_limit: 1000,
    });
    if (error && !isMissingFunctionError(error, "purge_hubspot_conversation_logs")) {
      console.error("[hubspot-logs] purge failed:", error.message);
    }
  } catch (err) {
    console.error("[hubspot-logs] purge failed:", err instanceof Error ? err.message : err);
  }
}
