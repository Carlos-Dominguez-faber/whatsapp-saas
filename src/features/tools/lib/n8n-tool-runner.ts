import type { ToolContext, ToolResult } from "../core/tool";
import { validateWebhookUrl, fetchPinned } from "../services/ssrf-guard";
import type { N8nToolParameter } from "./n8n-params-schema";

export interface N8nToolRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  mode: "sync" | "async";
  sensitivity: "read" | "write";
  webhook_url: string;
  auth_header_name: string | null;
  auth_header_value: string | null;
  parameters: N8nToolParameter[];
  timeout_ms: number;
  enabled: boolean;
}

const MAX_SYNC_RESPONSE_BYTES = 256 * 1024;

/**
 * Builds the `run` function for a dynamic n8n tool. Every step re-validates
 * the webhook URL (SSRF guard) and re-derives the pinned IP on each call —
 * the row is captured in this closure, built fresh per call to
 * getEnabledTools, so it always reflects the latest saved config.
 */
export function buildN8nToolRun(
  row: N8nToolRow,
): (args: unknown, ctx: ToolContext) => Promise<ToolResult> {
  return async function run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    // Defense in depth: getEnabledTools(ctx.workspaceId) already scopes rows
    // to this workspace, but this is the single point of execution, so the
    // invariant is checked here explicitly too (SEC-01 spirit).
    if (row.workspace_id !== ctx.workspaceId) {
      return { ok: false, output: null, error: "Tool does not belong to this workspace" };
    }

    const { error: urlError, resolvedIp } = await validateWebhookUrl(row.webhook_url);
    if (urlError || !resolvedIp) {
      return { ok: false, output: null, error: urlError ?? "Cannot resolve hostname" };
    }

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (row.auth_header_name && row.auth_header_value) {
      headers[row.auth_header_name] = row.auth_header_value;
    }

    const body = JSON.stringify({
      workspace_id: ctx.workspaceId,
      conversation_id: ctx.conversationId,
      contact_id: ctx.contactId,
      args,
    });

    try {
      const res = await fetchPinned(row.webhook_url, resolvedIp, {
        method: "POST",
        headers,
        body,
        timeoutMs: row.timeout_ms,
        maxResponseBytes: row.mode === "sync" ? MAX_SYNC_RESPONSE_BYTES : 0,
      });

      if (res.status >= 300 && res.status < 400) {
        return { ok: false, output: null, error: `Redirect blocked (HTTP ${res.status})` };
      }
      if (res.status < 200 || res.status >= 300) {
        return { ok: false, output: null, error: `HTTP ${res.status}` };
      }

      if (row.mode === "async") {
        return { ok: true, output: { status: "queued" } };
      }

      let output: unknown = res.bodyText;
      try {
        output = JSON.parse(res.bodyText);
      } catch {
        // Not JSON — report the raw text.
      }
      if (res.truncated && typeof output === "string") {
        output = `${output}\n[respuesta truncada]`;
      }
      return { ok: true, output };
    } catch (err) {
      return {
        ok: false,
        output: null,
        error: err instanceof Error ? err.message : "n8n webhook request failed",
      };
    }
  };
}
