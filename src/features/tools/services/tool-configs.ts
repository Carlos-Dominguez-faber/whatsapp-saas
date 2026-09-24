import { createClient as createSbClient } from "@supabase/supabase-js";
import { registry } from "../registry";
import type { Tool } from "../core/tool";
import { buildZodSchema, sensitiveArgKeys } from "../lib/n8n-params-schema";
import { buildN8nToolRun, type N8nToolRow } from "../lib/n8n-tool-runner";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

interface ToolConfigRow {
  tool: { key?: string } | null;
  enabled: boolean;
  config: Record<string, unknown> | null;
}

async function getStaticEnabledTools(workspaceId: string): Promise<Tool[]> {
  const supabase = svc();

  const { data } = await supabase
    .from("tool_configs")
    .select("tool:tools(key), enabled, config")
    .eq("workspace_id", workspaceId)
    .eq("enabled", true);

  const enabledKeys = new Set(
    ((data as ToolConfigRow[] | null) ?? [])
      .map((row) => row.tool?.key)
      .filter((k): k is string => typeof k === "string"),
  );

  return registry.list().filter((t) => enabledKeys.has(t.name));
}

async function getDynamicN8nTools(workspaceId: string): Promise<Tool[]> {
  const supabase = svc();

  const { data } = await supabase
    .from("n8n_tools")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("enabled", true);

  return ((data as N8nToolRow[] | null) ?? []).map((row) => ({
    name: row.name,
    description: row.description,
    sensitivity: row.sensitivity,
    schema: buildZodSchema(row.parameters),
    enabledFor: () => true,
    run: buildN8nToolRun(row),
    preferredTimeoutMs: row.timeout_ms,
    sensitiveArgKeys: sensitiveArgKeys(row.parameters),
  }));
}

/**
 * Returns every Tool enabled for a workspace — static tools (via
 * tool_configs) plus dynamic n8n tools (via n8n_tools), built fresh on
 * every call so config changes apply from the very next conversation turn.
 */
export async function getEnabledTools(workspaceId: string): Promise<Tool[]> {
  const [staticTools, dynamicTools] = await Promise.all([
    getStaticEnabledTools(workspaceId),
    getDynamicN8nTools(workspaceId),
  ]);
  return [...staticTools, ...dynamicTools];
}
