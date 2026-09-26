// F7: SEC-06 Cost Enforcer — hard budget enforcement with observable alert events.
// Distinct from cost-tracker.ts (which only records usage).
// This module ACTS on budget state: degrade or cut AI when thresholds are crossed.

import { createClient as createSbClient } from "@supabase/supabase-js";
import {
  isMissingFunctionError,
  reportMissingFunctionOnce,
} from "@/shared/lib/db-errors";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

type Svc = ReturnType<typeof svc>;

// Hard cut: AI is completely halted above this daily token count. Kept at the
// 1,000,000 tokens the old per-turn check in cost-tracker enforced.
const DAILY_TOKEN_HARD_LIMIT = 1_000_000;

// Warn threshold: degrade to a cheaper model above this count
const DAILY_TOKEN_WARN_THRESHOLD = 800_000;

const FALLBACK_MODEL = "openai/gpt-4o-mini";

/** Event types whose total_tokens count toward the daily budget. */
export const BUDGET_EVENT_TYPES = [
  "llm_usage",
  "template_generate",
  "agent_test_chat",
] as const;

export type CostPolicy = "allow" | "degrade" | "cut";

export interface CostPolicyResult {
  policy: CostPolicy;
  reason: string;
  fallbackModel?: string;
}

/**
 * Enforces the workspace daily token budget.
 *
 * Sums today's budget events, compares against thresholds, and:
 *   - >= DAILY_TOKEN_HARD_LIMIT     → policy=cut (caller must not invoke AI);
 *                                     one cost_cut event per workspace and day
 *   - >= DAILY_TOKEN_WARN_THRESHOLD → policy=degrade (cheaper model); one
 *                                     cost_alert event per workspace and day
 *   - otherwise                     → policy=allow
 *
 * A database error throws, so the caller's batch is retried and eventually
 * dead-lettered instead of spending without a verified budget. If
 * sum_daily_llm_tokens does not exist yet (code deployed before `db-push`),
 * the sum falls back to reading the events directly, so the cap still holds.
 */
export async function enforceCostPolicy(
  workspaceId: string,
): Promise<CostPolicyResult> {
  const supabase = svc();

  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);

  const totalTokensToday = await readDailyTokens(supabase, workspaceId, dayStart);

  if (totalTokensToday >= DAILY_TOKEN_HARD_LIMIT) {
    console.warn(
      `[cost-enforcer] workspace=${workspaceId} hit hard limit: ${totalTokensToday} tokens`,
    );
    await emitOncePerDay(supabase, workspaceId, dayStart, "cost_cut", "error", {
      total_tokens_today: totalTokensToday,
      hard_limit: DAILY_TOKEN_HARD_LIMIT,
    });
    return { policy: "cut", reason: "daily_hard_limit" };
  }

  if (totalTokensToday >= DAILY_TOKEN_WARN_THRESHOLD) {
    console.warn(
      `[cost-enforcer] workspace=${workspaceId} warn threshold crossed: ${totalTokensToday} tokens`,
    );
    await emitOncePerDay(supabase, workspaceId, dayStart, "cost_alert", "warn", {
      total_tokens_today: totalTokensToday,
      threshold: DAILY_TOKEN_WARN_THRESHOLD,
      hard_limit: DAILY_TOKEN_HARD_LIMIT,
    });
    return {
      policy: "degrade",
      reason: "daily_warn_threshold",
      fallbackModel: FALLBACK_MODEL,
    };
  }

  return { policy: "allow", reason: "within_budget" };
}

/**
 * Today's budget tokens: summed in SQL by sum_daily_llm_tokens (no PostgREST
 * row cap), or — only when that function does not exist yet — summed here
 * page by page.
 */
async function readDailyTokens(
  supabase: Svc,
  workspaceId: string,
  dayStart: Date,
): Promise<number> {
  const { data, error } = await supabase.rpc("sum_daily_llm_tokens", {
    p_workspace_id: workspaceId,
    p_day_start: dayStart.toISOString(),
  });

  if (!error) return Number(data) || 0;

  if (isMissingFunctionError(error, "sum_daily_llm_tokens")) {
    reportMissingFunctionOnce(
      "sum_daily_llm_tokens",
      "the daily budget is summed from the events directly",
    );
    return sumDailyTokensDirect(supabase, workspaceId, dayStart);
  }

  // Fail closed without dropping the turn: an unverifiable budget is not an
  // allowed one, so throw and let processNextBatch() retry with backoff and
  // dead-letter the batch visibly if the database stays down.
  console.error("[cost-enforcer] failed to read the daily budget:", error);
  throw new Error(`sum_daily_llm_tokens failed: ${error.message}`);
}

const PAGE_SIZE = 1000;
const MAX_PAGES = 100;

async function sumDailyTokensDirect(
  supabase: Svc,
  workspaceId: string,
  dayStart: Date,
): Promise<number> {
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const { data, error } = await supabase
      .from("events")
      .select("payload")
      .eq("workspace_id", workspaceId)
      .in("type", [...BUDGET_EVENT_TYPES])
      .gte("created_at", dayStart.toISOString())
      .order("created_at", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      throw new Error(`daily budget fallback read failed: ${error.message}`);
    }
    for (const row of data ?? []) {
      const t = (row.payload as Record<string, unknown> | null)?.total_tokens;
      if (typeof t === "number" && Number.isFinite(t) && t >= 0) total += t;
    }
    if ((data?.length ?? 0) < PAGE_SIZE) break;
  }
  return total;
}

/**
 * Inserts an alert event unless this workspace already has one of `type`
 * today. Best-effort: a failure is logged and never blocks the turn.
 */
async function emitOncePerDay(
  supabase: Svc,
  workspaceId: string,
  dayStart: Date,
  type: "cost_alert" | "cost_cut",
  level: "warn" | "error",
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const { data: existing, error } = await supabase
      .from("events")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("type", type)
      .gte("created_at", dayStart.toISOString())
      .limit(1);
    if (error) throw error;
    if ((existing?.length ?? 0) > 0) return;

    const { error: insertError } = await supabase.from("events").insert({
      type,
      level,
      workspace_id: workspaceId,
      payload,
    });
    if (insertError) throw insertError;
  } catch (err) {
    console.error(`[cost-enforcer] failed to record ${type}:`, err);
  }
}

const CUT_FALLBACK_MESSAGE =
  "Lo siento, el servicio de IA no está disponible temporalmente. " +
  "Por favor contacta a un representante humano para continuar.";

/**
 * Builds the final system prompt and model selection based on the active policy.
 *
 * - allow   → returns baseSystemPrompt unchanged, no model override
 * - degrade → keeps the whole prompt (persona, rules and guardrails come last
 *             in prompt-builder, so trimming lines would drop them) and only
 *             switches to the cheaper model
 * - cut     → caller MUST NOT invoke AI; the returned systemPrompt is the
 *             fallback message
 */
export async function buildCostAwareSystemPrompt(
  workspaceId: string,
  baseSystemPrompt: string,
  policy: CostPolicy,
): Promise<{ systemPrompt: string; model?: string }> {
  switch (policy) {
    case "cut":
      return { systemPrompt: CUT_FALLBACK_MESSAGE };

    case "degrade":
      console.info(
        `[cost-enforcer] workspace=${workspaceId} degraded to ${FALLBACK_MODEL}`,
      );
      return { systemPrompt: baseSystemPrompt, model: FALLBACK_MODEL };

    case "allow":
    default:
      return { systemPrompt: baseSystemPrompt };
  }
}
