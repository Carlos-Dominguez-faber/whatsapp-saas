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

/**
 * What happened when a tool actually ran (past schema validation and the
 * sensitive-tool gate). `ok` is the tool's own answer; `null` when the call
 * threw or timed out, so its side effect may or may not have happened.
 */
export interface ToolExecution {
  name: string;
  sensitivity: ToolSensitivity;
  ok: boolean | null;
}

export interface ToolRunOptions {
  timeoutMs?: number; // default 10_000
  retries?: number; // default 1
  /** Called once per tool that actually ran. Its errors are swallowed. */
  onExecuted?: (execution: ToolExecution) => void | Promise<void>;
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
}
