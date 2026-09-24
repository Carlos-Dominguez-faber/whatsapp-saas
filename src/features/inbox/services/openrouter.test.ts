import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "test-platform-key";

// Sin key propia del tenant: getOpenRouterApiKey cae a la de la plataforma.
mock.module("@supabase/supabase-js", {
  exports: {
    createClient: () => ({
      from: () => {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return chain;
      },
    }),
  },
});

/** Qué hace el generateText fake en la próxima llamada — una por test. */
let generateTextImpl: () => Promise<{
  text: string;
  usage: unknown;
  steps: unknown[];
}> = async () => ({
  text: "listo",
  usage: { inputTokens: 1, outputTokens: 1 },
  steps: [],
});

mock.module("ai", {
  exports: {
    generateText: () => generateTextImpl(),
    tool: (cfg: unknown) => cfg,
    zodSchema: (s: unknown) => s,
    stepCountIs: (n: number) => n,
    APICallError: { isInstance: () => false },
  },
});

mock.module("@ai-sdk/openai", {
  exports: {
    createOpenAI: () => ({ chat: (id: string) => ({ modelId: id }) }),
  },
});

mock.module("@/features/tools/index", {
  exports: { registry: { runTool: async () => ({ ok: true, output: null }) } },
});

mock.module("@/features/agents/services/active-agent", {
  exports: { getActiveAgent: async () => null },
});

const { generateWithTools } = await import("./openrouter.ts");

function baseParams() {
  return {
    systemPrompt: "sys",
    userMessage: "hola",
    workspaceId: "ws_1",
    availableTools: [],
    toolContext: {
      workspaceId: "ws_1",
      conversationId: "conv_1",
      contactId: "contact_1",
    },
  };
}

// Forma real de AI SDK v6 (StaticToolResult): cada step trae
// toolResults: Array<{ type:"tool-result", toolCallId, toolName, input,
// output }>, donde `output` es lo que devolvió nuestro execute — o sea el
// ToolResult de registry.runTool.

test("toolResults expone el output de cada tool ejecutada, aplanando los steps", async () => {
  generateTextImpl = async () => ({
    text: "listo",
    usage: { inputTokens: 1, outputTokens: 1 },
    steps: [
      {
        toolResults: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "handoff_human",
            input: {},
            output: { ok: true, output: { handoff: true, reason: "agent_stuck" } },
          },
        ],
      },
      {
        toolResults: [
          {
            type: "tool-result",
            toolCallId: "c2",
            toolName: "check_availability",
            input: {},
            output: { ok: true, output: "10am" },
          },
        ],
      },
    ],
  });

  const result = await generateWithTools(baseParams());

  assert.deepEqual(result.toolResults, [
    {
      toolName: "handoff_human",
      output: { ok: true, output: { handoff: true, reason: "agent_stuck" } },
    },
    { toolName: "check_availability", output: { ok: true, output: "10am" } },
  ]);
});

test("un turno sin tool calls devuelve toolResults vacío, no undefined", async () => {
  generateTextImpl = async () => ({
    text: "listo",
    usage: { inputTokens: 1, outputTokens: 1 },
    steps: [{ toolResults: [] }, {}],
  });

  const result = await generateWithTools(baseParams());

  assert.deepEqual(result.toolResults, []);
});
