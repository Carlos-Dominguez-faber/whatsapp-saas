// F7: SEC-06 Cost Enforcer — hard budget enforcement with observable alert events.
// Distinct from cost-tracker.ts (which only records usage).
// This module ACTS on budget state: degrade or cut AI when thresholds are crossed.

import { createClient as createSbClient } from "@supabase/supabase-js";
import { isMissingFunctionError } from "@/shared/lib/db-errors";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

// Hard cut: AI is completely halted above this daily token count. Kept at the
// 1,000,000 tokens the old per-turn check in cost-tracker enforced.
const DAILY_TOKEN_HARD_LIMIT = 1_000_000;

// Warn threshold: degrade to a cheaper model above this count
const DAILY_TOKEN_WARN_THRESHOLD = 800_000;

export type CostPolicy = "allow" | "degrade" | "cut";

export interface CostPolicyResult {
  policy: CostPolicy;
  reason: string;
  fallbackModel?: string;
}

/**
 * Enforces the workspace daily token budget.
 *
 * Reads today's llm_usage events, compares against thresholds, and:
 *   - >= DAILY_TOKEN_HARD_LIMIT  → policy=cut (caller must not invoke AI)
 *   - >= DAILY_TOKEN_WARN_THRESHOLD → policy=degrade + inserts cost_alert event
 *   - otherwise                  → policy=allow
 *
 * A database error throws, so the caller's batch is retried and eventually
 * dead-lettered instead of spending without a verified budget. A missing
 * sum_daily_llm_tokens (code deployed before `db-push`) allows with a warning.
 */
export async function enforceCostPolicy(
  workspaceId: string,
): Promise<CostPolicyResult> {
  const supabase = svc();

  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);

  const { data, error } = await supabase.rpc("sum_daily_llm_tokens", {
    p_workspace_id: workspaceId,
    p_day_start: dayStart.toISOString(),
  });

  if (error) {
    if (isMissingFunctionError(error)) {
      console.warn(
        "[cost-enforcer] sum_daily_llm_tokens is missing — run `setup.mjs db-push`; the daily budget is not enforced until then",
      );
      return { policy: "allow", reason: "budget_function_missing" };
    }
    // Fail closed without dropping the turn: an unverifiable budget is not an
    // allowed one, so throw and let processNextBatch() retry with backoff and
    // dead-letter the batch visibly if the database stays down.
    console.error("[cost-enforcer] failed to read the daily budget:", error);
    throw new Error(`sum_daily_llm_tokens failed: ${error.message}`);
  }

  // sum_daily_llm_tokens sums in SQL — no PostgREST
  // row-cap truncation regardless of how many llm_usage events exist today.
  const totalTokensToday = Number(data) || 0;

  if (totalTokensToday >= DAILY_TOKEN_HARD_LIMIT) {
    console.warn(
      `[cost-enforcer] workspace=${workspaceId} hit hard limit: ${totalTokensToday} tokens`,
    );
    return { policy: "cut", reason: "daily_hard_limit" };
  }

  if (totalTokensToday >= DAILY_TOKEN_WARN_THRESHOLD) {
    // Insert an observable alert event — visible in the events stream
    await supabase.from("events").insert({
      type: "cost_alert",
      level: "warn",
      workspace_id: workspaceId,
      payload: {
        total_tokens_today: totalTokensToday,
        threshold: DAILY_TOKEN_WARN_THRESHOLD,
        hard_limit: DAILY_TOKEN_HARD_LIMIT,
      },
    });

    console.warn(
      `[cost-enforcer] workspace=${workspaceId} warn threshold crossed: ${totalTokensToday} tokens`,
    );

    return {
      policy: "degrade",
      reason: "daily_warn_threshold",
      fallbackModel: "openai/gpt-4o-mini",
    };
  }

  return { policy: "allow", reason: "within_budget" };
}

const CUT_FALLBACK_MESSAGE =
  "Lo siento, el servicio de IA no está disponible temporalmente. " +
  "Por favor contacta a un representante humano para continuar.";

/**
 * Builds the final system prompt and model selection based on the active policy.
 *
 * - allow   → returns baseSystemPrompt unchanged, no model override
 * - degrade → returns a shortened prompt + fallbackModel from policy result
 * - cut     → caller MUST NOT invoke AI; the returned systemPrompt is the
 *             fallback message that should be sent directly to the user
 */
export async function buildCostAwareSystemPrompt(
  workspaceId: string,
  baseSystemPrompt: string,
  policy: CostPolicy,
): Promise<{ systemPrompt: string; model?: string }> {
  switch (policy) {
    case "cut":
      return { systemPrompt: CUT_FALLBACK_MESSAGE };

    case "degrade": {
      // Strip verbose instructions to reduce token spend further
      const shortened = baseSystemPrompt
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .slice(0, 20)
        .join("\n");

      console.info(
        `[cost-enforcer] workspace=${workspaceId} degraded prompt to ${shortened.length} chars`,
      );

      return {
        systemPrompt: shortened,
        model: "openai/gpt-4o-mini",
      };
    }

    case "allow":
    default:
      return { systemPrompt: baseSystemPrompt };
  }
}
