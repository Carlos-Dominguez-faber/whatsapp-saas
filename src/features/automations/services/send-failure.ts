/**
 * A template an automation sent that WhatsApp reported as failed later, through
 * the status webhook. With YCloud, a paused template (132015) or an
 * undeliverable message (131026) arrives that way, not as the send call's
 * answer, so the executor already closed the run as done. Here the run is
 * closed as failed with the reason, and a paused template switches its rule
 * off, the same as the executor does when the send itself is refused.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

const TEMPLATE_PAUSED = 132015;

/**
 * No-op for a message no automation sent. Throws on a database error, so the
 * webhook answers 500 and the provider delivers the status again.
 */
export async function recordAutomationSendFailure(
  supabase: SupabaseClient,
  workspaceId: string,
  meta: Record<string, unknown> | null | undefined,
  providerCode: number | null,
): Promise<void> {
  const runId = typeof meta?.automation_run_id === "string" ? meta.automation_run_id : null;
  if (!runId) return;
  const reason = providerCode === TEMPLATE_PAUSED ? "template_paused" : "send_rejected";

  const { data: closed, error } = await supabase
    .from("automation_runs")
    .update({ status: "failed", error: reason, finished_at: new Date().toISOString() })
    .eq("id", runId)
    .eq("workspace_id", workspaceId)
    .in("status", ["done", "processing"])
    .select("id, rule_id, conversation_id");
  if (error) {
    throw new Error(`[automations] could not close the run of a failed send: ${error.message}`);
  }

  const run = ((closed as Array<{ rule_id: string; conversation_id: string | null }> | null) ??
    [])[0];
  const ruleId =
    run?.rule_id ??
    (typeof meta?.automation_rule_id === "string" ? meta.automation_rule_id : null);

  if (run) {
    const { error: eventError } = await supabase.from("events").insert({
      type: "automation_failed",
      level: "error",
      workspace_id: workspaceId,
      conversation_id: run.conversation_id,
      payload: {
        rule_id: run.rule_id,
        run_id: runId,
        reason,
        provider_code: providerCode,
        source: "status_webhook",
      },
    });
    if (eventError) {
      console.error("[automations] could not record the failed send:", eventError.message);
    }
  }

  if (providerCode === TEMPLATE_PAUSED && ruleId) {
    const { error: ruleError } = await supabase
      .from("automation_rules")
      .update({ enabled: false, paused_reason: "template_paused" })
      .eq("id", ruleId)
      .eq("workspace_id", workspaceId)
      .eq("enabled", true);
    if (ruleError) {
      throw new Error(`[automations] could not pause the rule: ${ruleError.message}`);
    }
  }
}
