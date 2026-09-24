import type { ZodSchema } from "zod";

export type ToolSensitivity = "read" | "write" | "sensitive";

export interface ToolContext {
  workspaceId: string;
  conversationId: string;
  contactId: string;
  // SEC-01: identity anchored server-side — LLM cannot override these
}

export interface ToolResult {
  ok: boolean;
  output: unknown;
  error?: string;
  requiresConfirmation?: boolean; // SEC-01: true for sensitive tools pending human approval
}

export interface ToolRunOptions {
  timeoutMs?: number; // default 10_000
  retries?: number; // default 1
}

export interface Tool<TArgs = unknown> {
  name: string;
  description: string;
  sensitivity: ToolSensitivity;
  schema: ZodSchema<TArgs>;
  enabledFor(workspaceId: string): boolean | Promise<boolean>;
  run(
    args: TArgs,
    ctx: ToolContext,
    opts?: ToolRunOptions,
  ): Promise<ToolResult>;
  /** Per-tool timeout preference, read by the caller before invoking
   *  registry.runTool (n8n dynamic tools only — see getEnabledTools). */
  preferredTimeoutMs?: number;
  /** Extra arg keys to redact in tool_call logs, beyond the generic
   *  secret-name regex in registry.ts (n8n dynamic tools only). */
  sensitiveArgKeys?: string[];
}
