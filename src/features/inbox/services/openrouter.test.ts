import assert from "node:assert/strict";
import { test, mock } from "node:test";
import type { Tool } from "@/features/tools/core/tool.ts";
import type { ZodSchema } from "zod";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "platform-key";

// No OpenRouter integration row: getOpenRouterApiKey falls back to the env key.
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

// ──────────────────────────────────────────────────────────────────────────────
// These mocks must be registered BEFORE the only `import("./openrouter.ts")` in
// this file: node caches the module on first import, which fixes the bindings
// of its static imports ("ai", "@ai-sdk/openai", "@/features/tools/index") — a
// later mock.module would not reach them.
// ──────────────────────────────────────────────────────────────────────────────

type FakeAiTool = { execute: (args: unknown) => Promise<unknown> };

/** What the fake generateText does on its next call — one per test. */
let generateTextImpl: (opts: {
  tools?: Record<string, FakeAiTool>;
}) => Promise<{ text: string; usage: unknown; steps: unknown[] }> = async () => ({
  text: "listo",
  usage: { inputTokens: 1, outputTokens: 1 },
  steps: [],
});

mock.module("ai", {
  exports: {
    generateText: (opts: { tools?: Record<string, FakeAiTool> }) =>
      generateTextImpl(opts),
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

let dispatchCalls: Array<{ conversationId: string | null; body: string }> = [];
let dispatchImpl: (params: {
  conversationId: string | null;
  body: string;
}) => Promise<unknown> = async (p) => {
  dispatchCalls.push(p);
  return { ok: true };
};

mock.module("./dispatch", {
  exports: {
    dispatchText: (p: { conversationId: string | null; body: string }) =>
      dispatchImpl(p),
  },
});

let runImpl: (
  name: string,
  args: unknown,
) => Promise<{ ok: boolean; output: unknown }> = async () => ({
  ok: true,
  output: "tool-result",
});

mock.module("@/features/tools/index", {
  exports: {
    registry: {
      run: (name: string, args: unknown) => runImpl(name, args),
    },
  },
});

const { generateWithTools } = await import("./openrouter.ts");

// ──────────────────────────────────────────────────────────────────────────────
// generateWithTools — tool heads-up ("Dame un segundo, reviso la agenda 📅")
// ──────────────────────────────────────────────────────────────────────────────
//
// The generateText mock invokes the real `execute` of the tool it receives, so
// the sendToolHeadsUp bridge is exercised for real instead of only checking
// that the ToolSet was built.

/** Minimal tool from the TOOL_HEADS_UP map; the rest of Tool's fields don't
 * matter because registry.run is mocked and never reads them. */
function fakeTool(name: string): Tool {
  return {
    name,
    description: name,
    sensitivity: "read",
    schema: { safeParse: () => ({ success: true }) } as unknown as ZodSchema,
    enabledFor: () => true,
    run: async () => ({ ok: true, output: null }),
  };
}

function baseParams(overrides: Partial<Parameters<typeof generateWithTools>[0]> = {}) {
  return {
    systemPrompt: "eres un asistente",
    userMessage: "hola",
    workspaceId: "ws_1",
    toolContext: {
      workspaceId: "ws_1",
      conversationId: "conv_1",
      contactId: "contact_1",
    },
    availableTools: [fakeTool("check_availability")],
    ...overrides,
  };
}

test("tool con heads-up y conversationId presente: despacha un mensaje", async () => {
  dispatchCalls = [];
  generateTextImpl = async (opts) => {
    await opts.tools!.check_availability.execute({});
    return { text: "listo", usage: { inputTokens: 1, outputTokens: 1 }, steps: [1] };
  };

  await generateWithTools(baseParams());

  assert.equal(dispatchCalls.length, 1);
  assert.equal(dispatchCalls[0].body, "Dame un segundo, reviso la agenda 📅");
  assert.equal(dispatchCalls[0].conversationId, "conv_1");
});

test("la misma tool llamada dos veces en el mismo turno despacha una sola vez", async () => {
  dispatchCalls = [];
  generateTextImpl = async (opts) => {
    await opts.tools!.check_availability.execute({});
    await opts.tools!.check_availability.execute({});
    return { text: "listo", usage: { inputTokens: 1, outputTokens: 1 }, steps: [1, 2] };
  };

  await generateWithTools(baseParams());

  assert.equal(dispatchCalls.length, 1);
});

test("conversationId null (playground): no despacha nada", async () => {
  dispatchCalls = [];
  generateTextImpl = async (opts) => {
    await opts.tools!.check_availability.execute({});
    return { text: "listo", usage: { inputTokens: 1, outputTokens: 1 }, steps: [1] };
  };

  await generateWithTools(
    baseParams({
      toolContext: { workspaceId: "ws_1", conversationId: null, contactId: null },
    }),
  );

  assert.equal(dispatchCalls.length, 0);
});

test("dispatchText que rechaza no rompe el turno: el resultado de la tool llega igual", async () => {
  dispatchCalls = [];
  dispatchImpl = async () => {
    throw new Error("kapso caído");
  };
  runImpl = async () => ({ ok: true, output: "disponible 10am" });

  let toolResult: unknown;
  generateTextImpl = async (opts) => {
    toolResult = await opts.tools!.check_availability.execute({});
    return { text: "listo", usage: { inputTokens: 1, outputTokens: 1 }, steps: [1] };
  };

  const errores: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errores.push(args);
  let result: Awaited<ReturnType<typeof generateWithTools>>;
  try {
    result = await generateWithTools(baseParams());
  } finally {
    console.error = original;
    dispatchImpl = async (p) => {
      dispatchCalls.push(p);
      return { ok: true };
    };
  }

  assert.equal(result.text, "listo");
  assert.deepEqual(toolResult, { ok: true, output: "disponible 10am" });
  assert.ok(
    errores.some((e) => String(e[0]).includes("tool heads-up failed")),
  );
});

test("una tool fuera del mapa (echo) no dispara aviso", async () => {
  dispatchCalls = [];
  generateTextImpl = async (opts) => {
    await opts.tools!.echo.execute({});
    return { text: "listo", usage: { inputTokens: 1, outputTokens: 1 }, steps: [1] };
  };

  await generateWithTools(
    baseParams({ availableTools: [fakeTool("echo")] }),
  );

  assert.equal(dispatchCalls.length, 0);
});
