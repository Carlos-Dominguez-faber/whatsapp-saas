// F3-T4: Decision engine — orchestrates respond / handoff / abstain.
// Uses service-role client for DB state transitions.

import { createClient as createSbClient } from "@supabase/supabase-js";
import {
  aiShouldRespond,
  canTransition,
  detectsHandoffTrigger,
  TransitionError,
  type ConversationState,
} from "./state-machine";
import { reserveLlmTurn } from "./cost-tracker";
import { getEnabledTools } from "@/features/tools/services/tool-configs";
import type { Tool } from "@/features/tools/core/tool";

// La clase vive en state-machine (módulo puro), pero el ejecutor de
// automatizaciones importa `applyTransition` y su error del mismo módulo:
// re-exportarla evita que cada caller tenga que saber dónde está declarada.
export { TransitionError };

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export type Decision = "respond" | "handoff" | "abstain" | "rate_limited";

export interface DecisionResult {
  decision: Decision;
  reason: string;
  availableTools?: Tool[];
  reservationId?: string;
}

/**
 * Decides whether the AI should respond, trigger a handoff, or abstain.
 *
 * Flow:
 *   1. Load conversation state from DB
 *   2. If state !== 'ai_active' → abstain
 *   3. detectsHandoffTrigger → if true, transition to handoff_pending and log
 *   4. reserveLlmTurn → if exceeded, return rate_limited
 *   5. → respond
 */
export async function decide(opts: {
  workspaceId: string;
  conversationId: string;
  mergedText: string;
  contactId: string;
}): Promise<DecisionResult> {
  const { workspaceId, conversationId, mergedText, contactId } = opts;
  const supabase = svc();

  // 1. Load conversation state
  const { data: conv, error: convError } = await supabase
    .from("conversations")
    .select("state")
    .eq("id", conversationId)
    .single();

  if (convError || !conv) {
    console.error("[decision-engine] failed to load conversation:", convError);
    return { decision: "abstain", reason: "conversation_not_found" };
  }

  const currentState = conv.state as ConversationState;

  // 2. Check if AI should respond in current state
  if (!aiShouldRespond(currentState)) {
    return { decision: "abstain", reason: `state:${currentState}` };
  }

  // 3. Detect handoff trigger in message text
  if (detectsHandoffTrigger(mergedText)) {
    // Route through the single choke point for state changes so every side
    // effect of entering handoff_pending (event log, contact notification)
    // fires. This no longer swallows the error: if it throws, decide()
    // propagates it instead of reporting a successful handoff that never
    // happened. processNextBatch() (buffer.ts) already retries transient
    // failures with backoff and dead-letters after MAX_BATCH_RETRIES — that
    // is the correct place for this to be handled, not a second bespoke
    // retry here.
    if (canTransition(currentState, "handoff_pending")) {
      await applyTransition(conversationId, "handoff_pending", {
        trigger: "keyword",
      });
    }

    return { decision: "handoff", reason: "handoff_trigger" };
  }

  // 4. Rate limit check — atomically reserves a turn slot so two concurrent
  // batches for the same contact can't both pass.
  const {
    allowed,
    reason: rateLimitReason,
    reservationId,
  } = await reserveLlmTurn(workspaceId, contactId);

  if (!allowed) {
    return {
      decision: "rate_limited",
      reason: rateLimitReason ?? "rate_limited",
    };
  }

  // 5. All checks passed — load enabled tools and respond
  const availableTools = await getEnabledTools(workspaceId);
  return { decision: "respond", reason: "normal", availableTools, reservationId };
}

export interface TransitionOptions {
  /** Set when a human drove the transition — becomes assigned_to + event actor. */
  userId?: string;
  /** What caused it: keyword | agent | manual. Recorded in the event payload. */
  trigger?: string;
  /**
   * Scope guard. When set, the conversation must belong to this workspace:
   * lookup and update both filter by it, so a caller that already verified
   * membership cannot be tricked into moving another tenant's conversation.
   */
  workspaceId?: string;
}

/**
 * Applies a validated state transition to a conversation.
 * Logs the transition to the events table.
 * If transitioning to human_active and userId is provided, sets assigned_to.
 *
 * This is the single choke point for state changes: every side effect of
 * entering a state hangs off here, so all callers must go through it rather
 * than UPDATE `conversations` directly.
 */
export async function applyTransition(
  conversationId: string,
  to: ConversationState,
  opts: TransitionOptions = {},
): Promise<void> {
  const { userId, trigger, workspaceId } = opts;
  const supabase = svc();

  // 1. Load current state (scoped to the workspace when the caller gives one)
  let lookup = supabase
    .from("conversations")
    .select("state, workspace_id, state_version")
    .eq("id", conversationId);
  if (workspaceId) lookup = lookup.eq("workspace_id", workspaceId);
  const { data: conv, error: convError } = await lookup.single();

  if (convError || !conv) {
    throw new Error(
      `[decision-engine] conversation not found: ${convError?.message}`,
    );
  }

  const currentState = conv.state as ConversationState;
  // El valor leído ACÁ, no uno releído después: el CAS del paso 3b tiene que
  // comparar contra la versión que este caller efectivamente vio.
  const currentVersion = conv.state_version as number;

  // 2. Validate transition (throws TransitionError if invalid)
  if (!canTransition(currentState, to)) {
    throw new TransitionError(currentState, to);
  }

  // 3. Build the update payload
  const updatePayload: Record<string, unknown> = {
    state: to,
    ai_enabled: to === "ai_active",
    updated_at: new Date().toISOString(),
  };

  if (to === "human_active" && userId) {
    updatePayload.assigned_to = userId;
  }

  // 3b. UPDATE con COMPARE-AND-SWAP sobre el estado que se leyó en el paso 1.
  //     Sin el `.eq("state", currentState)`, dos callers concurrentes que leen
  //     `ai_active` escriben los dos `handoff_pending`; el trigger
  //     trg_conversations_automation_event emite entonces DOS
  //     automation_events con state_version distinto, y con una regla
  //     `handoff_requested -> send_template` eso son dos plantillas cobradas
  //     por un solo handoff. `dispatched_at` protege cada run individual, no
  //     el hecho lógico.
  //
  //     Se pide `id` de vuelta y nada más: lo único que hay que saber acá es si
  //     esta transacción ganó la carrera. La versión la calcula el trigger
  //     trg_conversations_state_version dentro de Postgres.
  //
  //     `.eq("state", ...)` solo no basta: es vulnerable a ABA. Con
  //     A→B→A (la conversación sale de `ai_active` y vuelve), un UPDATE stale
  //     que todavía tiene `currentState = "ai_active"` en memoria puede ganar
  //     el CAS contra el estado ACTUAL, que también es `ai_active` pero de otra
  //     época — y `state_version` es la `occurrence` que el trigger usa para el
  //     evento `handoff_requested`, así que una transición duplicada cobra un
  //     segundo envío de plantilla. Se agrega `state_version` al WHERE, con el
  //     valor leído en el paso 1 (no uno releído después).
  //
  //     Se recuerda si este UPDATE llevaba `assigned_to`, porque de eso
  //     depende si perder la carrera se puede reportar como éxito.
  const carriedAssignment = updatePayload.assigned_to !== undefined;

  let update = supabase
    .from("conversations")
    .update(updatePayload)
    .eq("id", conversationId)
    .eq("state", currentState)
    .eq("state_version", currentVersion);
  if (workspaceId) update = update.eq("workspace_id", workspaceId);
  const { data: updatedRow, error: updateError } = await update
    .select("id")
    .maybeSingle();

  if (updateError) {
    throw new Error(
      `[decision-engine] failed to apply transition: ${updateError.message}`,
    );
  }

  // Ninguna fila afectada ⇒ otro caller ganó la carrera. Lo que NO se puede
  // hacer acá es asumir que ganó escribiendo `to`: desde `ai_active` son
  // válidos a la vez `handoff_pending`, `human_active`, `waiting_reply`,
  // `paused` y `closed` (state-machine.ts). Si A cerró la conversación y B
  // pedía handoff, retornar en silencio hace que el endpoint responda
  // `{ok:true, state:"handoff_pending"}` sobre una fila que quedó `closed`
  // (handoff/route.ts). Por eso se RELEE el estado real, con el mismo scope
  // que la lectura del paso 1.
  if (!updatedRow) {
    let recheck = supabase
      .from("conversations")
      .select("state")
      .eq("id", conversationId);
    if (workspaceId) recheck = recheck.eq("workspace_id", workspaceId);
    const { data: actual, error: recheckError } = await recheck.maybeSingle();

    if (recheckError || !actual) {
      // No saber en qué estado quedó no es "quedó como pediste".
      throw new Error(
        `[decision-engine] transition lost race and state re-read failed: ${
          recheckError?.message ?? "conversación no encontrada"
        }`,
      );
    }

    const actualState = (actual as { state: ConversationState }).state;

    if (actualState === to && !carriedAssignment) {
      // El ganador escribió EXACTAMENTE lo que este caller pedía: idempotente.
      // Se retorna SIN evento y SIN notificación — anunciar el mismo hecho dos
      // veces es el bug que el CAS existe para evitar.
      console.warn("[decision-engine] transition lost race (same target)", {
        conversationId,
        from: currentState,
        to,
      });
      return;
    }

    // El éxito silencioso vale SOLO para transiciones PURAS de estado.
    // `assigned_to` viaja en el MISMO UPDATE que perdió el CAS, así que si este
    // caller pedía asignar, ese assigned_to NO se escribió aunque el estado
    // final coincida. Es el caso de `take`: dos operadores llegan los dos a
    // `human_active`, pero solo uno queda asignado y el otro tiene que
    // enterarse en vez de creer que la conversación es suya.
    if (actualState === to) {
      console.warn("[decision-engine] transition lost race with assignment", {
        conversationId,
        to,
        userId,
      });
      throw new TransitionError(actualState, to, "state_mismatch");
    }

    // El ganador escribió OTRA cosa. El caller pidió algo que ya no se puede
    // cumplir y tiene que enterarse: handoff, take y toggle-ai ya traducen el
    // prefijo "Invalid transition:" a 422 con texto en español, y los callers
    // de buffer.ts (cost-cut) y normalizer.ts (eco saliente) ya lo capturan y
    // siguen.
    console.warn("[decision-engine] transition lost race (state moved)", {
      conversationId,
      requested: to,
      actual: actualState,
    });
    throw new TransitionError(actualState, to, "state_mismatch");
  }

  // 4. Log the state change to events
  await supabase.from("events").insert({
    type: "state_change",
    level: "info",
    workspace_id: conv.workspace_id,
    conversation_id: conversationId,
    payload: {
      from: currentState,
      to,
      actor: userId ?? "system",
      ...(trigger ? { trigger } : {}),
    },
  });

  // 5. Side effects of the new state. Deliberately last and deliberately
  //    non-throwing: the transition above is already committed and must stand
  //    even if notifying anyone fails.
  //
  // Traspaso y cierre se ENCOLAN para el timeline de HubSpot. Acá va solo un
  // INSERT barato e idempotente (UNIQUE conversation_id + from_state_version) y la RPC decide si
  // HubSpot es el CRM activo. NUNCA se llama a HubSpot en este camino: lo hace la fase
  // hubspotLogs de cron/automations, con deadline. Un fallo no revierte ni rompe la transición.
  // Va ANTES del aviso por email (Resend, llamada externa): si el aviso se cuelga y la función
  // muere por maxDuration, el encolado ya quedó hecho.
  if (to === "handoff_pending" || to === "closed") {
    try {
      const { error: enqueueError } = await supabase.rpc("enqueue_hubspot_conversation_log", {
        p_workspace_id: conv.workspace_id,
        p_conversation_id: conversationId,
        p_from_state_version: currentVersion,
        p_reason: to === "closed" ? "closed" : "handoff",
      });
      if (enqueueError) {
        console.error("[decision-engine] hubspot_log_enqueue_failed", { conversationId });
      }
    } catch {
      console.error("[decision-engine] hubspot_log_enqueue_failed", { conversationId });
    }
  }

  if (to === "handoff_pending") {
    try {
      const { notifyHandoffPending } = await import("./handoff-notifier");
      await notifyHandoffPending({
        workspaceId: conv.workspace_id as string,
        conversationId,
        trigger: trigger ?? (userId ? "manual" : "agent"),
      });
    } catch (err) {
      console.error(
        "[decision-engine] failed to notify handoff_pending:",
        err instanceof Error ? err.message : err,
      );
    }
  }
}
