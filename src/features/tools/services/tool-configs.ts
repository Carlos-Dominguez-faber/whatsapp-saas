import { createClient as createSbClient } from "@supabase/supabase-js";
import { registry } from "../registry";
import type { Tool } from "../core/tool";
import { emitEventOncePerDay } from "@/features/inbox/services/daily-events";
import { buildZodSchema, sensitiveArgKeys } from "../lib/n8n-params-schema";
import { buildN8nToolRun, type N8nToolRow } from "../lib/n8n-tool-runner";
import { decryptN8nAuth } from "../lib/n8n-secrets";

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

// The registry's external timeout (registry.ts `runWithTimeout`) races
// against tool.run() starting at t=0; the internal deadline inside
// n8n-tool-runner.ts's fetchPinned call only has row.timeout_ms to work
// with once DNS validation finishes, landing at the same instant at best.
// Padding the external budget makes the internal one the one that actually
// fires first, so registry.runTool gets a clean {ok:false} instead of
// racing the timeout and retrying on top of a webhook call still in flight.
const EXTERNAL_TIMEOUT_MARGIN_MS = 500;

const N8N_TOOL_COLUMNS =
  "id, workspace_id, name, description, mode, sensitivity, webhook_url, auth_header_name, auth_header_value, parameters, timeout_ms, enabled";

async function getDynamicN8nTools(workspaceId: string): Promise<Tool[]> {
  const supabase = svc();

  const { data, error } = await supabase
    .from("n8n_tools")
    .select(N8N_TOOL_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("enabled", true);
  if (error) {
    // Static tools still work without the dynamic ones.
    console.error("[tools] n8n_tools lookup failed:", error);
    return [];
  }

  const staticNames = new Set(registry.list().map((t) => t.name));
  const tools: Tool[] = [];
  for (const row of (data as N8nToolRow[] | null) ?? []) {
    // A row named like a built-in tool (e.g. handoff_human) would shadow it
    // for the model. The API refuses such names; a row that has one anyway
    // (written directly, or before that tool existed) is left out.
    if (staticNames.has(row.name)) {
      await emitEventOncePerDay(
        supabase,
        workspaceId,
        "n8n_tool_name_collision",
        "warn",
        { tool_id: row.id, name: row.name },
        { tool_id: row.id },
      );
      continue;
    }

    let authError: string | undefined;
    let authValue = row.auth_header_value;
    if (authValue) {
      try {
        authValue = await decryptN8nAuth(workspaceId, authValue);
      } catch (err) {
        console.error(`[tools] n8n tool ${row.id}: auth header won't decrypt:`, err);
        authValue = null;
        authError =
          "No se pudo leer el header de autenticación de esta herramienta; vuelve a guardarlo en Configuración.";
      }
    }

    const clearRow: N8nToolRow = { ...row, auth_header_value: authValue };
    tools.push({
      name: row.name,
      description: row.description,
      sensitivity: row.sensitivity,
      schema: buildZodSchema(row.parameters),
      enabledFor: () => true,
      run: buildN8nToolRun(clearRow, { authError }),
      preferredTimeoutMs: row.timeout_ms + EXTERNAL_TIMEOUT_MARGIN_MS,
      sensitiveArgKeys: sensitiveArgKeys(row.parameters),
    });
  }
  return tools;
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
