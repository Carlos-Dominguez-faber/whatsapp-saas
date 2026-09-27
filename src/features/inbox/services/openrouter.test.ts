import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

// A tool turn runs several steps. `usage` is the LAST step only; `totalUsage`
// sums them all. These fail if token accounting goes back to `usage`.
const LAST_STEP = { inputTokens: 10, outputTokens: 2 };
const ALL_STEPS = { inputTokens: 50, outputTokens: 9 };

type GenerateArgs = { tools?: Record<string, { execute: (a: unknown) => Promise<unknown> }>; abortSignal: AbortSignal };
/** Replaces the model for one test: it may call tools, then answer or throw. */
let generateImpl: ((args: GenerateArgs) => Promise<unknown>) | null = null;
mock.module("ai", {
  exports: {
    generateText: async (args: GenerateArgs) =>
      generateImpl
        ? generateImpl(args)
        : {
            text: "hola",
            usage: LAST_STEP,
            totalUsage: ALL_STEPS,
            steps: [{}, {}, {}],
          },
    tool: (def: unknown) => def,
    zodSchema: (schema: unknown) => schema,
    stepCountIs: (n: number) => n,
    // An error carrying a statusCode stands for the SDK's APICallError.
    APICallError: {
      isInstance: (e: unknown) => typeof (e as { statusCode?: unknown })?.statusCode === "number",
    },
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
type RunOpts = {
  onStart?: (s: unknown) => Promise<void>;
  onExecuted?: (e: unknown) => Promise<void>;
};
let registryRun: (name: string, args: unknown, ctx: unknown, opts: RunOpts) => Promise<unknown> = async () => null;
mock.module("@/features/tools/index.ts", {
  exports: {
    registry: {
      run: (n: string, a: unknown, c: unknown, o: RunOpts) => registryRun(n, a, c, o),
      runTool: (t: { name: string }, a: unknown, c: unknown, o: RunOpts) =>
        registryRun(t.name, a, c, o),
    },
  },
});
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

const bookTool = {
  name: "book",
  description: "books",
  sensitivity: "write",
  schema: {},
  enabledFor: () => true,
  run: async () => ({ ok: true, output: null }),
};
const toolParams = {
  systemPrompt: "s",
  userMessage: "u",
  workspaceId: "ws_1",
  availableTools: [bookTool],
  toolContext: { workspaceId: "ws_1", conversationId: "c", contactId: "k" },
};

test("a start hook that fails keeps the tool from running and aborts the turn with its error", async () => {
  let ran = false;
  registryRun = async (name, _a, _c, opts) => {
    await opts.onStart?.({ callId: "c1", name, sensitivity: "write" });
    ran = true;
    return { ok: true };
  };
  let signalAborted = false;
  generateImpl = async ({ tools, abortSignal }) => {
    await tools!.book.execute({}).catch(() => {});
    signalAborted = abortSignal.aborted;
    throw new Error("the SDK's abort error");
  };
  try {
    await assert.rejects(
      generateWithTools({
        ...toolParams,
        onToolStart: async () => {
          throw new Error("checkpoint not saved");
        },
      } as never),
      /checkpoint not saved/,
    );
  } finally {
    generateImpl = null;
    registryRun = async () => null;
  }
  assert.equal(ran, false);
  assert.equal(signalAborted, true);
});

test("a tool still running when the turn fails is waited for, so its outcome is reported", async () => {
  const reported: unknown[] = [];
  registryRun = async (name, _a, _c, opts) => {
    await opts.onStart?.({ callId: "c1", name, sensitivity: "write" });
    await new Promise((r) => setTimeout(r, 20));
    await opts.onExecuted?.({ callId: "c1", name, sensitivity: "write", ok: true });
    return { ok: true };
  };
  generateImpl = async ({ tools }) => {
    void tools!.book.execute({});
    await new Promise((r) => setTimeout(r, 1));
    throw new Error("The operation was aborted due to timeout");
  };
  try {
    await assert.rejects(
      generateWithTools({
        ...toolParams,
        onToolExecuted: async (e: unknown) => {
          reported.push(e);
        },
      } as never),
      /aborted due to timeout/,
    );
  } finally {
    generateImpl = null;
    registryRun = async () => null;
  }
  assert.equal(reported.length, 1, "reported before generateWithTools rejected");
});

test("a start hook that fails on the last step still fails the turn, even if the model finishes", async () => {
  registryRun = async (name, _a, _c, opts) => {
    await opts.onStart?.({ callId: "c1", name, sensitivity: "write" });
    return { ok: true };
  };
  // The SDK returns normally: the failed tool was the last step's.
  generateImpl = async ({ tools }) => {
    await tools!.book.execute({}).catch(() => {});
    return { text: "Listo, te agendé.", usage: LAST_STEP, totalUsage: ALL_STEPS, steps: [{}] };
  };
  try {
    await assert.rejects(
      generateWithTools({
        ...toolParams,
        onToolStart: async () => {
          throw new Error("checkpoint not saved");
        },
      } as never),
      /checkpoint not saved/,
    );
  } finally {
    generateImpl = null;
    registryRun = async () => null;
  }
});

test("generateWithTools returns every step's tool results with their tool name", async () => {
  generateImpl = async () => ({
    text: "Te paso con una persona.",
    usage: LAST_STEP,
    totalUsage: ALL_STEPS,
    steps: [
      { toolResults: [{ toolName: "check_availability", output: { ok: true, output: [] } }] },
      {
        toolResults: [
          { toolName: "handoff_human", output: { ok: true, output: { handoff: true, reason: "agent_stuck" } } },
        ],
      },
      {},
    ],
  });
  try {
    const r = await generateWithTools({ ...toolParams, availableTools: [] } as never);
    assert.deepEqual(r.toolResults, [
      { toolName: "check_availability", output: { ok: true, output: [] } },
      { toolName: "handoff_human", output: { ok: true, output: { handoff: true, reason: "agent_stuck" } } },
    ]);
  } finally {
    generateImpl = null;
  }
});

test("generateChatReply retries a transient failure, but never after a write tool ran", async () => {
  const transient = Object.assign(new Error("upstream 503"), { statusCode: 503 });
  let attempts = 0;
  let wrote = false;
  generateImpl = async (args) => {
    attempts++;
    if (!wrote) {
      wrote = true;
      await args.tools?.book.execute({});
    }
    throw transient;
  };
  registryRun = async () => ({ ok: true, output: null });
  try {
    await assert.rejects(
      generateChatReply({
        systemPrompt: "s",
        messages: [{ role: "user", content: "u" }],
        workspaceId: "ws_1",
        tools: [bookTool],
        toolContext: { workspaceId: "ws_1", conversationId: "", contactId: "" },
      } as never),
    );
    assert.equal(attempts, 1, "a turn that ran a write tool is not run again");
  } finally {
    generateImpl = null;
    registryRun = async () => null;
  }
});

test("generateChatReply does retry a transient failure when no write ran", async () => {
  const transient = Object.assign(new Error("upstream 503"), { statusCode: 503 });
  let attempts = 0;
  generateImpl = async () => {
    attempts++;
    if (attempts < 2) throw transient;
    return { text: "ok", usage: LAST_STEP, totalUsage: ALL_STEPS, steps: [{}] };
  };
  try {
    const r = await generateChatReply({
      systemPrompt: "s",
      messages: [{ role: "user", content: "u" }],
      workspaceId: "ws_1",
    } as never);
    assert.equal(r.text, "ok");
    assert.equal(attempts, 2);
  } finally {
    generateImpl = null;
  }
});
