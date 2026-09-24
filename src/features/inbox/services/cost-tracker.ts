import { createClient as createSbClient } from "@supabase/supabase-js";
import { performance } from "node:perf_hooks";

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
    console.error("[cost-tracker] hourly check error:", error);
    // Fail closed — an unverifiable budget is not an allowed one (same
    // policy as enforceCostPolicy in cost-enforcer.ts).
    return { allowed: false, reason: "rate_limit_check_failed" };
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
 * migration 20260823000000 — so two concurrent callers for the same
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
    console.error("[cost-tracker] reserve_llm_turn RPC error:", error);
    return { allowed: false, reason: "rate_limit_check_failed" };
  }

  const row = (
    data as { allowed: boolean; reservation_id: string | null }[] | null
  )?.[0];

  if (!row?.allowed) {
    return { allowed: false, reason: "rate_limit_contact_hour" };
  }

  return { allowed: true, reservationId: row.reservation_id ?? undefined };
}
