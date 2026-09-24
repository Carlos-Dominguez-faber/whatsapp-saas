// F3-T4: Decision engine — orchestrates respond / handoff / abstain.
// Uses service-role client for DB state transitions.

import { createClient as createSbClient } from "@supabase/supabase-js";
import {
  aiShouldRespond,
  canTransition,
  detectsHandoffTrigger,
  type ConversationState,
} from "./state-machine";
import { reserveLlmTurn } from "./cost-tracker";
import { getEnabledTools } from "@/features/tools/services/tool-configs";
import type { Tool } from "@/features/tools/core/tool";

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
    .select("state, workspace_id")
    .eq("id", conversationId);
  if (workspaceId) lookup = lookup.eq("workspace_id", workspaceId);
  const { data: conv, error: convError } = await lookup.single();

  if (convError || !conv) {
    throw new Error(
      `[decision-engine] conversation not found: ${convError?.message}`,
    );
  }

  const currentState = conv.state as ConversationState;

  // 2. Validate transition (throws TransitionError if invalid)
  if (!canTransition(currentState, to)) {
    const { TransitionError } = await import("./state-machine");
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

  let update = supabase
    .from("conversations")
    .update(updatePayload)
    .eq("id", conversationId);
  if (workspaceId) update = update.eq("workspace_id", workspaceId);
  const { error: updateError } = await update;

  if (updateError) {
    throw new Error(
      `[decision-engine] failed to apply transition: ${updateError.message}`,
    );
  }

  // 4. Log the state change to events
  //
  // El UPDATE de arriba YA está confirmado: esto es un segundo statement y
  // puede fallar solo. Cuando falla, la conversación queda en el estado nuevo
  // sin evento en el historial, y "Derivadas a humano" del dashboard de
  // análisis —que se cuenta desde estos eventos— subcuenta.
  // NO se transaccionaliza acá: hacerlo exige mover applyTransition a una RPC,
  // que es un cambio del corazón del inbox con su propio plan. Lo mínimo es
  // que deje rastro.
  const { error: eventError } = await supabase.from("events").insert({
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

  if (eventError) {
    // Solo el código: nunca el mensaje crudo.
    console.error("[decision-engine] state_change insert failed", eventError.code);
  }

  // 5. Side effects of the new state. Deliberately last and deliberately
  //    non-throwing: the transition above is already committed and must stand
  //    even if notifying anyone fails.
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
