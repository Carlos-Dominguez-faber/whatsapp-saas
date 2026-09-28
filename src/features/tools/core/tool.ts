import type { ZodSchema } from "zod";

export type ToolSensitivity = "read" | "write" | "sensitive";

export interface ToolContext {
  workspaceId: string;
  conversationId: string;
  contactId: string;
  // SEC-01: identity anchored server-side — LLM cannot override these
  /**
   * The inbound batch this turn answers, when there is one (not in the
   * playground). Stable across retries of the batch, so a tool can derive an
   * idempotency key from it.
   */
  batchId?: string;
  /**
   * Set only by the playground (test-chat): who is testing, and what they
   * typed. A write tool acts only on data the tester wrote there.
   */
  playground?: {
    userId: string;
    /** The user turns of this request, verbatim. */
    userMessages: string[];
  };
}

export interface ToolResult {
  ok: boolean;
  output: unknown;
  error?: string;
  requiresConfirmation?: boolean; // SEC-01: true for sensitive tools pending human approval
}

/**
 * A tool about to run: past schema validation and the sensitive-tool gate.
 * `callId` pairs it with its ToolExecution.
 */
export interface ToolStart {
  callId: string;
  name: string;
  sensitivity: ToolSensitivity;
}

/**
 * What happened when a tool actually ran. `ok` is the tool's own answer;
 * `null` when the call threw or timed out, so its side effect may or may not
 * have happened.
 */
export interface ToolExecution extends ToolStart {
  ok: boolean | null;
  /** The tool's output when it answered (not when it threw or timed out). */
  output?: unknown;
}

export interface ToolRunOptions {
  timeoutMs?: number; // default 10_000
  retries?: number; // default 1
  /**
   * Called right before the tool runs. If it throws, the tool does NOT run and
   * run() rejects with that error: a caller that must record a write before
   * it happens can refuse to let it happen unrecorded.
   */
  onStart?: (start: ToolStart) => void | Promise<void>;
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
  /** Per-tool timeout preference, read by the caller before invoking
   *  registry.runTool (n8n dynamic tools only — see getEnabledTools). */
  preferredTimeoutMs?: number;
  /** Extra arg keys to redact in tool_call logs, beyond the generic
   *  secret-name regex in registry.ts (n8n dynamic tools only). */
  sensitiveArgKeys?: string[];
}
