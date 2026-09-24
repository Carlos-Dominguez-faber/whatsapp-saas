/**
 * Ejecutor del motor de automatizaciones.
 *
 * Toma una fila ya reclamada por claim_next_automation_run() y despacha por
 * action_type. Cada fila termina en done | failed | skipped y deja su evento; un
 * fallo nunca bloquea a las demás. `retry` la devuelve a la cola con backoff y
 * `lost` significa que otro worker se llevó el lease en el medio.
 *
 * La expansión (expand.ts) ya filtró las reglas por `enabled_since <=
 * occurred_at` al CREAR el run. Acá se comprueba, además, que la regla
 * siga habilitada. El PISO TEMPORAL ya NO se evalúa en este
 * archivo: vive en `claim_next_automation_run()`, que compara el `occurred_at`
 * del evento contra el `enabled_since` vigente en la misma transacción que
 * reclama la fila (migración 20260904000002). Este ejecutor ejecuta lo que la
 * RPC le entrega y no vuelve a filtrar por `enabled_since`.
 */

import { createClient as createSbClient } from "@supabase/supabase-js";
import {
  prepareTemplateDispatch,
  sendPreparedTemplate,
} from "@/features/inbox/services/dispatch";
import {
  applyTransition,
  TransitionError,
} from "@/features/inbox/services/decision-engine";
import {
  addTagToContact,
  requestHandoff,
  ConfigError,
} from "@/features/inbox/services/conversation-actions";
import {
  buildTemplateComponents,
  loadVariableContext,
  resolveVariables,
} from "./variables";
import type { ActionType, TriggerType } from "../lib/rule-schema";

/** Marcador que obliga a tener `business_info.structured.name` configurado. */
const BUSINESS_NAME_MARKER = "{{business.name}}";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export interface AutomationRun {
  id: string;
  workspace_id: string;
  rule_id: string;
  /** Evento del outbox que originó este run. `UNIQUE (rule_id, event_id)`. */
  event_id: number;
  trigger_type: TriggerType;
  conversation_id: string | null;
  contact_id: string | null;
  status: "pending" | "processing" | "done" | "failed" | "skipped";
  attempts: number;
  error: string | null;
  not_before: string;
  /** Token de lease devuelto por el claim. Va en el WHERE de cada escritura. */
  claimed_at: string | null;
  /** Ya se llamó a Kapso por esta fila. Un reintento NO lo repite. */
  dispatched_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export type RunOutcome = "done" | "failed" | "skipped" | "retry" | "lost";

interface RuleRow {
  id: string;
  name: string;
  action_type: ActionType;
  action_config: Record<string, unknown>;
  enabled: boolean;
}

interface ActionResult {
  outcome: RunOutcome;
  /** Motivo fijo (ver más abajo). Va a automation_runs.error. */
  error?: string;
}

/**
 * Motivos FIJOS. Son códigos, no frases: los muestra el panel
 * y los agrupa cualquier consulta de operación. El detalle técnico va al log
 * server-side, nunca a la fila ni a la respuesta HTTP.
 *
 *   skipped: rule_disabled | rule_reenabled | no_conversation | conversation_gone
 *            | transition_not_allowed | opted_out | already_assigned
 *            | appointment_not_active
 *   failed:  outcome_unknown | cross_workspace | conversation_not_found
 *            | missing_business_name | missing_appointment | contact_not_found
 *            | invalid_config | empty_tag | internal_error | template_paused
 *   retry:   db_read_failed | dispatch_prepare_failed | dispatch_mark_failed
 *            | tag_write_failed | handoff_failed | close_failed | assign_failed
 *
 * `empty_tag` lo escribe `actAddTag` desde el `err.code` de un `ConfigError` de
 * `addTagToContact`: la regla se guardó sin `tag` y reintentarla no la arregla.
 *
 * `max_attempts` también es un motivo de `failed`, pero lo escribe la RPC del
 * claim, no este archivo.
 *
 * Detalle de algunos motivos:
 *  - `conversation_gone`: el run nació con conversación y la perdió por el
 *    ON DELETE SET NULL. Distinto de `no_conversation`, que es "este contacto
 *    nunca tuvo conversación en este workspace".
 *  - `opted_out`: un solo nombre para los
 *    dos lugares que lo escriben — el guard temprano del ejecutor y la RPC
 *    `mark_automation_run_dispatched` —, porque el panel agrupa por este texto.
 *  - `already_assigned`: la conversación ya tenía dueño y no se le pisa.
 *  - `not_found` de la RPC tiene DOS causas y NO terminan igual: si la
 *    fila ya no está en `processing` es `lost` (no se le escribe encima); si
 *    sigue en `processing` es `skipped/conversation_gone`. Ver `actSendTemplate`.
 *  - `internal_error`: excepción no clasificada. El detalle va SOLO al log
 *    server-side; esta columna la lee cualquier miembro del workspace.
 *  - `rule_reenabled`: el HECHO que originó el run
 *    (`automation_events.occurred_at`) es anterior al `enabled_since` vigente
 *    de la regla (se apagó y se reactivó después). Distinto de
 *    `rule_disabled`, que es "la regla sigue apagada ahora mismo". Igual que
 *    `max_attempts`, este código lo escribe la RPC del claim (migración
 *    20260904000002), NO este archivo.
 *  - `template_paused`: Meta devolvió el código 132015 —
 *    plantilla pausada— al intentar el envío. Usa `fail()`, no `retry()`:
 *    reintentar no descongela la plantilla, así que cierra sin gastar los 3
 *    intentos. Además apaga la regla (`disableRuleForTemplatePause`). Ningún
 *    otro código de Meta apaga nada, `132001` incluido: cierran
 *    `outcome_unknown` como siempre.
 *  - `missing_appointment`: el
 *    run es de `appointment_upcoming` y la cita (`automation_events.subject_id`
 *    → `appointments.id`) no se pudo resolver — el evento no la tiene, la
 *    fila ya no existe, es de otro workspace, o `scheduled_at` no se pudo
 *    formatear. `fail()`, no `skip()`: mismo criterio que
 *    `missing_business_name`, es un dato que falta, no "el mundo cambió".
 *    Nunca se manda la plantilla con `{{appointment.date}}` vacío.
 *  - `appointment_not_active`: la
 *    cita SÍ se leyó, pero justo antes de enviar ya no está `booked` ni
 *    `confirmed` (se canceló, se completó, no_show). `skip()`, no `fail()`:
 *    la cita cambió de estado entre el evento y el envío, no es un error del
 *    motor. El guard es el mismo criterio que `buffer.ts` (releer el
 *    estado justo antes de despachar), pero acá SÍ se reintenta ante un
 *    fallo de LECTURA (`db_read_failed`): un hipo transitorio de la base no
 *    puede cancelar un recordatorio legítimo, a diferencia del guard de
 *    buffer.ts, que es fail-open porque ahí "no responder" es peor que
 *    "responder de más".
 */
const DONE: ActionResult = { outcome: "done" };
const skip = (error: string): ActionResult => ({ outcome: "skipped", error });
const fail = (error: string): ActionResult => ({ outcome: "failed", error });
/**
 * Error transitorio: la fila vuelve a `pending` con backoff.
 *
 * También recibe un CÓDIGO del catálogo, no una frase. La columna
 * `automation_runs.error` la agrupa el panel, y una frase distinta por call
 * site rompía esa agrupación. La frase en español vive en el `console.error`
 * que acompaña a cada uno, server-side.
 */
const retry = (error: string): ActionResult => ({ outcome: "retry", error });

/** El UPDATE terminal devolvió error. NO es "no afectó filas" (eso es `lost`). */
class FinishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinishError";
  }
}

// ── Aislamiento multi-tenant ──────────────────────────────────────────────────

type LoadProblem = "missing" | "cross_workspace" | "db";

/**
 * Carga una fila del workspace del run.
 *
 * El filtro `.eq("workspace_id", …)` es la barrera real: lo aplica Postgres y no
 * se puede olvidar. Pero filtrando, "no existe" y "es de otro tenant" devuelven
 * lo mismo (null), y esos dos casos NO pueden terminar igual: el primero es el
 * mundo que cambió (skipped) y el segundo un incidente de aislamiento que tiene
 * que quedar en `events` (failed). Por eso, y SOLO cuando la carga filtrada
 * vuelve vacía, se hace una segunda lectura por id a secas para distinguirlos:
 * una consulta extra únicamente en el camino anómalo.
 */
async function loadScoped<T>(
  table: string,
  id: string,
  columns: string,
  workspaceId: string,
): Promise<{ row: T | null; problem: LoadProblem | null }> {
  const supabase = svc();

  const { data, error } = await supabase
    .from(table)
    .select(columns)
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (error) {
    console.error(`[automations] no pude leer ${table}:`, error.message);
    return { row: null, problem: "db" };
  }
  if (data) return { row: data as T, problem: null };

  const { data: probe, error: probeError } = await supabase
    .from(table)
    .select("id")
    .eq("id", id)
    .maybeSingle();

  if (probeError) {
    console.error(`[automations] no pude confirmar ${table}:`, probeError.message);
    return { row: null, problem: "db" };
  }
  if (probe) {
    console.error("[automations] cross_workspace:", { table, id, workspaceId });
    return { row: null, problem: "cross_workspace" };
  }
  return { row: null, problem: "missing" };
}

/**
 * Resuelve la conversación de un run que no la trae — el caso de
 * `lead_qualified`, cuyo trigger (AFTER UPDATE OF stage ON contacts) tiene el
 * contacto y la versión pero no una conversación a mano.
 *
 * Sin esto, cuatro de las cinco acciones nativas terminarían
 * `skipped/no_conversation` para ese disparador. Se hace acá y no en el trigger
 * porque el ejecutor es el único punto de carga de conversación: duplicar la
 * lógica en dos lugares es cómo se desincronizan.
 *
 * "La conversación del contacto" = la más reciente por `last_message_at` EN ESTE
 * WORKSPACE. El filtro no es decorativo: sin él, un contacto que existe en dos
 * tenants mandaría el WhatsApp por la conversación equivocada.
 */
async function resolveConversationForContact(
  workspaceId: string,
  contactId: string,
): Promise<{ id: string | null; dbError: boolean }> {
  const { data, error } = await svc()
    .from("conversations")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("contact_id", contactId)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1);

  if (error) {
    console.error("[automations] no pude resolver la conversación:", error.message);
    return { id: null, dbError: true };
  }
  const row = ((data as Array<{ id: string }> | null) ?? [])[0];
  return { id: row?.id ?? null, dbError: false };
}

/**
 * Deja la conversación resuelta escrita en el run, con la condición de lease,
 * para que el evento de cierre y el historial del panel la citen. Si el UPDATE
 * no afecta nada, otro worker se llevó el lease: no se pisa.
 */
async function persistResolvedConversation(
  run: AutomationRun,
  conversationId: string,
): Promise<void> {
  const { error } = await svc()
    .from("automation_runs")
    .update({ conversation_id: conversationId })
    .eq("id", run.id)
    .eq("workspace_id", run.workspace_id)
    .eq("status", "processing")
    .eq("claimed_at", run.claimed_at);

  if (error) {
    // NO es cosmético para `send_template`: `mark_automation_run_dispatched`
    // hace el JOIN sobre `r.conversation_id`, la columna PERSISTIDA, no sobre
    // la copia en memoria. Si este UPDATE falló, la RPC devuelve `not_found`
    // por la rama del JOIN y el run se cierra `skipped/conversation_gone` sin
    // enviar. Para las otras cuatro acciones sí es solo el enlace del panel.
    console.error("[automations] no pude persistir conversation_id:", {
      runId: run.id,
      message: error.message,
    });
  }
}

/**
 * `appointments.id` del run.
 *
 * `automation_events.subject_id` es genérico (lo comparten los cuatro tipos
 * de evento); para `appointment_upcoming` ES el id de la cita. Se
 * filtra también por `event_type` como defensa en profundidad: si algún día
 * `run.trigger_type` y el `event_type` real del evento se desincronizan, esto
 * falla cerrado (`id: null`) en vez de leer el `subject_id` de otro tipo de
 * evento como si fuera una cita.
 *
 * Solo lo llama `actSendTemplate`, y solo cuando `run.trigger_type ===
 * "appointment_upcoming"`: los otros cuatro disparadores no tienen cita
 * detrás y no pagan esta consulta.
 */
async function resolveAppointmentSubjectId(
  run: AutomationRun,
): Promise<{ id: string | null; dbError: boolean }> {
  const { data, error } = await svc()
    .from("automation_events")
    .select("subject_id")
    .eq("id", run.event_id)
    .eq("workspace_id", run.workspace_id)
    .eq("event_type", "appointment_upcoming")
    .maybeSingle();

  if (error) {
    console.error("[automations] no pude leer el evento de la cita:", {
      runId: run.id,
      message: error.message,
    });
    return { id: null, dbError: true };
  }
  return {
    id: (data as { subject_id: string } | null)?.subject_id ?? null,
    dbError: false,
  };
}

/** Los cuatro desenlaces de `mark_automation_run_dispatched`. */
type DispatchClaim = "ok" | "opted_out" | "already_dispatched" | "not_found";

/**
 * Escribe `dispatched_at` INMEDIATAMENTE antes del POST a Kapso — nunca antes
 * de las lecturas. El UNIQUE de la tabla protege la FILA, no el EFECTO:
 * sin esto, un worker que muere entre el envío y el cierre deja la fila
 * reclamable y el reintento manda el WhatsApp de nuevo.
 *
 * Es una RPC y no un UPDATE desde acá porque la comprobación de opt-in y
 * el marcado tienen que ser LA MISMA SENTENCIA. Antes el `opt_in` se leía en el
 * paso 3 de `executeRun`, después se marcaba y recién después se enviaba: un
 * opt-out que entraba en el medio no lo veía nadie y el WhatsApp salía igual.
 *
 * La ventana que QUEDA es la del POST mismo (la red), y se acepta declarada: un
 * opt-out que llega con el request en vuelo se atiende en el envío siguiente.
 *
 * Nota de scope: la RPC filtra por la conversación del run y su workspace, así
 * que no hace falta pasarle `workspace_id`; el lease lo comprueba por
 * `status = 'processing'`.
 */
async function markDispatched(
  run: AutomationRun,
): Promise<{ claim: DispatchClaim | null; dbError: boolean }> {
  const { data, error } = await svc().rpc("mark_automation_run_dispatched", {
    p_run_id: run.id,
  });

  if (error) {
    console.error("[automations] markDispatched error:", error.message);
    return { claim: null, dbError: true };
  }
  return { claim: data as DispatchClaim, dbError: false };
}

/**
 * ¿La fila sigue reclamada? Solo sirve para desambiguar el `not_found` de
 * `mark_automation_run_dispatched`, que lo devuelve por dos caminos distintos.
 *
 * Ante un error de lectura responde `false`, que es el camino conservador de
 * siempre (`lost`, sin escribir): el lease de 7 minutos la recupera.
 */
async function runIsProcessing(run: AutomationRun): Promise<boolean> {
  const { data, error } = await svc()
    .from("automation_runs")
    .select("status")
    .eq("id", run.id)
    .eq("workspace_id", run.workspace_id)
    .maybeSingle();

  if (error) {
    console.error("[automations] no pude releer el estado del run:", {
      runId: run.id,
      message: error.message,
    });
    return false;
  }
  return (data as { status: string } | null)?.status === "processing";
}

/**
 * Meta pausó la plantilla (132015): apaga la regla para no seguir
 * disparando envíos que van a fallar todos igual.
 *
 * Escribe con `service_role`, así que el filtro `workspace_id` va ACÁ DENTRO
 * y no en el caller: un guard en el caller se reabre con el
 * próximo caller. Encadena `.select("id")` como `publishPromptVersion`
 * (`prompt-resolver.ts`): sin eso, un UPDATE que afecta 0 filas no da error y
 * quedaría reportado como apagado sin serlo.
 *
 * Best-effort: si falla o no afecta filas, el run igual cierra
 * `failed/template_paused` — el apagado es una mitigación aparte, no una
 * condición para cerrar el run.
 */
async function disableRuleForTemplatePause(
  workspaceId: string,
  ruleId: string,
): Promise<void> {
  const { data, error } = await svc()
    .from("automation_rules")
    .update({ enabled: false })
    .eq("id", ruleId)
    .eq("workspace_id", workspaceId)
    .select("id");

  if (error) {
    console.error("[automations] no pude apagar la regla tras 132015:", {
      ruleId,
      workspaceId,
      message: error.message,
    });
    return;
  }
  if (!data || data.length === 0) {
    console.warn("[automations] apagado por 132015 afectó 0 filas:", {
      ruleId,
      workspaceId,
    });
  }
}

// ── Acciones ──────────────────────────────────────────────────────────────────

async function actSendTemplate(
  run: AutomationRun,
  rule: RuleRow,
  contact: { id: string; opt_in: boolean | null } | null,
  contactReadFailed: boolean,
): Promise<ActionResult> {
  const templateName =
    typeof rule.action_config.template_name === "string"
      ? rule.action_config.template_name
      : "";
  if (!templateName) return fail("invalid_config");
  if (!run.conversation_id) return skip("no_conversation");

  // Opt-out FAIL-CLOSED. dispatch.ts también chequea, pero un motor desatendido
  // no puede apoyarse en un guard que ante la duda envía.
  if (contactReadFailed) return retry("db_read_failed");
  if (!contact) return skip("no_conversation");
  // Corte temprano: ahorra el preflight completo. La comprobación que MANDA es
  // la de la RPC `mark_automation_run_dispatched`, atómica con el marcado.
  if (contact.opt_in === false) return skip("opted_out");

  const rawVariables = Array.isArray(rule.action_config.variables)
    ? (rule.action_config.variables as unknown[]).filter(
        (v): v is string => typeof v === "string",
      )
    : [];

  // Solo los runs de `appointment_upcoming` tienen una cita detrás.
  // Se resuelve el id ANTES de cargar las variables porque loadVariableContext
  // lo necesita para consultar `appointments`.
  let appointmentId: string | null = null;
  if (run.trigger_type === "appointment_upcoming") {
    const subject = await resolveAppointmentSubjectId(run);
    if (subject.dbError) return retry("db_read_failed");
    if (!subject.id) return fail("missing_appointment");
    appointmentId = subject.id;
  }

  // Las variables se resuelven ANTES del despacho: si falta un dato o no se
  // puede leer, no hay nada que marcar ni que enviar.
  const load = await loadVariableContext({
    workspaceId: run.workspace_id,
    contactId: contact.id,
    appointmentId,
  });
  // Lectura caída ≠ dato ausente. La primera se reintenta; la segunda es
  // configuración y no se arregla sola.
  if (!load.ok) return retry("db_read_failed");

  // Sin cita resuelta no hay
  // fecha/hora que poner en la plantilla. `fail`, no `skip`: es un dato que
  // falta (mismo criterio que `missing_business_name`), no "el mundo cambió".
  if (appointmentId && !load.ctx.appointment) return fail("missing_appointment");

  // Releer el estado de la cita ACÁ, antes de todo el preflight de dispatch.ts
  // y de `markDispatched`: hasta ~14 min pueden pasar entre el evento que la
  // disparó y este punto (backoff de reintentos), y más con backlog. Mismo
  // criterio que el guard de buffer.ts, pero un fallo de LECTURA se reintenta en vez de
  // saltearse (línea de arriba, `!load.ok` → `retry`): un hipo de la base no
  // puede cancelar un recordatorio legítimo.
  if (
    appointmentId &&
    load.ctx.appointment &&
    !["booked", "confirmed"].includes(load.ctx.appointment.status)
  ) {
    return skip("appointment_not_active");
  }

  if (rawVariables.includes(BUSINESS_NAME_MARKER) && !load.ctx.businessName) {
    // Sin respaldo a workspaces.name a propósito: ese es el nombre
    // interno de la cuenta y mandárselo al cliente es una fuga.
    return fail("missing_business_name");
  }

  // PREFLIGHT: todas las lecturas de dispatch.ts (conversación, teléfono,
  // opt-in, integración de Kapso) ocurren ACÁ, antes de marcar nada. Con el
  // orden anterior, una caída transitoria leyendo la integración cerraba el run
  // como fallo definitivo sin que jamás hubiera existido un request externo.
  const prep = await prepareTemplateDispatch({
    workspaceId: run.workspace_id,
    conversationId: run.conversation_id,
    templateName,
    templateLanguage: "es",
    components: buildTemplateComponents(resolveVariables(rawVariables, load.ctx)),
  });

  if (!prep.ok) {
    if (prep.errorCode === "OPT_OUT") return skip("opted_out");
    // `retryable` acá sí se mira, y es seguro: todavía no se marcó el despacho
    // ni se llamó a Kapso, así que reintentar no puede duplicar nada.
    if (prep.retryable) {
      console.error("[automations] no pude preparar el envío de la plantilla:", {
        runId: run.id,
        errorCode: prep.errorCode,
      });
      return retry("dispatch_prepare_failed");
    }
    return fail("invalid_config");
  }

  // El marcado y la última comprobación de opt-in, en una sentencia.
  const claim = await markDispatched(run);
  if (claim.dbError) return retry("dispatch_mark_failed");
  switch (claim.claim) {
    case "ok":
      break;
    case "opted_out":
      // El contacto se dio de baja entre el preflight y esta línea. No es un
      // fallo del motor: es el sistema respetando el opt-out.
      return skip("opted_out");
    case "already_dispatched":
      // El efecto externo ya salió en otro intento. Nunca `done`: un éxito no
      // verificado no se registra como éxito.
      return fail("outcome_unknown");
    default: {
      // 'not_found' sale por DOS ramas de la RPC (migración
      // 20260903000000) que NO pueden terminar igual:
      //
      //  (a) `v_status IS NULL OR v_status <> 'processing'`: la fila no existe
      //      o ya la cerró otro worker. `lost`: no se le escribe encima.
      //  (b) el `IF NOT v_has_conv` final: la fila SIGUE en `processing`, con
      //      `dispatched_at IS NULL`, pero el JOIN no encuentra conversación ni
      //      contacto. Devolver `lost` acá dejaba la fila sin estado terminal y
      //      sin evento: el lease la recuperaba tres veces y moría como
      //      `max_attempts` por un run que demostrablemente nunca despachó.
      //
      // El caso (b) es alcanzable sin ninguna carrera de borrado: si el UPDATE
      // de `persistResolvedConversation` falló, la RPC hace el JOIN sobre un
      // `conversation_id` que sigue NULL en la fila.
      //
      // NO es "el lease venció y alguien la reclamó": ese run sigue en
      // `processing`, así que el worker viejo recibe `ok` o
      // `already_dispatched`, nunca `not_found`.
      const stillClaimed = await runIsProcessing(run);
      return stillClaimed ? skip("conversation_gone") : { outcome: "lost" };
    }
  }

  const result = await sendPreparedTemplate(prep.prepared);

  if (result.ok) return DONE;
  if (result.errorCode === "OPT_OUT") return skip("opted_out");
  // 132015 = plantilla pausada por Meta. Reintentar no la descongela:
  // fail(), no retry(), así que no gasta los 3 intentos. Cualquier otro
  // código (132001 incluido) sigue cerrando outcome_unknown sin apagar nada.
  if (result.providerCode === 132015) {
    await disableRuleForTemplatePause(run.workspace_id, rule.id);
    return fail("template_paused");
  }
  // Después de dispatched_at NO se reintenta, y NO se mira `retryable`: para un
  // timeout de Kapso viene `true`, y reintentar es exactamente el duplicado que
  // dispatched_at existe para evitar.
  return fail("outcome_unknown");
}

async function actAddTag(
  run: AutomationRun,
  rule: RuleRow,
  contact: { id: string } | null,
  contactReadFailed: boolean,
): Promise<ActionResult> {
  const tag =
    typeof rule.action_config.tag === "string" ? rule.action_config.tag : "";
  if (!tag) return fail("invalid_config");
  // Una lectura CAÍDA del contacto no es un contacto inexistente. Sin este
  // guard, un parpadeo de la base cerraba el run como `failed
  // contact_not_found` (configuración, sin reintento) por un problema que se
  // arregla solo al tick siguiente. Mismo criterio que send_template.
  if (contactReadFailed) return retry("db_read_failed");
  if (!contact) return fail("contact_not_found");

  try {
    // Devuelve `true` si agregó y `false` si el contacto YA la tenía. Los dos
    // son éxito: tratar el segundo como fallo dejaba en bucle a todo run
    // posterior de la misma regla hasta agotar los intentos.
    await addTagToContact({
      workspaceId: run.workspace_id,
      contactId: contact.id,
      tag,
    });
    return DONE;
  } catch (err) {
    // ConfigError = el mundo no tiene lo que la regla nombra. No se arregla
    // solo: failed, sin reintento.
    if (err instanceof ConfigError) return fail(err.code);
    // Cualquier otra cosa es transitoria (base caída, red): se reintenta. El
    // detalle va al log, no a la fila.
    console.error("[automations] add_tag falló:", { runId: run.id, err });
    return retry("tag_write_failed");
  }
}

/**
 * `requestHandoff` devuelve `false` SOLO cuando la transición no está
 * permitida (el mundo cambió: la conversación ya está en handoff, o cerrada).
 * Cualquier otro problema lo RELANZA, y acá eso es `retry`: tragarlo como
 * `skipped` perdería handoffs legítimos ante una caída de la base.
 */
async function actHandoff(run: AutomationRun): Promise<ActionResult> {
  if (!run.conversation_id) return skip("no_conversation");
  try {
    const ok = await requestHandoff({
      workspaceId: run.workspace_id,
      conversationId: run.conversation_id,
      reason: "automation",
    });
    return ok ? DONE : skip("transition_not_allowed");
  } catch (err) {
    console.error("[automations] handoff_human falló:", { runId: run.id, err });
    return retry("handoff_failed");
  }
}

/** Mismo criterio que actHandoff, pero acá el distingo es por tipo. */
async function actClose(run: AutomationRun): Promise<ActionResult> {
  if (!run.conversation_id) return skip("no_conversation");
  try {
    await applyTransition(run.conversation_id, "closed", {
      trigger: "automation",
      workspaceId: run.workspace_id,
    });
    return DONE;
  } catch (err) {
    // Ya cerrada, o en un estado desde el que no se puede cerrar: el mundo
    // cambió, la automatización no falló.
    if (err instanceof TransitionError) return skip("transition_not_allowed");
    // Base caída o red: se reintenta. Terminarlo `skipped` dejaría la
    // conversación abierta para siempre sin que nadie se enterara.
    console.error("[automations] close_conversation falló:", { runId: run.id, err });
    return retry("close_failed");
  }
}

async function actAssignAgent(
  run: AutomationRun,
  rule: RuleRow,
): Promise<ActionResult> {
  const userId =
    typeof rule.action_config.user_id === "string"
      ? rule.action_config.user_id
      : "";
  if (!userId) return fail("invalid_config");
  if (!run.conversation_id) return skip("no_conversation");

  const supabase = svc();
  const { data: member, error: memberError } = await supabase
    .from("memberships")
    .select("user_id")
    .eq("workspace_id", run.workspace_id)
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle();

  if (memberError) {
    console.error("[automations] no pude comprobar la membresía:", {
      runId: run.id,
      message: memberError.message,
    });
    return retry("db_read_failed");
  }
  if (!member) return fail("invalid_config");

  // `assigned_to IS NULL` en el WHERE. Un UPDATE incondicional convertiría un
  // reintento tras lease vencido en un PISADO: el motor asigna a X, un
  // supervisor reasigna a Y, el lease vence, el motor reintenta y la
  // conversación vuelve a X sin que nadie lo pida. "Idempotente" en la tabla de
  // `finish` solo es cierto si nadie más escribió entre medio.
  //
  // `.select("id")` para saber si REALMENTE se escribió: entre la carga de la
  // conversación y esta línea la fila pudo borrarse, y un UPDATE que no toca
  // nada no devuelve error. Declarar `done` sobre eso es mentir en el panel.
  const { data, error } = await supabase
    .from("conversations")
    .update({ assigned_to: userId, updated_at: new Date().toISOString() })
    .eq("id", run.conversation_id)
    .eq("workspace_id", run.workspace_id)
    .is("assigned_to", null)
    .select("id");

  if (error) {
    console.error("[automations] no pude asignar la conversación:", {
      runId: run.id,
      message: error.message,
    });
    return retry("assign_failed");
  }
  if (((data as unknown[] | null) ?? []).length === 1) return DONE;

  // 0 filas: o la conversación ya no está, o ya tenía dueño. Hay que RELEER
  // para no confundir "la asignación ya estaba hecha" (éxito idempotente) con
  // "otro se la llevó" (skipped) ni con "no existe" (failed).
  const { data: current, error: readError } = await supabase
    .from("conversations")
    .select("assigned_to")
    .eq("id", run.conversation_id)
    .eq("workspace_id", run.workspace_id)
    .maybeSingle();

  if (readError) {
    console.error("[automations] no pude releer la conversación:", {
      runId: run.id,
      message: readError.message,
    });
    return retry("db_read_failed");
  }
  if (!current) return fail("conversation_not_found");

  const owner = (current as { assigned_to: string | null }).assigned_to;
  if (owner === userId) {
    // Este mismo run ya la había asignado en un intento anterior: idempotente.
    return DONE;
  }

  // Otro humano (o otra regla) la tomó. No se le pisa y no es un fallo del
  // motor: el mundo cambió.
  console.warn("[automations] assign_agent: la conversación ya tenía dueño", {
    runId: run.id,
    conversationId: run.conversation_id,
    wanted: userId,
  });
  return skip("already_assigned");
}

// ── Orquestación ──────────────────────────────────────────────────────────────

/** Backoff exponencial: 2^attempts minutos (2, 4, 8 con el tope de 3 intentos). */
function backoffFrom(attempts: number): string {
  const minutes = Math.pow(2, Math.max(attempts, 1));
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/**
 * Cierra la fila con la condición de lease.
 *
 * No miente en ninguna de las dos direcciones:
 *  - UPDATE con error  → LANZA `FinishError`. Devolver el outcome como si
 *    hubiera cerrado dejaría la fila `processing` para siempre mientras el
 *    tally dice `done`.
 *  - UPDATE con 0 filas → `"lost"`: otro worker ya la cerró. No se escribe el
 *    evento, porque el panel mostraría la misma automatización dos veces.
 *
 * Reejecutar una fila que quedó en `processing` es seguro por acción:
 *
 *   | acción              | qué pasa si el lease la recupera                  |
 *   |---------------------|---------------------------------------------------|
 *   | send_template       | `dispatched_at` ya está ⇒ failed outcome_unknown   |
 *   | add_tag             | idempotente (append_contact_tags)                 |
 *   | assign_agent        | `assigned_to IS NULL` en el WHERE: el mismo       |
 *   |                     | usuario ⇒ done; otro dueño ⇒ skipped              |
 *   |                     | already_assigned, sin pisar                       |
 *   | handoff_human       | transición ya aplicada ⇒ skipped                  |
 *   | close_conversation  | transición ya aplicada ⇒ skipped                  |
 */
async function finish(
  run: AutomationRun,
  rule: RuleRow | null,
  result: ActionResult,
): Promise<RunOutcome> {
  const supabase = svc();
  const isRetry = result.outcome === "retry";

  const { data, error } = await supabase
    .from("automation_runs")
    .update(
      isRetry
        ? {
            status: "pending",
            error: result.error ?? null,
            claimed_at: null,
            not_before: backoffFrom(run.attempts),
          }
        : {
            status: result.outcome,
            error: result.error ?? null,
            finished_at: new Date().toISOString(),
          },
    )
    .eq("id", run.id)
    .eq("workspace_id", run.workspace_id)
    .eq("status", "processing")
    .eq("claimed_at", run.claimed_at)
    .select("id");

  if (error) {
    throw new FinishError(error.message);
  }

  if (((data as unknown[] | null) ?? []).length === 0) {
    console.warn("[automations] lease perdido al cerrar:", run.id);
    return "lost";
  }

  // Un reintento todavía no terminó nada: no hay evento que mostrar.
  if (isRetry) return "retry";

  const type =
    result.outcome === "done"
      ? "automation_fired"
      : result.outcome === "failed"
        ? "automation_failed"
        : "automation_skipped";

  const { error: eventError } = await supabase.from("events").insert({
    type,
    level: result.outcome === "failed" ? "error" : "info",
    workspace_id: run.workspace_id,
    conversation_id: run.conversation_id,
    payload: {
      rule_id: run.rule_id,
      run_id: run.id,
      event_id: run.event_id,
      trigger_type: run.trigger_type,
      action_type: rule?.action_type ?? null,
      ...(result.error ? { reason: result.error } : {}),
    },
  });

  // El run YA está cerrado con su lease: no se reabre ni se reintenta por no
  // haber podido anotarlo. Pero tampoco se ignora: sin este log, una ejecución
  // que sí ocurrió desaparece de la línea de tiempo del cliente.
  if (eventError) {
    console.error("[automations] no pude registrar el evento del cierre:", {
      runId: run.id,
      outcome: result.outcome,
      message: eventError.message,
    });
  }

  return result.outcome;
}

/** Ejecuta una fila ya reclamada. Nunca lanza. */
export async function executeRun(claimed: AutomationRun): Promise<RunOutcome> {
  // Copia local: `conversation_id` puede resolverse más abajo (lead_qualified)
  // y el evento de cierre tiene que citar la conversación resuelta.
  let run: AutomationRun = claimed;
  let rule: RuleRow | null = null;

  try {
    // 0. El efecto externo ya salió en un intento anterior que murió antes
    //    de cerrar. NO se repite y NO se declara éxito.
    if (run.dispatched_at) {
      return await finish(run, null, fail("outcome_unknown"));
    }

    // 1. Regla. Que siga habilitada. Renombrarla o cambiarle la plantilla NO
    //    invalida este run: invalidarlo mataría ejecuciones legítimas por una
    //    edición cosmética.
    //
    //    El piso temporal NO se evalúa acá: lo evalúa
    //    `claim_next_automation_run()` comparando el `occurred_at` del evento
    //    contra el `enabled_since` vigente, en la misma transacción que
    //    reclama la fila (20260904000002). Por eso este select ya no pide
    //    `enabled_since`: si un run llegó hasta acá, la RPC ya decidió que su
    //    hecho es posterior al piso.
    const ruleLoad = await loadScoped<RuleRow>(
      "automation_rules",
      run.rule_id,
      "id, name, action_type, action_config, enabled",
      run.workspace_id,
    );
    if (ruleLoad.problem === "db") {
      return await finish(run, null, retry("db_read_failed"));
    }
    if (ruleLoad.problem === "cross_workspace") {
      return await finish(run, null, fail("cross_workspace"));
    }
    rule = ruleLoad.row;
    if (!rule || !rule.enabled) {
      return await finish(run, rule, skip("rule_disabled"));
    }
    // 1b. Conversación de `lead_qualified`: el trigger de contacts
    //     la emite en NULL, así que se resuelve acá, que es el único punto de
    //     carga, y se persiste para que el evento y el historial la citen.
    //
    //     La resolución tardía es SOLO para `lead_qualified`. Los otros
    //     tres disparadores nacen CON conversación (el trigger que los emite la
    //     tiene a mano), así que un NULL ahí solo puede venir del
    //     `ON DELETE SET NULL` de automation_runs: la conversación se borró.
    //     Resolver "la más reciente del contacto" en ese caso ejecutaría la
    //     automatización sobre OTRA conversación — mandarle a un cliente la
    //     plantilla que disparó una conversación ya borrada.
    if (!run.conversation_id) {
      if (run.trigger_type !== "lead_qualified") {
        return await finish(run, rule, skip("conversation_gone"));
      }
      if (!run.contact_id) {
        return await finish(run, rule, skip("no_conversation"));
      }

      const resolved = await resolveConversationForContact(
        run.workspace_id,
        run.contact_id,
      );
      if (resolved.dbError) {
        return await finish(run, rule, retry("db_read_failed"));
      }
      if (!resolved.id) {
        return await finish(run, rule, skip("no_conversation"));
      }
      await persistResolvedConversation(run, resolved.id);
      run = { ...run, conversation_id: resolved.id };
    }

    // 2. Conversación (si la fila trae una, propia o recién resuelta)
    let conversation: { id: string; contact_id: string | null } | null = null;
    if (run.conversation_id) {
      const load = await loadScoped<{ id: string; contact_id: string | null }>(
        "conversations",
        run.conversation_id,
        "id, contact_id",
        run.workspace_id,
      );
      if (load.problem === "db") {
        return await finish(run, rule, retry("db_read_failed"));
      }
      if (load.problem === "cross_workspace") {
        return await finish(run, rule, fail("cross_workspace"));
      }
      if (!load.row) {
        return await finish(run, rule, skip("no_conversation"));
      }
      conversation = load.row;
    }

    // 3. Contacto — acá se lee el opt_in, fail-closed. Se usa el contacto de la
    //    CONVERSACIÓN: quien recibe el WhatsApp es el de la conversación de hoy.
    let contact: { id: string; opt_in: boolean | null } | null = null;
    let contactReadFailed = false;
    const contactId = conversation?.contact_id ?? run.contact_id ?? null;
    if (contactId) {
      const load = await loadScoped<{ id: string; opt_in: boolean | null }>(
        "contacts",
        contactId,
        "id, opt_in",
        run.workspace_id,
      );
      if (load.problem === "cross_workspace") {
        return await finish(run, rule, fail("cross_workspace"));
      }
      // Una lectura caída NO es un contacto sin opt-in: el opt-out es
      // fail-closed y esta bandera hace que send_template reintente sin enviar.
      if (load.problem === "db") contactReadFailed = true;
      else contact = load.row;
    }

    let result: ActionResult;
    switch (rule.action_type) {
      case "send_template":
        result = await actSendTemplate(run, rule, contact, contactReadFailed);
        break;
      case "add_tag":
        result = await actAddTag(run, rule, contact, contactReadFailed);
        break;
      case "handoff_human":
        result = await actHandoff(run);
        break;
      case "close_conversation":
        result = await actClose(run);
        break;
      case "assign_agent":
        result = await actAssignAgent(run, rule);
        break;
      default:
        console.error("[automations] acción desconocida:", rule.action_type);
        result = fail("invalid_config");
    }

    // `lost` ya significa "otro worker la tiene": no se le escribe encima.
    if (result.outcome === "lost") return "lost";

    return await finish(run, rule, result);
  } catch (err) {
    // A la fila va un CÓDIGO, nunca `err.message`. `automation_runs.error`
    // la lee cualquier miembro del workspace por la policy de SELECT, así que
    // un mensaje crudo de PostgREST (nombres de tabla, de columna, fragmentos
    // de SQL, a veces el valor que chocó) es filtración de detalle interno
    // contra el contrato de "motivos fijos". El detalle completo va SOLO al
    // log del servidor, con el objeto de error entero para poder depurar.
    console.error("[automations] run failed:", run.id, err);
    try {
      // UN solo intento de cierre. Si `finish` fue justamente lo que
      // lanzó, este es el segundo y último.
      return await finish(run, rule, fail("internal_error"));
    } catch (finishErr) {
      // Ni siquiera se pudo marcar la fila. Se cuenta el fallo en el tally, la
      // fila queda en `processing` y el lease de 7 minutos de
      // claim_next_automation_run() la recupera. Declararla cerrada acá sería
      // exactamente la mentira que `finish` evita.
      console.error("[automations] no pude cerrar la fila; queda en processing:", {
        runId: run.id,
        message: finishErr instanceof Error ? finishErr.message : "error desconocido",
      });
      return "failed";
    }
  }
}

/**
 * Reclama y ejecuta hasta `max` filas contra un `deadline` ABSOLUTO.
 *
 * Sin cursor. El round-robin por "workspace menos recientemente servido"
 * vive en el ORDER BY de `claim_next_automation_run()`, así que su estado está
 * en los datos: sobrevive al tope por tick, al tick siguiente y a dos
 * instancias simultáneas. Un cursor en memoria podría girar sin avanzar y se
 * perdería al terminar la corrida.
 *
 * El deadline se comprueba ANTES de cada reclamo, nunca después: reclamar y no
 * ejecutar deja la fila `processing` esperando a que venza el lease. Con el
 * deadline ya vencido al entrar (la expansión se comió el presupuesto) no se
 * reclama nada y la ruta responde con el tally en ceros.
 *
 * El corte entre filas no protege de UNA fila colgada: eso lo cubre el timeout
 * de 20 s de `kapsoFetch`. Las filas agotadas no cortan el drenaje: la
 * RPC las descarta y sigue.
 */
export async function drainAutomationRuns(
  max: number,
  deadline: number,
): Promise<{
  done: number;
  failed: number;
  skipped: number;
  retry: number;
  lost: number;
  /**
   * CÓDIGO de la fase que se cayó, nunca el mensaje de PostgREST. Solo
   * aparece si el DRENAJE entero no pudo hacer su trabajo; una fila que falla
   * es `failed`, y eso sigue siendo un tick sano.
   */
  error?: string;
}> {
  const supabase = svc();
  const tally = { done: 0, failed: 0, skipped: 0, retry: 0, lost: 0 };

  let count = 0;
  // El `break` de abajo sale del bucle SIN lanzar, así que sin esta bandera un
  // tick donde la RPC del claim falla en todas las vueltas respondería
  // `200 {ok:true}` con el tally en ceros — indistinguible de una cola vacía,
  // con la cola creciendo y el monitoreo en verde. No se resuelve lanzando: eso
  // haría que la ruta responda `drain_threw` y PIERDA el tally de los runs que
  // este tick sí alcanzó a ejecutar. El fallo de fase viaja como dato.
  let phaseError: string | undefined;
  while (count < max && Date.now() < deadline) {
    const { data, error } = await supabase.rpc("claim_next_automation_run");
    if (error) {
      console.error("[automations] claim RPC error:", error.message);
      phaseError = "claim_failed";
      break;
    }

    const run = (data as AutomationRun[] | null)?.[0] ?? null;
    // Sin cursor no hay vuelta de rueda que dar: si la RPC no devuelve fila, no
    // queda trabajo reclamable.
    if (!run) break;

    tally[await executeRun(run)] += 1;
    count += 1;
  }

  if (count >= max || Date.now() >= deadline) {
    console.warn("[automations] corte del tick; sigue el próximo", { count, max });
  }

  // Sin fallo de fase el objeto sale con la forma de siempre: el `error` no
  // aparece en el body del tick sano.
  return phaseError ? { ...tally, error: phaseError } : tally;
}
