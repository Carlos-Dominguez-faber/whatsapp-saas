import { createClient as createSbClient } from "@supabase/supabase-js";
import type {
  Tool,
  ToolContext,
  ToolResult,
  ToolRunOptions,
} from "./core/tool";

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

async function runWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Tool timeout")), timeoutMs),
    ),
  ]);
}

/**
 * SEC-01: Strip sensitive fields from args before logging.
 * Never log values whose keys hint at secrets or tokens, plus any key the
 * tool itself flagged via `sensitiveArgKeys` (n8n dynamic tools with a
 * free-named parameter the admin marked sensitive).
 */
export function sanitizeArgs(
  args: unknown,
  extraSensitiveKeys: string[] = [],
): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const BLOCKED_KEYS = /token|secret|key|password|auth|credential/i;
  const extra = new Set(extraSensitiveKeys);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    out[k] = BLOCKED_KEYS.test(k) || extra.has(k) ? "[REDACTED]" : v;
  }
  return out;
}

async function logToolCall(
  name: string,
  args: unknown,
  result: ToolResult,
  latencyMs: number,
  ctx: ToolContext,
  sensitiveArgKeys: string[],
): Promise<void> {
  try {
    const supabase = svc();
    await supabase.from("events").insert({
      type: "tool_call",
      level: result.ok ? "info" : "error",
      workspace_id: ctx.workspaceId,
      conversation_id: ctx.conversationId,
      payload: {
        tool_name: name,
        args_summary: sanitizeArgs(args, sensitiveArgKeys),
        result_ok: result.ok,
        latency_ms: latencyMs,
        error: result.error ?? null,
        requires_confirmation: result.requiresConfirmation ?? false,
      },
    });
  } catch (logErr) {
    // Fire-and-forget: never let logging failures surface to caller
    console.warn("[registry] logToolCall failed:", logErr);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// ToolRegistry
// ──────────────────────────────────────────────────────────────────────────────

class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Resolves `name` against the static registry map and runs it. Dynamic
   * (n8n) tools never go through this — they're resolved per-workspace by
   * getEnabledTools and passed straight to runTool, so two workspaces can
   * use the same tool `name` without colliding in this shared Map.
   */
  async run(
    name: string,
    args: unknown,
    ctx: ToolContext,
    opts?: ToolRunOptions,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, output: null, error: `Tool "${name}" not found` };
    }
    return this.runTool(tool, args, ctx, opts);
  }

  /**
   * Runs an already-resolved Tool object — the shared dispatch path for
   * both static tools (via run(), above) and dynamic n8n tools (called
   * directly from openrouter.ts with the Tool instance getEnabledTools
   * already scoped to the right workspace).
   */
  async runTool(
    tool: Tool,
    args: unknown,
    ctx: ToolContext,
    opts?: ToolRunOptions,
  ): Promise<ToolResult> {
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, output: null, error: parsed.error.message };
    }

    // SEC-01: sensitive tools require human confirmation — skip execution
    if (tool.sensitivity === "sensitive") {
      const pendingResult: ToolResult = {
        ok: false,
        output: null,
        requiresConfirmation: true,
        error: "Sensitive tool requires human approval before execution",
      };
      void logToolCall(
        tool.name,
        args,
        pendingResult,
        0,
        ctx,
        tool.sensitiveArgKeys ?? [],
      );
      return pendingResult;
    }

    const timeoutMs = opts?.timeoutMs ?? 10_000;
    // A "write" tool's side effect (e.g. booking/cancelling an appointment)
    // may have already succeeded even when the HTTP call that reported it
    // times out or throws — retrying would risk repeating the mutation.
    // "sensitive" tools never reach this loop (see the early return above).
    const retries = tool.sensitivity === "write" ? 0 : (opts?.retries ?? 1);

    const attempt = () =>
      runWithTimeout(() => tool.run(parsed.data, ctx, opts), timeoutMs);

    const start = Date.now();
    let result: ToolResult;
    let lastError: string | undefined;

    for (let i = 0; i <= retries; i++) {
      try {
        result = await attempt();
        const latencyMs = Date.now() - start;
        void logToolCall(
          tool.name,
          args,
          result,
          latencyMs,
          ctx,
          tool.sensitiveArgKeys ?? [],
        );
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (i < retries) {
          console.warn(
            `[registry] tool "${tool.name}" failed (attempt ${i + 1}), retrying:`,
            lastError,
          );
        }
      }
    }

    const errorResult: ToolResult = {
      ok: false,
      output: null,
      error: lastError ?? "Unknown tool error",
    };
    void logToolCall(
      tool.name,
      args,
      errorResult,
      Date.now() - start,
      ctx,
      tool.sensitiveArgKeys ?? [],
    );
    return errorResult;
  }

  async available(workspaceId: string): Promise<Tool[]> {
    const result: Tool[] = [];
    for (const tool of this.tools.values()) {
      if (await tool.enabledFor(workspaceId)) result.push(tool);
    }
    return result;
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }
}

export const registry = new ToolRegistry();
