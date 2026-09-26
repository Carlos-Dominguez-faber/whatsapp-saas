import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { NextRequest, NextResponse } from "next/server";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

const calls: string[] = [];
let agentRow: Record<string, unknown> = {
  id: "agent_1",
  workspace_id: "ws_1",
  type: "soporte",
  name: "Sofía",
  model: "anthropic/claude-sonnet-4.6",
  config: {},
};

const membershipChain: any = {
  select: () => membershipChain,
  eq: () => membershipChain,
  maybeSingle: async () => ({ data: { role: "manager" }, error: null }),
};
mock.module("@/lib/supabase/server.ts", {
  exports: {
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: { id: "user_1" } } }) },
      from: () => membershipChain,
    }),
  },
});
const agentChain: any = {
  select: () => agentChain,
  eq: () => agentChain,
  maybeSingle: async () => ({ data: agentRow, error: null }),
};
mock.module("@supabase/supabase-js", {
  exports: { createClient: () => ({ from: () => agentChain }) },
});

const generateModels: string[] = [];
mock.module("@/features/inbox/services/openrouter.ts", {
  exports: {
    getWorkspaceModel: async () => "openai/gpt-4.1",
    generateChatReply: async (opts: { model: string }) => {
      calls.push("generate");
      generateModels.push(opts.model);
      return { text: "¡Hola!", promptTokens: 10, completionTokens: 5 };
    },
  },
});
mock.module("@/features/inbox/services/prompt-resolver.ts", {
  exports: { resolveSystemPrompt: async () => ({ body: "Eres Sofía", guardrails: null }) },
});
mock.module("@/features/inbox/services/prompt-builder.ts", { exports: { buildSystemPrompt: () => "SYSTEM" } });
mock.module("@/features/inbox/services/kb-service.ts", {
  exports: {
    searchKb: async () => {
      calls.push("searchKb");
      return [];
    },
    formatKbContext: () => "",
    listKbSourceLinks: async () => [],
    formatKbReferenceLinks: () => "",
  },
});
mock.module("@/features/inbox/services/business-info.ts", {
  exports: {
    getBusinessInfo: async () => null,
    buildBusinessInfoContext: () => "",
    buildNowContext: () => "",
  },
});
mock.module("@/features/tools/services/tool-configs.ts", { exports: { getEnabledTools: async () => [] } });

let guardResult: { ok: true; reservationId?: string } | { ok: false; response: NextResponse } = {
  ok: true,
  reservationId: "res_1",
};
mock.module("@/features/inbox/services/llm-call-guard.ts", {
  exports: {
    guardWorkspaceLlmCall: async () => {
      calls.push("guard");
      return guardResult;
    },
  },
});
const recorded: Array<Record<string, unknown>> = [];
mock.module("@/features/inbox/services/cost-tracker.ts", {
  exports: { recordWorkspaceLlmCall: async (opts: Record<string, unknown>) => void recorded.push(opts) },
});
let policy = (model: string) => model;
mock.module("@/features/inbox/services/model-policy.ts", {
  exports: {
    enforceModelPolicy: async (_db: unknown, _ws: string, model: string) => {
      calls.push("policy");
      return policy(model);
    },
  },
});

const { POST } = await import("./route.ts");
const params = { params: Promise.resolve({ id: "ws_1", agentId: "agent_1" }) };

function post(body: Record<string, unknown> = {}) {
  return POST(
    new NextRequest("http://localhost/api/workspace/ws_1/agents/agent_1/test-chat", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hola" }], ...body }),
    }),
    params,
  );
}

function reset() {
  calls.length = 0;
  generateModels.length = 0;
  recorded.length = 0;
  guardResult = { ok: true, reservationId: "res_1" };
  policy = (model: string) => model;
  agentRow = { ...agentRow, model: "anthropic/claude-sonnet-4.6" };
}

test("the guard runs after the model policy and before the KB search and the model", async () => {
  reset();
  const res = await post();
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["policy", "guard", "searchKb", "generate"]);
  assert.equal(recorded[0].reservationId, "res_1");
});

test("a refused guard answers with its response before any KB search", async () => {
  reset();
  guardResult = {
    ok: false,
    response: NextResponse.json({ error: "presupuesto diario de IA" }, { status: 429 }),
  };
  const res = await post();
  assert.equal(res.status, 429);
  assert.ok(!calls.includes("searchKb"));
  assert.ok(!calls.includes("generate"));
});

test("an agent whose model left the catalog is refused with a clear message", async () => {
  reset();
  agentRow = { ...agentRow, model: "some/unlisted-model" };
  const res = await post();
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /ya no está en el catálogo/);
  assert.deepEqual(calls, []);
});

test("a model override outside the catalog is refused", async () => {
  reset();
  const res = await post({ modelOverride: "some/unlisted-model" });
  assert.equal(res.status, 400);
  assert.deepEqual(calls, []);
});

test("the playground calls the model the policy resolved (workspace default included)", async () => {
  reset();
  agentRow = { ...agentRow, model: null };
  policy = () => "openai/gpt-4o-mini";
  const res = await post();
  assert.equal(res.status, 200);
  assert.deepEqual(generateModels, ["openai/gpt-4o-mini"]);
  assert.equal(recorded[0].model, "openai/gpt-4o-mini");
});
