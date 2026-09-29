/**
 * scanTimeTriggers — recordatorios de cita del motor de automatizaciones.
 * Evaluador de triggers por TIEMPO, no por evento: no hay ningún webhook de
 * citas en el repo, así que en vez de encolar al agendar, cada tick recalcula
 * desde `appointments`.
 *
 * Invariante compartido con expand.ts: NUNCA lanza. Es la fase 0 del cron de
 * `cron/automations`; si revienta, el resto del tick (expansión + drenaje)
 * igual tiene que correr.
 *
 * El único efecto de esta función es insertar filas en `automation_events`.
 * Desde ahí el pipeline de siempre — `expandAutomationEvents()` y
 * `claim_next_automation_run()` — hace todo lo demás sin cambios. Esta
 * función NO ejecuta acciones ni encola runs.
 *
 * Dedup: el UNIQUE (event_type, subject_id, occurrence) de
 * `automation_events` es toda la idempotencia. `occurrence` lleva
 * `<rule_id>:<hours_before>h:<scheduled_at ISO-8601 UTC>` (lo arma
 * automation_reminder_candidates), así que una cita reagendada saca una clave
 * nueva a propósito — no achicar el string "para no duplicar".
 */

import { createClient as createSbClient } from "@supabase/supabase-js";
import { resolveWorkspaceTimezone } from "@/features/automations/lib/workspace-timezone";
import {
  parseReminderConfig,
  withinSendWindow,
} from "@/features/automations/lib/reminder-window";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Cupo de citas evaluadas por regla y por tick (misma cota que la expansión). */
const APPOINTMENTS_PER_RULE = 50;

interface TimeRule {
  id: string;
  workspace_id: string;
  trigger_config: unknown;
}


/** One row of automation_reminder_candidates(). */
interface CandidateRow {
  subject_id: string;
  occurrence: string;
  contact_id: string | null;
  conversation_id: string | null;
  scheduled_at: string;
}

interface EventInsert {
  workspace_id: string;
  event_type: "appointment_upcoming";
  subject_id: string;
  occurrence: string;
  contact_id: string;
  conversation_id: string;
  // Migración 20260908000000: la única fuente que puebla esta columna. El
  // guard de expand.ts solo expande este evento a ESTA regla — sin
  // esto, dos reglas appointment_upcoming del mismo workspace con distinto
  // hours_before matchearían las dos por trigger_type.
  rule_id: string;
}

/**
 * The appointments this rule has to emit now, from
 * `automation_reminder_candidates()` (service role only). The database does the
 * whole selection: active, ahead within hours_before, with contact and
 * conversation, booked with at least that much lead, not due long before the
 * rule was enabled, and NOT already emitted for this rule at this time —
 * earliest due first, at most APPOINTMENTS_PER_RULE. Already-emitted
 * appointments never take a slot, so a calendar with more than a batch of
 * appointments inside hours_before still surfaces each one when it is due;
 * a full batch only means the next tick continues where this one stopped. The
 * occurrence comes from the same query, so the key the scan stores is the one
 * it checks.
 */
async function eligibleEventsForRule(
  db: ReturnType<typeof svc>,
  rule: TimeRule,
  now: Date,
): Promise<EventInsert[]> {
  const { data, error } = await db.rpc("automation_reminder_candidates", {
    p_rule_id: rule.id,
    p_now: now.toISOString(),
    p_limit: APPOINTMENTS_PER_RULE,
  });
  if (error) throw new Error(error.message);

  const batch = (data ?? []) as CandidateRow[];
  if (batch.length === APPOINTMENTS_PER_RULE) {
    console.warn(
      `[scan-time] workspace ${rule.workspace_id} rule ${rule.id}: ${APPOINTMENTS_PER_RULE} reminders due at once; the next tick continues`,
    );
  }

  const rows: EventInsert[] = [];
  for (const candidate of batch) {
    // Belt on top of the query's NOT NULLs: both are NOT NULL on the event,
    // and a missing one would burn the dedup key for good.
    if (!candidate.contact_id || !candidate.conversation_id) continue;
    rows.push({
      workspace_id: rule.workspace_id,
      event_type: "appointment_upcoming",
      subject_id: candidate.subject_id,
      // '<rule>:<h>h:<ISO>': the rule id lets two reminder rules with the
      // same lead time each get their event.
      occurrence: candidate.occurrence,
      contact_id: candidate.contact_id,
      conversation_id: candidate.conversation_id,
      rule_id: rule.id,
    });
  }
  return rows;
}

/**
 * Recorre las reglas `appointment_upcoming` activas de todos los workspaces
 * y, por cada una, inserta en `automation_events` las citas que le tocan.
 *
 * @param deadline instante absoluto (`Date.now()` + presupuesto) fijado por el
 *                 cron ANTES de llamar. Se comprueba ENTRE reglas:
 *                 es la unidad de trabajo de este evaluador, igual que "entre
 *                 workspaces" lo es para `expandAutomationEvents`.
 */
export async function scanTimeTriggers(
  deadline: number,
): Promise<{ events: number; errors: number; error?: string }> {
  const tally = { events: 0, errors: 0 };

  // Mismo invariante que expand.ts: svc() puede lanzar (faltan env vars) y
  // esta función NUNCA lanza.
  let db: ReturnType<typeof svc>;
  try {
    db = svc();
  } catch (err) {
    console.error("[scan-time] failed to create the Supabase client:", msg(err));
    tally.errors += 1;
    return { ...tally, error: "scan_time_failed" };
  }

  // Falla de FASE, no por ítem (igual que el "scan de workspaces pendientes"
  // en expand.ts): sin poder listar las reglas activas, el tally en ceros es
  // indistinguible de "no había ninguna regla de este tipo".
  let rules: TimeRule[];
  try {
    const { data, error } = await db
      .from("automation_rules")
      .select("id, workspace_id, trigger_config")
      .eq("trigger_type", "appointment_upcoming")
      .eq("enabled", true);
    if (error) throw new Error(error.message);
    rules = (data ?? []) as TimeRule[];
  } catch (err) {
    console.error(
      "[scan-time] failed to load active appointment_upcoming rules:",
      msg(err),
    );
    tally.errors += 1;
    return { ...tally, error: "scan_time_failed" };
  }

  const now = new Date();
  // Cachea la zona por workspace (o `null` cuando no se pudo resolver con
  // certeza): varias reglas del mismo workspace no repiten la consulta a
  // `integrations`. `Map.get` distingue "no cacheado todavía" (`undefined`)
  // de "cacheado como null" (`null`), así que el `undefined` sigue siendo el
  // único disparador para volver a llamar a `resolveWorkspaceTimezone`.
  const tzCache = new Map<string, string | null>();

  for (const rule of rules) {
    if (Date.now() >= deadline) {
      console.warn("[scan-time] deadline reached; leaving the rest for the next tick");
      break;
    }

    const config = parseReminderConfig(rule.trigger_config);
    if (!config) {
      console.error(`[scan-time] rule ${rule.id}: invalid trigger_config, skipping`);
      tally.errors += 1;
      continue;
    }

    // Una regla que revienta (query caída, tz corrupta) no puede tumbar las
    // demás: falla por ÍTEM, no de fase (mismo criterio que el fallo de
    // lectura de un tenant en expand.ts).
    try {
      let tz = tzCache.get(rule.workspace_id);
      if (tz === undefined) {
        tz = await resolveWorkspaceTimezone(db, rule.workspace_id);
        tzCache.set(rule.workspace_id, tz);
      }
      // null = "no sé la zona con certeza" (config inválida o lectura de
      // integrations caída, ya logueado dentro de resolveWorkspaceTimezone
      // con el detalle server-side). Emitir en UTC por default sería el
      // mismo daño activo que esto vino a cerrar, así que esta regla no
      // evalúa este tick. Cuenta como error del tally (a diferencia del
      // descarte por ventana horaria de abajo, que es un resultado de
      // negocio esperado): acá hay un dato roto o una lectura caída que
      // alguien tiene que mirar.
      if (tz === null) {
        console.error(
          `[scan-time] workspace ${rule.workspace_id} rule ${rule.id}: unknown timezone, skipping this tick`,
        );
        tally.errors += 1;
        continue;
      }

      // Fuera de la ventana horaria el evaluador no inserta nada. No hay que
      // retener ni reprogramar — el próximo tick que caiga dentro la vuelve a
      // ver, porque el evaluador es sin estado.
      if (!withinSendWindow(config, tz, now)) continue;

      const rows = await eligibleEventsForRule(db, rule, now);
      if (rows.length === 0) continue;

      // ignoreDuplicates, NUNCA upsert con update: un choque contra
      // el UNIQUE significa "ya se avisó" y pisar la fila reabriría el evento.
      const { data: inserted, error } = await db
        .from("automation_events")
        .upsert(rows, {
          onConflict: "event_type,subject_id,occurrence",
          ignoreDuplicates: true,
        })
        .select("id");
      if (error) throw new Error(error.message);
      tally.events += (inserted ?? []).length;
    } catch (err) {
      tally.errors += 1;
      console.error(`[scan-time] rule ${rule.id}: failed to scan appointments:`, msg(err));
    }
  }

  return tally;
}
