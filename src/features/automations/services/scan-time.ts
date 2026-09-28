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
 * `<hours_before>h:<scheduled_at ISO-8601 UTC>`, así que una cita reagendada
 * saca una clave nueva a propósito — no achicar el string "para no
 * duplicar".
 */

import { createClient as createSbClient } from "@supabase/supabase-js";
import { resolveWorkspaceTimezone } from "@/features/automations/lib/workspace-timezone";

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

const DEFAULT_QUIET_START = 8;
const DEFAULT_QUIET_END = 22;

interface TimeRule {
  id: string;
  workspace_id: string;
  trigger_config: unknown;
}

interface TimeTriggerConfig {
  hoursBefore: number;
  quietStart: number;
  quietEnd: number;
}

interface AppointmentRow {
  id: string;
  scheduled_at: string;
  created_at: string;
  contact_id: string | null;
  conversation_id: string | null;
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
 * Valida `trigger_config` de una regla `appointment_upcoming`. El schema de
 * creación (rule-schema.ts, fuera del alcance de este archivo) ya rechaza un
 * `hours_before` inválido con 422 antes de guardar, pero una fila legacy o
 * corrupta no puede tumbar el tick: se descarta la regla acá, sin lanzar.
 */
function parseTriggerConfig(raw: unknown): TimeTriggerConfig | null {
  const cfg = raw as
    | { hours_before?: unknown; quiet_start?: unknown; quiet_end?: unknown }
    | null;

  const hoursBefore = Number(cfg?.hours_before);
  if (!Number.isFinite(hoursBefore) || hoursBefore < 1 || hoursBefore > 168) {
    return null;
  }

  const quietStart =
    cfg?.quiet_start === undefined ? DEFAULT_QUIET_START : Number(cfg.quiet_start);
  const quietEnd =
    cfg?.quiet_end === undefined ? DEFAULT_QUIET_END : Number(cfg.quiet_end);
  if (!Number.isInteger(quietStart) || quietStart < 0 || quietStart > 23) return null;
  if (!Number.isInteger(quietEnd) || quietEnd < 0 || quietEnd > 23) return null;

  return { hoursBefore, quietStart, quietEnd };
}

/** Hora local (0–23) de `now` en `tz`. `tz` inválida hace que Intl lance; el caller decide. */
function localHour(tz: string, now: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(now),
  );
}

/**
 * Las 6 condiciones de elegibilidad, cita por cita: estado activo, dentro de
 * la ventana, con contacto, con conversación, orden por cercanía y agendada
 * con al menos `hours_before` de anticipación.
 *
 * `created_at <= scheduled_at - hours_before` es una comparación entre
 * DOS columnas de la misma fila: PostgREST no la expresa como filtro (los
 * operadores comparan una columna contra un valor, no contra otra columna), así
 * que las primeras 5 filas van al `select` y esta se aplica en JS sobre el lote
 * ya acotado por `LIMIT 50` — el mismo patrón que `ruleMatches`/`ruleAppliesTo`
 * en expand.ts, que tampoco son SQL. Que algunas de las 50 caigan acá no
 * incumple la cota: es un techo de trabajo, no una promesa de 50 envíos.
 *
 * El techo que sí importa: como el descarte ocurre DESPUÉS del `LIMIT`, una
 * regla cuya ventana contenga más de 50 citas descartadas por esa
 * anticipación no llega a ver las que vienen detrás en ese
 * tick, y los ticks siguientes traen el mismo lote hasta que las de adelante
 * vencen. Las de atrás tienen `scheduled_at` mayor —o sea, su ventana termina
 * después—, así que en la práctica las alcanza; el caso que sí perdería el
 * recordatorio es una ventana corta (`hours_before` de 2 h) con más de 50 citas
 * agendadas tarde dentro de esas mismas 2 h. Si eso llega a pasar, el arreglo
 * NO es subir el `LIMIT`: es bajar el filtro a SQL con una RPC o una columna generada, o sea una migración.
 *
 * Y el llenado del lote **no es al azar, es adverso**: `ORDER BY scheduled_at
 * ASC` trae las más próximas, que son justamente las más propensas a haberse
 * agendado tarde y a caer en este filtro. Por eso el lote lleno se avisa por
 * `console.warn` — un techo sin señal se descubre cuando reclama un cliente.
 */
async function eligibleEventsForRule(
  db: ReturnType<typeof svc>,
  rule: TimeRule,
  config: TimeTriggerConfig,
  now: Date,
): Promise<EventInsert[]> {
  const windowEnd = new Date(now.getTime() + config.hoursBefore * 3_600_000);

  const { data, error } = await db
    .from("appointments")
    .select("id, scheduled_at, created_at, contact_id, conversation_id")
    .eq("workspace_id", rule.workspace_id)
    .in("status", ["booked", "confirmed"])
    .gt("scheduled_at", now.toISOString())
    .lte("scheduled_at", windowEnd.toISOString())
    .not("contact_id", "is", null)
    .not("conversation_id", "is", null)
    .order("scheduled_at", { ascending: true })
    .limit(APPOINTMENTS_PER_RULE);
  if (error) throw new Error(error.message);

  const batch = (data ?? []) as AppointmentRow[];
  if (batch.length === APPOINTMENTS_PER_RULE) {
    // La señal del techo del JSDoc: con el lote lleno hay citas de esta ventana
    // que este tick no llegó a mirar. No cambia comportamiento — el tick
    // siguiente las toma —, pero si esto aparece seguido para la misma regla,
    // el filtro de anticipación tiene que bajar a SQL.
    console.warn(
      `[scan-time] workspace ${rule.workspace_id} rule ${rule.id}: batch full (${APPOINTMENTS_PER_RULE}); appointments in this window were not scanned this tick`,
    );
  }

  const hoursMs = config.hoursBefore * 3_600_000;
  const rows: EventInsert[] = [];
  for (const appt of batch) {
    // Cinturón además del filtro SQL `.not(...)`: PostgREST no
    // garantiza que `select` recorte los tipos, y estos dos son NOT NULL
    // en el evento — sin ellos se quema la clave de dedup para siempre.
    if (!appt.contact_id || !appt.conversation_id) continue;

    const scheduledMs = Date.parse(appt.scheduled_at);
    const createdMs = Date.parse(appt.created_at);
    if (Number.isNaN(scheduledMs) || Number.isNaN(createdMs)) continue;
    // La cita tiene que haber existido ANTES de entrar en la ventana.
    if (!(createdMs <= scheduledMs - hoursMs)) continue;

    rows.push({
      workspace_id: rule.workspace_id,
      event_type: "appointment_upcoming",
      subject_id: appt.id,
      occurrence: `${config.hoursBefore}h:${new Date(scheduledMs).toISOString()}`,
      contact_id: appt.contact_id,
      conversation_id: appt.conversation_id,
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

    const config = parseTriggerConfig(rule.trigger_config);
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
      const hour = localHour(tz, now);
      if (hour < config.quietStart || hour >= config.quietEnd) continue;

      const rows = await eligibleEventsForRule(db, rule, config, now);
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
