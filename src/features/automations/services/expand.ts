/**
 * Expansión del outbox: automation_events → automation_runs.
 *
 * La CAPTURA la hacen tres triggers de Postgres, en la misma transacción que la
 * escritura origen (migración 20260903000000). Este módulo hace la otra mitad: decide QUÉ REGLAS
 * le tocan a cada evento capturado. Vive en TypeScript y no en el trigger
 * porque el matcher de keywords y la evaluación de `enabled_since` necesitan
 * suite de tests, y el SQL de este repo no tiene harness.
 *
 * Invariante: NUNCA lanza. La llama el cron antes del drenaje; si la expansión
 * revienta, lo ya encolado igual tiene que ejecutarse.
 *
 * Idempotencia: la da el UNIQUE (rule_id, event_id) de automation_runs. Dos
 * instancias del cron solapadas pueden expandir el mismo evento; la segunda
 * inserta cero filas. No hace falta lock.
 *
 * Reparto por workspace: NO hay cola global. Se descubre el siguiente
 * workspace con pendientes y se le expande su cupo, hasta agotar workspaces o
 * el deadline. Una cola global la monopoliza un tenant con backlog — y, si sus
 * eventos fallan siempre al expandirse, la monopoliza para siempre.
 */

import { createClient as createSbClient } from "@supabase/supabase-js";
import { normalizeText } from "@/features/inbox/services/state-machine";
import type { TriggerType } from "../lib/rule-schema";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type AutomationEventType =
  | "first_message"
  | "inbound_message"
  | "handoff_requested"
  | "lead_qualified"
  | "appointment_upcoming";

/**
 * Qué disparador de `automation_rules` consume cada tipo de evento. El único
 * que no es 1:1 es `inbound_message`: el trigger emite un evento por mensaje
 * entrante y son las reglas `keyword_match` las que deciden si les sirve.
 */
export const EVENT_TO_TRIGGER: Record<AutomationEventType, TriggerType> = {
  first_message: "first_message",
  inbound_message: "keyword_match",
  handoff_requested: "handoff_requested",
  lead_qualified: "lead_qualified",
  appointment_upcoming: "appointment_upcoming",
};

/**
 * Tope de intentos de expansión por evento. Al tercer fallo el evento se
 * cierra con `expand_error` y deja de leerse: sin esto, un evento venenoso
 * vuelve a encabezar la cola de su workspace en cada tick, para siempre.
 */
export const MAX_EXPAND_ATTEMPTS = 3;

/**
 * Lo que queda escrito en `automation_events.expand_error` al rendirse. Es un
 * CÓDIGO, no el mensaje de PostgREST: la tabla la leen los miembros del
 * workspace y el detalle técnico va a `console.error`.
 */
export const EXPAND_ERROR_CODE = "max_expand_attempts";

/** Cupo de eventos por workspace y por tick. */
const DEFAULT_PER_WORKSPACE = 50;

/** UUID mínimo: cursor inicial del recorrido por workspace. */
const UUID_ZERO = "00000000-0000-0000-0000-000000000000";

export interface AutomationEvent {
  id: number;
  workspace_id: string;
  event_type: AutomationEventType;
  subject_id: string;
  occurrence: string;
  conversation_id: string | null;
  contact_id: string | null;
  message_id: string | null;
  // Migración 20260908000000: NULLABLE a propósito. Solo la escribe
  // scanTimeTriggers(); los 4 triggers por evento de Postgres nunca la
  // llenan. Ver el guard condicional en el bucle de match, más abajo.
  rule_id: string | null;
  occurred_at: string;
  expanded_at: string | null;
  expand_attempts: number;
}

// Literal en una sola línea a propósito: partido con `+`, supabase-js pierde el
// tipo del select y devuelve GenericStringError[].
const EVENT_COLUMNS =
  "id, workspace_id, event_type, subject_id, occurrence, conversation_id, contact_id, message_id, rule_id, occurred_at, expanded_at, expand_attempts";

interface EnabledRule {
  id: string;
  trigger_type: TriggerType;
  trigger_config: unknown;
  enabled_since: string | null;
}

interface RunInsert {
  workspace_id: string;
  rule_id: string;
  event_id: number;
  trigger_type: TriggerType;
  conversation_id: string | null;
  contact_id: string | null;
}

/**
 * Única condición evaluable acá: keyword_match. El resto de los disparadores ya
 * vienen decididos por el trigger que emitió el evento.
 *
 * Las keywords se normalizan y las VACÍAS se descartan antes de comparar:
 * `haystack.includes("")` es `true`, así que una regla heredada con
 * `keywords: [""]` dispararía con cada mensaje entrante del workspace. El
 * schema (rule-schema.ts) bloquea las reglas nuevas, pero no migra las que ya están en la
 * base: este filtro es el que protege en ejecución.
 */
export function ruleMatches(
  rule: { trigger_type: TriggerType; trigger_config: unknown },
  messageBody: string | null,
): boolean {
  if (rule.trigger_type !== "keyword_match") return true;

  const config = rule.trigger_config as { keywords?: unknown } | null;
  const raw = Array.isArray(config?.keywords) ? config.keywords : [];
  const keywords = raw
    .filter((kw): kw is string => typeof kw === "string")
    .map((kw) => normalizeText(kw).trim())
    .filter((kw) => kw.length > 0);
  if (keywords.length === 0) return false;

  const haystack = normalizeText(messageBody ?? "");
  if (!haystack) return false;

  return keywords.some((kw) => haystack.includes(kw));
}

/**
 * Piso temporal de la regla, medido contra el `occurred_at` del evento y no
 * contra un reloj del cliente.
 *
 * `enabled_since` la escribe un trigger de Postgres con `clock_timestamp()`, y
 * `occurred_at` lo escribe otro trigger de Postgres: los dos son el MISMO
 * reloj, y solo comparar dos marcas del mismo reloj es confiable.
 * Una regla creada o reactivada después del hecho NUNCA dispara hacia atrás.
 *
 * Se compara con `Date.parse` y no con `<` sobre los strings porque PostgREST
 * puede devolver offsets distintos (`+00:00` vs `Z`) y el orden lexicográfico
 * mentiría. Una fecha ilegible da `NaN`, la comparación da `false` y la regla
 * no aplica: fail-closed.
 */
export function ruleAppliesTo(
  rule: { enabled: boolean; enabled_since: string | null },
  event: { occurred_at: string },
): boolean {
  if (!rule.enabled) return false;
  if (rule.enabled_since === null) return false;
  return Date.parse(rule.enabled_since) <= Date.parse(event.occurred_at);
}

/**
 * Recorre los workspaces con eventos pendientes y, por cada uno, expande hasta
 * `perWorkspace` eventos (por `id ASC`, que es el orden en que ocurrieron) a
 * runs de las reglas que les tocan.
 *
 * @param deadline     instante absoluto (`Date.now()` + presupuesto) fijado por
 *                     el cron ANTES de llamar. Se comprueba ENTRE workspaces:
 *                     cortar a la mitad de uno dejaría runs insertados con sus
 *                     eventos sin marcar.
 * @param perWorkspace cupo de eventos por workspace y por tick (50). No es un
 *                     tope global: si sobra presupuesto, se sigue con el
 *                     workspace siguiente.
 */
export async function expandAutomationEvents(
  deadline: number,
  perWorkspace = DEFAULT_PER_WORKSPACE,
): Promise<{ events: number; runs: number; errors: number; error?: string }> {
  const tally = { events: 0, runs: 0, errors: 0 };

  // Falla de FASE ≠ falla por ítem. Un tenant que falla suma a
  // `errors` y el tick sigue sano (200); lo que NO puede firmar como sano es que
  // se caiga la operación que CONSIGUE el trabajo — crear el cliente o escanear
  // los workspaces pendientes—, porque ahí el tick devuelve el tally en ceros y
  // es indistinguible de "no había nada que expandir". Viaja como CÓDIGO, nunca
  // el texto de PostgREST.
  let phaseError: string | undefined;

  // `svc()` puede lanzar (falta NEXT_PUBLIC_SUPABASE_URL o
  // SUPABASE_SERVICE_ROLE_KEY): el invariante de esta función es NUNCA
  // lanzar, así que se cubre acá y no se deja escapar hacia el cron.
  let db: ReturnType<typeof svc>;
  try {
    db = svc();
  } catch (err) {
    console.error("[expand] failed to create the Supabase client:", msg(err));
    tally.errors += 1;
    return { ...tally, error: "client_failed" };
  }

  // Cursor por workspace_id. Vive SOLO durante este tick: nada durable, nada
  // que recuperar si el proceso muere. Al tick
  // siguiente se arranca de cero y la cola igual avanza, porque cada workspace
  // expandido quedó con sus eventos marcados.
  let cursor = UUID_ZERO;

  for (;;) {
    if (Date.now() >= deadline) {
      console.warn("[expand] deadline reached; leaving the rest for the next tick");
      break;
    }

    // 1. Siguiente workspace con eventos pendientes que todavía se pueden
    //    reintentar. Sale por idx_automation_events_pending (workspace_id, id).
    let workspaceId: string | null;
    try {
      const { data, error } = await db
        .from("automation_events")
        .select("workspace_id")
        .is("expanded_at", null)
        .lt("expand_attempts", MAX_EXPAND_ATTEMPTS)
        .gt("workspace_id", cursor)
        .order("workspace_id", { ascending: true })
        .limit(1);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Array<{ workspace_id: string }>;
      workspaceId = rows.length > 0 ? rows[0].workspace_id : null;
    } catch (err) {
      console.error("[expand] failed to scan workspaces with pending events:", msg(err));
      tally.errors += 1;
      phaseError = "scan_failed";
      break;
    }

    if (workspaceId === null) break; // no queda nada pendiente
    cursor = workspaceId;

    // 2. El lote de ESE workspace. Todo lo que sigue es por tenant, así que un
    //    tenant caído no arrastra a los demás.
    let wsEvents: AutomationEvent[];
    try {
      const { data, error } = await db
        .from("automation_events")
        .select(EVENT_COLUMNS)
        .eq("workspace_id", workspaceId)
        .is("expanded_at", null)
        .lt("expand_attempts", MAX_EXPAND_ATTEMPTS)
        .order("id", { ascending: true })
        .limit(perWorkspace);
      if (error) throw new Error(error.message);
      wsEvents = (data ?? []) as AutomationEvent[];
    } catch (err) {
      console.error(`[expand] workspace ${workspaceId}: failed to load events:`, msg(err));
      tally.errors += 1;
      continue; // sin las filas no se puede ni contar el intento
    }

    if (wsEvents.length === 0) continue;

    try {
      // 3. Cuerpos de los mensajes del lote, en UNA query. Sin esto, un lote de
      //    50 eventos keyword_match serían 50 round-trips del presupuesto.
      const messageIds = [
        ...new Set(
          wsEvents.map((e) => e.message_id).filter((id): id is string => id !== null),
        ),
      ];
      const bodies = new Map<string, string | null>();
      if (messageIds.length > 0) {
        const { data, error } = await db
          .from("messages")
          .select("id, body")
          .eq("workspace_id", workspaceId)
          .in("id", messageIds);
        if (error) throw new Error(error.message);
        for (const row of (data ?? []) as Array<{ id: string; body: string | null }>) {
          bodies.set(row.id, row.body);
        }
      }

      const { data: ruleData, error: ruleError } = await db
        .from("automation_rules")
        .select("id, trigger_type, trigger_config, enabled_since")
        .eq("workspace_id", workspaceId)
        .eq("enabled", true);
      if (ruleError) throw new Error(ruleError.message);
      const rules = (ruleData ?? []) as EnabledRule[];

      const rows: RunInsert[] = [];
      for (const event of wsEvents) {
        const wanted = EVENT_TO_TRIGGER[event.event_type];
        for (const rule of rules) {
          if (rule.trigger_type !== wanted) continue;
          // Guard CONDICIONAL a propósito (migración 20260908000000). Un
          // evento por TIEMPO trae su rule_id: solo puede expandir a la regla
          // que lo generó. Sin esto, dos reglas appointment_upcoming del mismo
          // workspace con distinto hours_before (24h y 2h) comparten
          // trigger_type y expandirían las DOS al mismo evento — el doble de
          // mensajes de los que pide cada regla. Los 4 triggers por EVENTO
          // (first_message, inbound_message, handoff_requested,
          // lead_qualified) NUNCA escriben rule_id: para ellos event.rule_id
          // es null y el guard queda inerte.
          if (event.rule_id && rule.id !== event.rule_id) continue;
          // La query ya filtró por enabled; se pasa `true` explícito para que
          // ruleAppliesTo siga siendo una función pura y testeable sola.
          if (!ruleAppliesTo({ enabled: true, enabled_since: rule.enabled_since }, event)) {
            continue;
          }
          if (wanted === "keyword_match") {
            const body = event.message_id ? bodies.get(event.message_id) ?? null : null;
            if (!ruleMatches(rule, body)) continue;
          }
          rows.push({
            workspace_id: workspaceId,
            rule_id: rule.id,
            event_id: event.id,
            trigger_type: rule.trigger_type,
            conversation_id: event.conversation_id,
            contact_id: event.contact_id,
          });
        }
      }

      // 4. Runs PRIMERO. Si esto falla, el throw salta el marcado y los eventos
      //    quedan pendientes. Al revés se perderían los disparadores.
      //    `ignoreDuplicates` hace que un choque contra el UNIQUE devuelva 0
      //    filas SIN error: eso no es un fallo, es la carrera absorbida.
      if (rows.length > 0) {
        const { data: insertedRows, error: upsertError } = await db
          .from("automation_runs")
          .upsert(rows, {
            onConflict: "rule_id,event_id",
            ignoreDuplicates: true,
          })
          .select("id");
        if (upsertError) throw new Error(upsertError.message);
        tally.runs += (insertedRows ?? []).length;
      }

      // 5. Recién ahora se marcan expandidos. Un evento sin ninguna regla que lo
      //    consuma también se marca: si no, se re-leería en cada tick para
      //    siempre.
      const ids = wsEvents.map((e) => e.id);
      // new Date() a propósito, NO new Date(Date.now()): en V8 el segundo
      // constructor sí lee Date.now(), y el test que congela el reloj para
      // probar el corte del deadline lo notaría (ver expand.test.ts).
      const { error: markError } = await db
        .from("automation_events")
        .update({ expanded_at: new Date().toISOString() })
        .in("id", ids);
      if (markError) throw new Error(markError.message);
      tally.events += ids.length;
    } catch (err) {
      // Un tenant caído no puede dejar a los demás sin expandir, y tampoco
      // puede quedar reintentándose para siempre: se cuenta el intento.
      tally.errors += 1;
      console.error(`[expand] workspace ${workspaceId} failed:`, msg(err));
      await countExpandAttempt(db, wsEvents);
    }
  }

  // Sin fallo de fase, la forma del objeto es la de siempre.
  return phaseError ? { ...tally, error: phaseError } : tally;
}

/**
 * Suma un intento de expansión a los eventos del lote que falló y, a los que
 * llegan a MAX_EXPAND_ATTEMPTS, los cierra con `expand_error` para que la
 * lectura de pendientes deje de traerlos.
 *
 * PostgREST no acepta expresiones que referencien columnas en un UPDATE, así
 * que no existe `expand_attempts = expand_attempts + 1`: se agrupa por el valor
 * que ya se leyó y se escribe el siguiente. Son a lo sumo tres sentencias
 * (rendirse, 0→1, 1→2).
 *
 * Es un contador de píldora venenosa, no un saldo: si dos ticks solapados
 * pisan un incremento, el peor caso es un intento de más. Best-effort a
 * propósito — un fallo acá se loguea y no cambia el tally, porque el error real
 * ya se contó.
 */
async function countExpandAttempt(
  db: ReturnType<typeof svc>,
  events: AutomationEvent[],
): Promise<void> {
  const giveUp: number[] = [];
  const bump = new Map<number, number[]>(); // attempts actuales → ids

  for (const event of events) {
    const next = event.expand_attempts + 1;
    if (next >= MAX_EXPAND_ATTEMPTS) {
      giveUp.push(event.id);
    } else {
      const list = bump.get(event.expand_attempts);
      if (list) list.push(event.id);
      else bump.set(event.expand_attempts, [event.id]);
    }
  }

  try {
    if (giveUp.length > 0) {
      // Único trace de un evento perdido para siempre: sin esto, el único
      // rastro es la columna expand_error, no greppable en los logs de Vercel.
      console.error(
        `[expand] giving up on events after ${MAX_EXPAND_ATTEMPTS} attempts:`,
        giveUp,
      );
      // NO se escribe `expanded_at` acá. El contador por sí solo saca la fila
      // de las dos lecturas de pendientes
      // (`.lt("expand_attempts", MAX_EXPAND_ATTEMPTS)`, más arriba); marcar
      // `expanded_at` la volvería indistinguible de un evento expandido con
      // éxito y un chequeo de salud la contaría como sana. Con `expanded_at IS NULL` + `expand_error IS NOT NULL` la fila
      // queda en cuarentena, revisable, y se reintenta con
      // `UPDATE … SET expand_attempts = 0, expand_error = NULL`.
      const { error } = await db
        .from("automation_events")
        .update({
          expand_attempts: MAX_EXPAND_ATTEMPTS,
          expand_error: EXPAND_ERROR_CODE,
        })
        .in("id", giveUp);
      if (error) throw new Error(error.message);
    }

    for (const [current, ids] of bump) {
      const { error } = await db
        .from("automation_events")
        .update({ expand_attempts: current + 1 })
        .in("id", ids);
      if (error) throw new Error(error.message);
    }
  } catch (err) {
    console.error("[expand] failed to record expand attempt:", msg(err));
  }
}
