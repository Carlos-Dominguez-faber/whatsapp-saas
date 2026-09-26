import { createClient as createSbClient } from "@supabase/supabase-js";
import { performance } from "node:perf_hooks";
import { isMissingFunctionError } from "@/shared/lib/db-errors";

const LLM_TURNS_PER_CONTACT_PER_HOUR = 20;

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

interface RecordLlmUsageOpts {
  reservationId?: string;
  workspaceId: string;
  conversationId: string;
  contactId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

/**
 * Records LLM usage for observability and rate-limit accounting. When
 * reservationId is given (decide() reserved a turn slot via
 * reserveLlmTurn()), updates that reservation row in place instead of
 * inserting a second row for the same turn.
 */
export async function recordLlmUsage(opts: RecordLlmUsageOpts): Promise<void> {
  const supabase = svc();

  const {
    reservationId,
    workspaceId,
    conversationId,
    contactId,
    model,
    promptTokens,
    completionTokens,
  } = opts;

  const payload = {
    model,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    contact_id: contactId,
  };

  const { error } = reservationId
    ? await supabase
        .from("events")
        .update({ conversation_id: conversationId, payload })
        .eq("id", reservationId)
    : await supabase.from("events").insert({
        type: "llm_usage",
        level: "info",
        workspace_id: workspaceId,
        conversation_id: conversationId,
        payload,
      });

  if (error) {
    console.error("[cost-tracker] failed to record llm_usage event:", error);
  }
}

interface RateLimitResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Checks the per-contact hourly turn limit.
 *
 * The workspace daily token budget is enforceCostPolicy's job
 * (cost-enforcer.ts) — this used to also gate on a 1,000,000-token daily
 * ceiling (the same number as cost-enforcer's warn threshold), which meant
 * every call that reached enforceCostPolicy already had totalTokensToday
 * under 1,000,000, so its degrade/cut branches were dead code. Don't
 * reintroduce a second daily-token check here.
 *
 * Returns { allowed: false, reason } when the hourly ceiling is breached,
 * { allowed: true } otherwise.
 */
export async function checkRateLimits(
  workspaceId: string,
  contactId: string,
): Promise<RateLimitResult> {
  const supabase = svc();

  const nowMs = performance.timeOrigin + performance.now();
  const hourAgo = new Date(nowMs - 3_600_000).toISOString();

  const { data: hourlyEvents, error } = await supabase
    .from("events")
    .select("id")
    .eq("type", "llm_usage")
    .eq("workspace_id", workspaceId)
    .filter("payload->>contact_id", "eq", contactId)
    .gte("created_at", hourAgo);

  if (error) {
    // This is only the webhook's cheap peek. The authoritative, atomic check
    // is reserveLlmTurn() in decide(), which runs again before any model call.
    // Failing closed here would drop the message from the buffer with no
    // retry, so an unreadable count lets it through to that check instead.
    console.error("[cost-tracker] hourly check error:", error);
    return { allowed: true };
  }

  if ((hourlyEvents?.length ?? 0) >= LLM_TURNS_PER_CONTACT_PER_HOUR) {
    return { allowed: false, reason: "rate_limit_contact_hour" };
  }

  return { allowed: true };
}

export interface ReserveLlmTurnResult {
  allowed: boolean;
  reason?: string;
  reservationId?: string;
}

/**
 * Atomically claims one hourly turn slot for (workspaceId, contactId), or
 * denies if the contact is already at LLM_TURNS_PER_CONTACT_PER_HOUR.
 * Unlike checkRateLimits (a cheap read-only peek used by the webhook
 * handler to skip buffering an already-limited contact), this WRITES a
 * reservation row as part of the same Postgres function call — see
 * migration 20260928000000 — so two concurrent callers for the same
 * contact cannot both be authorized. Call this from decide(), right before
 * the turn is actually about to be spent; recordLlmUsage() later fills in
 * the reservation's real token counts via reservationId.
 */
export async function reserveLlmTurn(
  workspaceId: string,
  contactId: string,
): Promise<ReserveLlmTurnResult> {
  const supabase = svc();

  const { data, error } = await supabase.rpc("reserve_llm_turn", {
    p_workspace_id: workspaceId,
    p_contact_id: contactId,
    p_hourly_limit: LLM_TURNS_PER_CONTACT_PER_HOUR,
  });

  if (error) {
    if (isMissingFunctionError(error)) {
      // Code deployed before `db-push`: keep the agent answering, unreserved,
      // rather than silencing every workspace until the migration runs.
      console.warn(
        "[cost-tracker] reserve_llm_turn is missing — run `setup.mjs db-push`; the hourly limit is not enforced until then",
      );
      return { allowed: true };
    }
    // A real database error: throw so processNextBatch() retries the batch
    // with backoff and dead-letters it visibly, instead of dropping the turn.
    throw new Error(`reserve_llm_turn failed: ${error.message}`);
  }

  const row = (
    data as { allowed: boolean; reservation_id: string | null }[] | null
  )?.[0];

  if (!row?.allowed) {
    return { allowed: false, reason: "rate_limit_contact_hour" };
  }

  return { allowed: true, reservationId: row.reservation_id ?? undefined };
}

/** Manager-facing LLM tools that spend the workspace's key outside a turn. */
export type WorkspaceLlmCallType = "template_generate" | "agent_test_chat";

/**
 * Atomically claims one of the workspace's hourly calls of `type`, or denies
 * once `hourlyLimit` calls of that type already happened in the last hour.
 * Same contract as reserveLlmTurn: a database error throws, and a missing
 * function (code deployed before `db-push`) allows unreserved with a warning.
 */
export async function reserveWorkspaceLlmCall(
  workspaceId: string,
  type: WorkspaceLlmCallType,
  hourlyLimit: number,
): Promise<ReserveLlmTurnResult> {
  const supabase = svc();

  const { data, error } = await supabase.rpc("reserve_workspace_llm_call", {
    p_workspace_id: workspaceId,
    p_type: type,
    p_hourly_limit: hourlyLimit,
  });

  if (error) {
    if (isMissingFunctionError(error)) {
      console.warn(
        "[cost-tracker] reserve_workspace_llm_call is missing — run `setup.mjs db-push`; the hourly limit is not enforced until then",
      );
      return { allowed: true };
    }
    throw new Error(`reserve_workspace_llm_call failed: ${error.message}`);
  }

  const row = (
    data as { allowed: boolean; reservation_id: string | null }[] | null
  )?.[0];

  if (!row?.allowed) {
    return { allowed: false, reason: "rate_limit_workspace_hour" };
  }

  return { allowed: true, reservationId: row.reservation_id ?? undefined };
}

/**
 * Records the tokens of a reserveWorkspaceLlmCall() call: fills in the
 * reservation row, or inserts one when there was no reservation. The row's
 * total_tokens is what sum_daily_llm_tokens() adds to the daily budget.
 * Never throws — the call already happened.
 */
export async function recordWorkspaceLlmCall(opts: {
  reservationId?: string;
  workspaceId: string;
  type: WorkspaceLlmCallType;
  model: string;
  promptTokens: number;
  completionTokens: number;
  extra?: Record<string, unknown>;
}): Promise<void> {
  const supabase = svc();
  const payload = {
    ...opts.extra,
    model: opts.model,
    input_tokens: opts.promptTokens,
    output_tokens: opts.completionTokens,
    total_tokens: opts.promptTokens + opts.completionTokens,
  };

  const { error } = opts.reservationId
    ? await supabase
        .from("events")
        .update({ payload })
        .eq("id", opts.reservationId)
        .eq("workspace_id", opts.workspaceId)
    : await supabase.from("events").insert({
        type: opts.type,
        level: "info",
        workspace_id: opts.workspaceId,
        payload,
      });

  if (error) {
    console.error(`[cost-tracker] failed to record ${opts.type} usage:`, error);
  }
}
