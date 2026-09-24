import { createOpenAI } from "@ai-sdk/openai";
import { generateText, tool, zodSchema, stepCountIs, APICallError } from "ai";
import type { ToolSet } from "ai";

// OpenRouter occasionally returns transient upstream errors (502/503/504) when a
// provider hiccups. Retry idempotent, side-effect-free completions a couple of
// times with a short backoff before surfacing the failure.
function isTransientError(err: unknown): boolean {
  if (APICallError.isInstance(err)) {
    if (err.isRetryable) return true;
    const code = err.statusCode;
    return typeof code === "number" && code >= 500 && code < 600;
  }
  return false;
}

async function withTransientRetry<T>(
  fn: () => Promise<T>,
  {
    retries = 2,
    baseDelayMs = 400,
  }: { retries?: number; baseDelayMs?: number } = {},
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isTransientError(err)) throw err;
      await new Promise((r) => setTimeout(r, baseDelayMs * (attempt + 1)));
    }
  }
  throw lastErr;
}
import { createClient as svcClient } from "@supabase/supabase-js";
import type {
  Tool as ForgeTool,
  ToolContext,
} from "@/features/tools/core/tool";
import { registry } from "@/features/tools/index";
import { getActiveAgent } from "@/features/agents/services/active-agent";
import { decryptCredentials } from "@/shared/lib/integration-secrets";

// ──────────────────────────────────────────────────────────────────────────────
// getWorkspaceModel
// The active agent's model wins; otherwise reads the workspace's openrouter
// integration model. Falls back to the env default, then to gpt-4o-mini.
// ──────────────────────────────────────────────────────────────────────────────

export async function getWorkspaceModel(workspaceId: string): Promise<string> {
  // Active agent model takes precedence (back-compat: null when no agent).
  const agent = await getActiveAgent(workspaceId);
  if (agent?.model) return agent.model;

  try {
    const db = svcClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    const { data } = await db
      .from("integrations")
      .select("config")
      .eq("workspace_id", workspaceId)
      .eq("provider", "openrouter")
      .maybeSingle();

    // The Integraciones → OpenRouter section writes `default_model`; older
    // config used `model`. Read either so the workspace fallback keeps working
    // after the standalone "IA & Modelos" tab was consolidated away.
    const config = data?.config as Record<string, unknown> | null;
    const model = config?.default_model ?? config?.model;

    if (typeof model === "string" && model.length > 0) {
      return model;
    }
  } catch {
    // Non-fatal — fall through to env default
  }

  return process.env.OPENROUTER_DEFAULT_MODEL ?? "openai/gpt-4o-mini";
}

// ──────────────────────────────────────────────────────────────────────────────
// getOpenRouterApiKey
// Per-workspace key from the OpenRouter integration (credentials.openrouter_api_key);
// falls back to the OPENROUTER_API_KEY env var when none is configured.
// ──────────────────────────────────────────────────────────────────────────────
export async function getOpenRouterApiKey(
  workspaceId?: string,
): Promise<string> {
  const envKey = process.env.OPENROUTER_API_KEY ?? "";
  if (!workspaceId) return envKey;

  try {
    const db = svcClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
    const { data } = await db
      .from("integrations")
      .select("credentials")
      .eq("workspace_id", workspaceId)
      .eq("provider", "openrouter")
      .maybeSingle();

    const creds = await decryptCredentials(
      data?.credentials as Record<string, unknown> | null,
      workspaceId,
      "openrouter",
    );
    const key = creds.openrouter_api_key;
    if (typeof key === "string" && key.length > 0) return key;
  } catch {
    // Non-fatal — fall through to env key
  }
  return envKey;
}

// ──────────────────────────────────────────────────────────────────────────────
// generateReply — backward-compatible, no tools
// ──────────────────────────────────────────────────────────────────────────────

export interface GenerateReplyResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
}

interface GenerateReplyParams {
  model?: string;
  systemPrompt: string;
  userMessage: string;
  /** Resolves the per-workspace OpenRouter key; falls back to env when omitted. */
  workspaceId?: string;
}

/**
 * Generates a reply using OpenRouter as the AI gateway.
 *
 * Returns the generated text and token usage counts.
 * Internally maps AI SDK v6 field names (inputTokens / outputTokens)
 * to the stable promptTokens / completionTokens interface used
 * by cost-tracker throughout the application.
 */
export async function generateReply(
  params: GenerateReplyParams,
): Promise<GenerateReplyResult> {
  const { systemPrompt, userMessage } = params;

  const modelId =
    params.model ??
    process.env.OPENROUTER_DEFAULT_MODEL ??
    "openai/gpt-4o-mini";

  const openrouter = createOpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: await getOpenRouterApiKey(params.workspaceId),
    headers: {
      "HTTP-Referer":
        process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
      "X-Title": "Agente WhatsApp",
    },
  });

  const result = await generateText({
    model: openrouter.chat(modelId),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    maxOutputTokens: 1024,
  });

  // AI SDK v6 exposes inputTokens / outputTokens; map to stable naming
  const promptTokens = result.usage?.inputTokens ?? 0;
  const completionTokens = result.usage?.outputTokens ?? 0;

  return {
    text: result.text,
    promptTokens,
    completionTokens,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// generateChatReply — multi-turn, no tools (used by the agent test playground)
// ──────────────────────────────────────────────────────────────────────────────

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export async function generateChatReply(params: {
  model?: string;
  systemPrompt: string;
  messages: ChatTurn[];
  maxOutputTokens?: number;
  /** Resolves the per-workspace OpenRouter key; falls back to env when omitted. */
  workspaceId?: string;
  /** Optional tool-calling: when provided, the model can invoke these tools. */
  tools?: ForgeTool[];
  toolContext?: ToolContext;
}): Promise<GenerateReplyResult> {
  const modelId =
    params.model ??
    process.env.OPENROUTER_DEFAULT_MODEL ??
    "openai/gpt-4o-mini";

  const openrouter = createOpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: await getOpenRouterApiKey(params.workspaceId),
    headers: {
      "HTTP-Referer":
        process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
      "X-Title": "Agente WhatsApp",
    },
  });

  // Bridge Forge tools → AI SDK ToolSet (same shape as generateWithTools).
  const aiTools: ToolSet = {};
  if (params.tools && params.toolContext) {
    const ctx = params.toolContext;
    for (const forgeTool of params.tools) {
      aiTools[forgeTool.name] = tool({
        description: forgeTool.description,
        inputSchema: zodSchema(forgeTool.schema),
        execute: async (args: unknown): Promise<unknown> =>
          registry.run(forgeTool.name, args, ctx),
      });
    }
  }
  const hasTools = Object.keys(aiTools).length > 0;

  const result = await withTransientRetry(() =>
    generateText({
      model: openrouter.chat(modelId),
      messages: [
        { role: "system", content: params.systemPrompt },
        ...params.messages,
      ],
      tools: hasTools ? aiTools : undefined,
      stopWhen: hasTools ? stepCountIs(5) : undefined,
      maxOutputTokens: params.maxOutputTokens ?? 512,
    }),
  );

  return {
    text: result.text,
    promptTokens: result.usage?.inputTokens ?? 0,
    completionTokens: result.usage?.outputTokens ?? 0,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// generateWithTools — AI SDK v6 tool-calling variant
// ──────────────────────────────────────────────────────────────────────────────

export interface GenerateWithToolsParams {
  model?: string;
  systemPrompt: string;
  userMessage: string;
  workspaceId: string;
  availableTools?: ForgeTool[];
  toolContext: ToolContext;
  /** Prior conversation turns (oldest→newest), injected between system and the current batch. */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface GenerateWithToolsResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  toolCallsExecuted: number;
}

/**
 * Heads-up sent to the customer BEFORE a slow calendar tool runs.
 *
 * It has to live here and not in the prompt: whatever the model writes before a
 * tool call stays in an intermediate step, and generateText only hands back
 * `result.text` — the final one. Without this the contact stares at silence
 * while we wait on HighLevel/Cal.com.
 *
 * Only two moments: checking the calendar and booking. Reschedule and cancel
 * deliberately stay quiet.
 */
const TOOL_HEADS_UP: Record<string, string> = {
  check_availability: "Dame un segundo, reviso la agenda 📅",
  check_availability_calcom: "Dame un segundo, reviso la agenda 📅",
  schedule_highlevel: "Perfecto, estoy agendando tu cita ⏳",
  schedule_calcom: "Perfecto, estoy agendando tu cita ⏳",
};

async function sendToolHeadsUp(
  toolName: string,
  ctx: ToolContext,
  announced: Set<string>,
): Promise<void> {
  const body = TOOL_HEADS_UP[toolName];
  // conversationId is null in the agent test-chat playground — no one to tell.
  if (!body || !ctx.conversationId || announced.has(toolName)) return;
  announced.add(toolName);

  try {
    const { dispatchText } = await import("./dispatch");
    await dispatchText({
      workspaceId: ctx.workspaceId,
      conversationId: ctx.conversationId,
      body,
    });
  } catch (err) {
    // Best-effort by design: a heads-up that fails to send must never take down
    // the real turn behind it. The detail stays server-side.
    console.error(
      "[openrouter] tool heads-up failed:",
      err instanceof Error ? err.message : "unknown",
    );
  }
}

/**
 * Generates a reply with optional AI SDK v6 tool-calling.
 *
 * Bridges Forge Tool definitions into AI SDK v6 Tool objects using
 * inputSchema + execute. SEC-01: ToolContext is always server-anchored —
 * the LLM cannot supply or override workspaceId, conversationId, or contactId.
 *
 * In AI SDK v6 multi-step loops are controlled via stopWhen: stepCountIs(n).
 */
export async function generateWithTools(
  params: GenerateWithToolsParams,
): Promise<GenerateWithToolsResult> {
  const modelId =
    params.model ??
    process.env.OPENROUTER_DEFAULT_MODEL ??
    "openai/gpt-4o-mini";

  const openrouter = createOpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: await getOpenRouterApiKey(params.workspaceId),
    headers: {
      "HTTP-Referer":
        process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
      "X-Title": "Agente WhatsApp",
    },
  });

  // Build AI SDK v6 ToolSet from available Forge tools.
  // Each entry uses inputSchema (zodSchema wrapper) + execute — the correct v6 shape.
  // execute returns Promise<unknown> to satisfy ToolSet's output constraint.
  const aiTools: ToolSet = {};

  // One turn = one heads-up per tool: the model can call the same tool twice in
  // a multi-step loop, and the customer should not read the same line twice.
  const announced = new Set<string>();

  for (const forgeTool of params.availableTools ?? []) {
    const ctx = params.toolContext;
    aiTools[forgeTool.name] = tool({
      description: forgeTool.description,
      inputSchema: zodSchema(forgeTool.schema),
      execute: async (args: unknown): Promise<unknown> => {
        await sendToolHeadsUp(forgeTool.name, ctx, announced);
        return registry.run(forgeTool.name, args, ctx);
      },
    });
  }

  const hasTools = Object.keys(aiTools).length > 0;

  const result = await generateText({
    model: openrouter.chat(modelId),
    messages: [
      { role: "system", content: params.systemPrompt },
      ...(params.history ?? []),
      { role: "user", content: params.userMessage },
    ],
    tools: hasTools ? aiTools : undefined,
    stopWhen: hasTools ? stepCountIs(5) : undefined,
    maxOutputTokens: 1024,
  });

  return {
    text: result.text,
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
    toolCallsExecuted: result.steps?.length ?? 0,
  };
}
