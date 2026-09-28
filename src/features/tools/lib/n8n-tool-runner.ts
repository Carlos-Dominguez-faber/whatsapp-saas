import { createHash, randomUUID } from "node:crypto";
import type { ToolContext, ToolResult } from "../core/tool";
import {
  fetchPinnedFollowingRedirects,
  firstStatusOf,
  RedirectRefusedError,
  validateWebhookUrl,
} from "../services/ssrf-guard";
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
  /** Encrypted at rest; getDynamicN8nTools hands the runner the clear value. */
  auth_header_value: string | null;
  parameters: N8nToolParameter[];
  timeout_ms: number;
  enabled: boolean;
}

/** How much of a sync response is read off the wire. */
const MAX_SYNC_RESPONSE_BYTES = 256 * 1024;
/**
 * How much of it the model sees. The rest is cut: a large response would sit
 * in the context of every later step of the turn and bill for it each time.
 */
export const MAX_LLM_OUTPUT_CHARS = 16 * 1024;

/** Key order doesn't change the key: {a,b} and {b,a} are the same call. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * The same tool with the same arguments for the same inbound batch gets the
 * same key, so a workflow that dedupes on it runs once even if the batch is
 * processed again. Outside a batch (the playground) every call is its own.
 */
export function n8nIdempotencyKey(
  row: Pick<N8nToolRow, "id">,
  args: unknown,
  ctx: ToolContext,
): string {
  if (!ctx.batchId) return randomUUID();
  return createHash("sha256")
    .update(`${ctx.batchId}|${row.id}|${stableStringify(args)}`)
    .digest("hex");
}

/** Cuts what the model will read to MAX_LLM_OUTPUT_CHARS, saying so. */
export function capForModel(output: unknown): unknown {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  if (text === undefined || text.length <= MAX_LLM_OUTPUT_CHARS) return output;
  return `${text.slice(0, MAX_LLM_OUTPUT_CHARS)}\n[respuesta truncada]`;
}

/**
 * Builds the `run` function for a dynamic n8n tool. Every call re-validates
 * the webhook URL (SSRF guard) and pins the request, and each redirect hop,
 * to the address that was checked.
 * `authError` is set when the stored auth header couldn't be decrypted: the
 * tool then refuses to call the workflow without it.
 */
export function buildN8nToolRun(
  row: N8nToolRow,
  opts: { authError?: string } = {},
): (args: unknown, ctx: ToolContext) => Promise<ToolResult> {
  return async function run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    // The caller (registry.runTool) races this whole function against a
    // timeout starting NOW, so the HTTP call only gets what is left of
    // row.timeout_ms after DNS validation.
    const start = Date.now();

    // getEnabledTools(ctx.workspaceId) already scopes rows to this workspace;
    // this is the single point of execution, so check it here too.
    if (row.workspace_id !== ctx.workspaceId) {
      return { ok: false, output: null, error: "Tool does not belong to this workspace" };
    }
    if (opts.authError) {
      return { ok: false, output: null, error: opts.authError };
    }

    const { error: urlError, resolvedIp } = await validateWebhookUrl(row.webhook_url);
    if (urlError || !resolvedIp) {
      return { ok: false, output: null, error: urlError ?? "Cannot resolve hostname" };
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (row.auth_header_name && row.auth_header_value) {
      headers[row.auth_header_name] = row.auth_header_value;
    }

    const body = JSON.stringify({
      workspace_id: ctx.workspaceId,
      conversation_id: ctx.conversationId,
      contact_id: ctx.contactId,
      idempotency_key: n8nIdempotencyKey(row, args, ctx),
      args,
    });

    const remainingMs = Math.max(0, row.timeout_ms - (Date.now() - start));

    let res;
    try {
      // Redirects are followed (up to 3), every hop validated and pinned, and
      // HTTPS only; the auth header never follows to another origin.
      res = await fetchPinnedFollowingRedirects(row.webhook_url, {
        resolvedIp,
        method: "POST",
        headers,
        body,
        timeoutMs: remainingMs,
        maxResponseBytes: row.mode === "sync" ? MAX_SYNC_RESPONSE_BYTES : 0,
      });
    } catch (err) {
      // The POST itself was answered with a redirect: the workflow already
      // got the call, only a later hop failed. Reporting a failure would
      // invite the agent to call it again.
      const firstStatus = firstStatusOf(err);
      if (firstStatus !== undefined && firstStatus >= 300 && firstStatus < 400) {
        return {
          ok: true,
          output: {
            status: firstStatus,
            redirect_followed: false,
            note:
              "El workflow recibió la llamada, pero su respuesta no se pudo leer. " +
              "No la repitas ni le confirmes al cliente un resultado que no conoces.",
          },
        };
      }
      if (err instanceof RedirectRefusedError) {
        return { ok: false, output: null, error: err.message };
      }
      return {
        ok: false,
        output: null,
        error: err instanceof Error ? err.message : "n8n webhook request failed",
      };
    }

    if (res.status < 200 || res.status >= 300) {
      return { ok: false, output: null, error: `HTTP ${res.status}` };
    }

    if (row.mode === "async") {
      // There is no callback/correlation for async workflows yet, so "ok"
      // only means "n8n accepted the job". Say so in the output the LLM
      // reads, or it may confirm an action that can still fail inside n8n.
      return {
        ok: true,
        output: {
          status: "queued",
          result: "unknown",
          note:
            "La acción quedó encolada en n8n y todavía no hay resultado. " +
            "No le confirmes al cliente que se completó: dile que quedó registrada y que se le avisará.",
        },
      };
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
    return { ok: true, output: capForModel(output) };
  };
}
