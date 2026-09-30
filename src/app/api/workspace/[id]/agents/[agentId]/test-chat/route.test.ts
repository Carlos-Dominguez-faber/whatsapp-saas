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

/** The caller's memberships; the chain honors the filters it's given. */
let memberships: Array<{ workspace_id: string; user_id: string; role: string; is_active: boolean }> = [];
let memberRole = "manager";
function membershipQuery() {
  const filters: Array<[string, unknown]> = [];
  const chain: any = {
    select: () => chain,
    eq: (column: string, value: unknown) => (filters.push([column, value]), chain),
    maybeSingle: async () => ({
      data:
        memberships.find((m) =>
          filters.every(([c, v]) => (m as Record<string, unknown>)[c] === v),
        ) ?? null,
      error: null,
    }),
  };
  return chain;
}
mock.module("@/lib/supabase/server.ts", {
  exports: {
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: { id: "user_1" } } }) },
      from: () => membershipQuery(),
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
type ToolContextSeen = {
  batchId?: string;
  playground?: { userId: string; userMessages: string[] };
};
const generateOpts: Array<{ tools?: Array<{ name: string }>; toolContext?: ToolContextSeen }> = [];
/** Makes the model call fail; `wroteSomething` as generateChatReply marks it. */
let generateError: Error | null = null;
mock.module("@/features/inbox/services/openrouter.ts", {
  exports: {
    getWorkspaceModel: async () => "openai/gpt-4.1",
    generateChatReply: async (opts: {
      model: string;
      tools?: Array<{ name: string }>;
      toolContext?: ToolContextSeen;
    }) => {
      calls.push("generate");
      generateModels.push(opts.model);
      generateOpts.push(opts);
      if (generateError) throw generateError;
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
let enabledTools: Array<{ name: string; sensitivity: string }> = [];
mock.module("@/features/tools/services/tool-configs.ts", {
  exports: { getEnabledTools: async () => enabledTools },
});

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
    guardClientTestChat: async () => {
      calls.push("client-guard");
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
  if (memberships.length === 0) joinAs(memberRole);
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
  generateOpts.length = 0;
  enabledTools = [];
  recorded.length = 0;
  guardResult = { ok: true, reservationId: "res_1" };
  policy = (model: string) => model;
  agentRow = { ...agentRow, model: "anthropic/claude-sonnet-4.6" };
  memberRole = "manager";
  memberships = [];
  generateError = null;
}

/** Makes user_1 an active member of ws_1 with `memberRole` (set it before posting). */
function joinAs(role: string) {
  memberships = [{ workspace_id: "ws_1", user_id: "user_1", role, is_active: true }];
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

const WORKSPACE_TOOLS = [
  { name: "check_availability", sensitivity: "read" },
  { name: "schedule_highlevel", sensitivity: "write" },
  { name: "n8n_crm_write", sensitivity: "write" },
  { name: "n8n_lookup", sensitivity: "read" },
];

test("a manager's playground offers only read-only tools, with a stable idempotency seed", async () => {
  reset();
  enabledTools = WORKSPACE_TOOLS;
  const res = await post();
  assert.equal(res.status, 200);
  assert.deepEqual(
    generateOpts[0].tools?.map((t) => t.name),
    ["check_availability", "n8n_lookup"],
  );
  assert.match(generateOpts[0].toolContext?.batchId ?? "", /^playground:/);
  assert.equal((await res.json()).writeTools, false);
});

test("an admin's playground runs every enabled tool, writes included", async () => {
  reset();
  memberRole = "admin";
  enabledTools = WORKSPACE_TOOLS;
  const res = await post();
  assert.equal(res.status, 200);
  assert.deepEqual(
    generateOpts[0].tools?.map((t) => t.name),
    ["check_availability", "schedule_highlevel", "n8n_crm_write", "n8n_lookup"],
  );
  assert.match(generateOpts[0].toolContext?.batchId ?? "", /^playground:/);
  assert.equal((await res.json()).writeTools, true);
});

test("the role comes from the membership, not from the request", async () => {
  reset();
  enabledTools = WORKSPACE_TOOLS;
  const res = await post({ role: "admin", writeTools: true });
  assert.equal(res.status, 200);
  assert.deepEqual(
    generateOpts[0].tools?.map((t) => t.name),
    ["check_availability", "n8n_lookup"],
  );
});

test("an admin of ANOTHER workspace gets nothing here: the membership is per workspace", async () => {
  reset();
  memberships = [{ workspace_id: "ws_2", user_id: "user_1", role: "admin", is_active: true }];
  const res = await post();
  assert.equal(res.status, 403);
  assert.ok(!calls.includes("generate"));
});

test("an inactive admin membership doesn't count", async () => {
  reset();
  memberships = [{ workspace_id: "ws_1", user_id: "user_1", role: "admin", is_active: false }];
  const res = await post();
  assert.equal(res.status, 403);
});

test("the tools get who is testing and only the user's turns, verbatim", async () => {
  reset();
  memberRole = "admin";
  await post({
    messages: [
      { role: "user", content: "hola" },
      { role: "assistant", content: "¿a qué número?" },
      { role: "user", content: "al +52 998 111 2222" },
    ],
  });
  assert.deepEqual(generateOpts[0].toolContext?.playground, {
    userId: "user_1",
    userMessages: ["hola", "al +52 998 111 2222"],
  });
});

test("a turn that failed after a write says so, distinctly, instead of inviting a retry", async () => {
  reset();
  memberRole = "admin";
  generateError = Object.assign(new Error("upstream 502"), { wroteSomething: true });
  const res = await post();
  assert.equal(res.status, 502);
  const json = await res.json();
  assert.equal(json.wroteSomething, true);
  assert.match(json.error, /se ejecutó una acción/);
  assert.match(json.error, /antes de reintentar/);

  reset();
  generateError = new Error("upstream 502");
  const plain = await (await post()).json();
  assert.equal(plain.wroteSomething, undefined);
  assert.match(plain.error, /No se pudo generar la respuesta/);
});
