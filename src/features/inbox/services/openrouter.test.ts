import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

// A tool turn runs several steps. `usage` is the LAST step only; `totalUsage`
// sums them all. These fail if token accounting goes back to `usage`.
const LAST_STEP = { inputTokens: 10, outputTokens: 2 };
const ALL_STEPS = { inputTokens: 50, outputTokens: 9 };

mock.module("ai", {
  exports: {
    generateText: async () => ({
      text: "hola",
      usage: LAST_STEP,
      totalUsage: ALL_STEPS,
      steps: [{}, {}, {}],
    }),
    tool: (def: unknown) => def,
    zodSchema: (schema: unknown) => schema,
    stepCountIs: (n: number) => n,
    APICallError: { isInstance: () => false },
  },
});
mock.module("@ai-sdk/openai", {
  exports: { createOpenAI: () => ({ chat: (id: string) => id }) },
});
const noRow: any = {
  select: () => noRow,
  eq: () => noRow,
  maybeSingle: async () => ({ data: null, error: null }),
};
mock.module("@supabase/supabase-js", {
  exports: { createClient: () => ({ from: () => noRow }) },
});
mock.module("@/features/tools/index.ts", { exports: { registry: { run: async () => null } } });
mock.module("@/features/agents/services/active-agent.ts", { exports: { getActiveAgent: async () => null } });
mock.module("@/shared/lib/integration-secrets.ts", { exports: { decryptCredentials: async () => ({}) } });

const { generateReply, generateChatReply, generateWithTools } = await import("./openrouter.ts");

test("generateReply reports the tokens of every step", async () => {
  const r = await generateReply({ systemPrompt: "s", userMessage: "u", workspaceId: "ws_1" });
  assert.deepEqual([r.promptTokens, r.completionTokens], [50, 9]);
});

test("generateChatReply (playground) reports the tokens of every step", async () => {
  const r = await generateChatReply({
    systemPrompt: "s",
    messages: [{ role: "user", content: "hola" }],
    workspaceId: "ws_1",
  });
  assert.deepEqual([r.promptTokens, r.completionTokens], [50, 9]);
});

test("generateWithTools (agent turns) reports the tokens of every step", async () => {
  const r = await generateWithTools({
    systemPrompt: "s",
    userMessage: "u",
    workspaceId: "ws_1",
    availableTools: [],
    toolContext: { workspaceId: "ws_1", conversationId: "c", contactId: "k" },
  } as never);
  assert.deepEqual([r.inputTokens, r.outputTokens], [50, 9]);
});
