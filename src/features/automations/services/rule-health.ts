/**
 * What the Automations tab shows about how each rule is doing: its last
 * finished run and its failures in the last 24 hours, plus two workspace
 * warnings (the daily cap was hit, or a send ended with an unknown outcome).
 * Read with the service role; the caller has already checked membership, and
 * every read is scoped to the workspace.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface RuleHealth {
  lastStatus: string | null;
  lastError: string | null;
  lastFinishedAt: string | null;
  failures24h: number;
}

export interface AutomationHealth {
  rules: Record<string, RuleHealth>;
  /** Some run was skipped by the daily cap in the last 24 hours. */
  dailyCapHit: boolean;
  /** Sends in the last 24 hours that may or may not have reached the contact. */
  outcomeUnknown24h: number;
}

/** Null when it can't be read: the tab then just shows the rules. */
export async function loadAutomationHealth(
  db: SupabaseClient,
  workspaceId: string,
): Promise<AutomationHealth | null> {
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  try {
    const [perRule, cap, unknown] = await Promise.all([
      db.rpc("automation_rule_health", { p_workspace_id: workspaceId }),
      db
        .from("automation_runs")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("status", "skipped")
        .eq("error", "daily_cap")
        .gt("finished_at", since),
      db
        .from("automation_runs")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("status", "failed")
        .eq("error", "outcome_unknown")
        .gt("finished_at", since),
    ]);
    const error = perRule.error ?? cap.error ?? unknown.error;
    if (error) {
      console.error("[automations] could not read the rules' health:", error.message);
      return null;
    }

    const rules: Record<string, RuleHealth> = {};
    for (const row of (perRule.data as Array<{
      rule_id: string;
      last_status: string | null;
      last_error: string | null;
      last_finished_at: string | null;
      failures_24h: number | null;
    }> | null) ?? []) {
      rules[row.rule_id] = {
        lastStatus: row.last_status,
        lastError: row.last_error,
        lastFinishedAt: row.last_finished_at,
        failures24h: row.failures_24h ?? 0,
      };
    }
    return {
      rules,
      dailyCapHit: (cap.count ?? 0) > 0,
      outcomeUnknown24h: unknown.count ?? 0,
    };
  } catch (err) {
    console.error(
      "[automations] could not read the rules' health:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
