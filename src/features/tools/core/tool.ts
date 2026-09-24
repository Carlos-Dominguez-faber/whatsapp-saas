import type { ZodSchema } from "zod";

export type ToolSensitivity = "read" | "write" | "sensitive";

export interface ToolContext {
  workspaceId: string;
  // null when there is no real conversation/contact backing this call (the
  // agent test-chat playground) — normalized from "" by ToolRegistry.run()
  // in registry.ts, the single place every call funnels through, so no tool
  // ever needs to guard against an empty-string UUID sentinel itself.
  conversationId: string | null;
  contactId: string | null;
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
}
