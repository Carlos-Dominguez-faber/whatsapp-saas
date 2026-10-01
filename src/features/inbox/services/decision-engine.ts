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
import { isMissingColumnError, reportMissingFunctionOnce } from "@/shared/lib/db-errors";
import { reserveLlmTurn } from "./cost-tracker";
import { getEnabledTools } from "@/features/tools/services/tool-configs";
import type { Tool } from "@/features/tools/core/tool";

// The class lives in the pure state-machine module; callers of applyTransition
// (the automation executor among them) import both from here.
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
 *   4. load the enabled tools
 *   5. reserveLlmTurn (last: nothing may throw after it) → if exceeded,
 *      return rate_limited; otherwise respond
 */
export async function decide(opts: {
  workspaceId: string;
  conversationId: string;
  mergedText: string;
  contactId: string;
  /**
   * The turn slot an earlier attempt of the same batch already reserved. A
   * retry reuses it instead of spending a second slot of the hourly limit.
   */
  reservationId?: string;
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

  // 4. Load the enabled tools first: once a turn slot is reserved nothing in
  // here may throw, or the slot would be spent with no one holding its id.
  const availableTools = await getEnabledTools(workspaceId);

  // 5. Rate limit check — atomically reserves a turn slot so two concurrent
  // batches for the same contact can't both pass. A retry keeps its slot.
  const {
    allowed,
    reason: rateLimitReason,
    reservationId,
  } = opts.reservationId
    ? { allowed: true, reason: undefined, reservationId: opts.reservationId }
    : await reserveLlmTurn(workspaceId, contactId);

  if (!allowed) {
    return {
      decision: "rate_limited",
      reason: rateLimitReason ?? "rate_limited",
    };
  }

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

  // 1. Load current state (scoped to the workspace when the caller gives one).
  //    state_version is the compare-and-swap token below. Before the Phase 4
  //    migration it doesn't exist: fall back to a state-only compare instead of
  //    failing every handoff, take and toggle.
  const loadState = async (columns: string) => {
    let lookup = supabase
      .from("conversations")
      .select(columns)
      .eq("id", conversationId);
    if (workspaceId) lookup = lookup.eq("workspace_id", workspaceId);
    return lookup.single();
  };
  let { data: conv, error: convError } = await loadState(
    "state, workspace_id, state_version",
  );
  let hasVersion = true;
  if (convError && isMissingColumnError(convError, "state_version")) {
    reportMissingFunctionOnce(
      "conversations.state_version",
      "transitions compare on state only",
    );
    hasVersion = false;
    ({ data: conv, error: convError } = await loadState("state, workspace_id"));
  }

  if (convError || !conv) {
    throw new Error(
      `[decision-engine] conversation not found: ${convError?.message}`,
    );
  }

  const row = conv as unknown as {
    state: ConversationState;
    workspace_id: string;
    state_version?: number;
  };
  const currentState = row.state;
  // The value read HERE: the compare-and-swap must compare against the
  // version this caller actually saw, not one read later.
  const currentVersion = row.state_version;

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
  // Whether this UPDATE carried an assignment: losing the race can only count
  // as success for a pure state change.
  const carriedAssignment = updatePayload.assigned_to !== undefined;

  // 3b. Compare-and-swap on the state (and its version) read in step 1. Without
  //     it, two callers that both read `ai_active` both write
  //     `handoff_pending`, and the automation trigger emits two
  //     `handoff_requested` events — two paid templates for one handoff. The
  //     version closes the A→B→A case, where the state alone matches again.
  let update = supabase
    .from("conversations")
    .update(updatePayload)
    .eq("id", conversationId)
    .eq("state", currentState);
  if (hasVersion && typeof currentVersion === "number") {
    update = update.eq("state_version", currentVersion);
  }
  if (workspaceId) update = update.eq("workspace_id", workspaceId);
  const { data: updatedRow, error: updateError } = await update
    .select("id")
    .maybeSingle();

  if (updateError) {
    throw new Error(
      `[decision-engine] failed to apply transition: ${updateError.message}`,
    );
  }

  // No row updated: another caller won the race. Re-read where it left the
  // conversation instead of assuming it wrote `to`.
  if (!updatedRow) {
    let recheck = supabase
      .from("conversations")
      .select("state")
      .eq("id", conversationId);
    if (workspaceId) recheck = recheck.eq("workspace_id", workspaceId);
    const { data: actual, error: recheckError } = await recheck.maybeSingle();

    if (recheckError || !actual) {
      throw new Error(
        `[decision-engine] transition lost race and state re-read failed: ${
          recheckError?.message ?? "conversation not found"
        }`,
      );
    }

    const actualState = (actual as { state: ConversationState }).state;
    if (actualState === to && !carriedAssignment) {
      // The winner wrote exactly what this caller asked for: idempotent, and
      // no second event or notification for the same fact.
      console.warn("[decision-engine] transition lost race (same target)", {
        conversationId,
        from: currentState,
        to,
      });
      return;
    }
    // Either the state moved elsewhere, or it matches but this caller's
    // assignment was not written (two operators taking the same thread).
    console.warn("[decision-engine] transition lost race", {
      conversationId,
      requested: to,
      actual: actualState,
    });
    throw new TransitionError(actualState, to, "state_mismatch");
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
    workspace_id: row.workspace_id,
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
  //
  // The HubSpot timeline queue is fed by a trigger on conversations.state
  // (20261003000014), in this UPDATE's transaction: nothing to do here.
  if (to === "handoff_pending") {
    try {
      const { notifyHandoffPending } = await import("./handoff-notifier");
      await notifyHandoffPending({
        workspaceId: row.workspace_id,
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
