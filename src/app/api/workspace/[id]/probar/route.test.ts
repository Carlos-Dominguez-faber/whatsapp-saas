import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { NextRequest, NextResponse } from "next/server";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

const calls: string[] = [];

type Member = { ok: true; userId: string; role: string } | { ok: false; response: NextResponse };
let member: Member = { ok: true, userId: "user_1", role: "viewer" };
const memberChecks: Array<{ workspaceId: string; minRole?: string }> = [];
mock.module("@/lib/auth/workspace-access.ts", {
  exports: {
    requireWorkspaceMember: async (workspaceId: string, opts?: { minRole?: string }) => {
      memberChecks.push({ workspaceId, minRole: opts?.minRole });
      return member;
    },
  },
});

let activeAgent: { id: string } | null = { id: "agent_active" };
mock.module("@/features/agents/services/active-agent.ts", {
  exports: { getActiveAgent: async () => activeAgent },
});

let agentRow: Record<string, unknown> = {
  id: "agent_active",
  workspace_id: "ws_1",
  type: "soporte",
  name: "Sofía",
  model: "anthropic/claude-sonnet-4.6",
  config: {},
};
const agentLookups: unknown[] = [];
const agentChain: any = {
  select: () => agentChain,
  eq: (_c: string, v: unknown) => (agentLookups.push(v), agentChain),
  maybeSingle: async () => ({ data: agentRow, error: null }),
};
mock.module("@supabase/supabase-js", {
  exports: { createClient: () => ({ from: () => agentChain }) },
});

type ToolContextSeen = { playground?: { userId: string } };
const generateOpts: Array<{
  model: string;
  maxOutputTokens: number;
  tools?: Array<{ name: string }>;
  toolContext?: ToolContextSeen;
}> = [];
let generateError: Error | null = null;
mock.module("@/features/inbox/services/openrouter.ts", {
  exports: {
    getWorkspaceModel: async () => "openai/gpt-4.1",
    generateChatReply: async (opts: (typeof generateOpts)[number]) => {
      calls.push("generate");
      generateOpts.push(opts);
      if (generateError) throw generateError;
      return { text: "¡Hola! ¿En qué te ayudo?", promptTokens: 10, completionTokens: 5 };
    },
  },
});
mock.module("@/features/inbox/services/prompt-resolver.ts", {
  exports: { resolveSystemPrompt: async () => ({ body: "Eres Sofía", guardrails: null }) },
});
mock.module("@/features/inbox/services/prompt-builder.ts", { exports: { buildSystemPrompt: () => "SYSTEM" } });
mock.module("@/features/inbox/services/kb-service.ts", {
  exports: {
    searchKb: async () => [],
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
mock.module("@/features/inbox/services/scheduling-timezone.ts", {
  exports: { workspaceSchedulingTimeZone: async () => "America/Mexico_City" },
});
let enabledTools: Array<{ name: string; sensitivity: string }> = [];
mock.module("@/features/tools/services/tool-configs.ts", {
  exports: { getEnabledTools: async () => enabledTools },
});

let guardResult: { ok: true; reservationId?: string } | { ok: false; response: NextResponse } = {
  ok: true,
  reservationId: "res_1",
};
const guardCalls: Array<{ kind: string; args: unknown[] }> = [];
mock.module("@/features/inbox/services/llm-call-guard.ts", {
  exports: {
    guardWorkspaceLlmCall: async (...args: unknown[]) => {
      guardCalls.push({ kind: "workspace", args });
      return guardResult;
    },
    guardClientTestChat: async (...args: unknown[]) => {
      calls.push("guard");
      guardCalls.push({ kind: "client", args });
      return guardResult;
    },
  },
});
const recorded: Array<Record<string, unknown>> = [];
mock.module("@/features/inbox/services/cost-tracker.ts", {
  exports: { recordWorkspaceLlmCall: async (opts: Record<string, unknown>) => void recorded.push(opts) },
});
mock.module("@/features/inbox/services/model-policy.ts", {
  exports: { enforceModelPolicy: async (_db: unknown, _ws: string, model: string) => model },
});

const { POST } = await import("./route.ts");
const params = { params: Promise.resolve({ id: "ws_1" }) };

function post(body: unknown = { messages: [{ role: "user", content: "hola" }] }) {
  return POST(
    new NextRequest("http://localhost/api/workspace/ws_1/probar", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    params,
  );
}

function reset() {
  calls.length = 0;
  generateOpts.length = 0;
  guardCalls.length = 0;
  memberChecks.length = 0;
  recorded.length = 0;
  agentLookups.length = 0;
  enabledTools = [];
  generateError = null;
  guardResult = { ok: true, reservationId: "res_1" };
  member = { ok: true, userId: "user_1", role: "viewer" };
  activeAgent = { id: "agent_active" };
  agentRow = { ...agentRow, model: "anthropic/claude-sonnet-4.6" };
}

const WORKSPACE_TOOLS = [
  { name: "check_availability", sensitivity: "read" },
  { name: "schedule_highlevel", sensitivity: "write" },
  { name: "n8n_crm_write", sensitivity: "write" },
  { name: "n8n_lookup", sensitivity: "read" },
];

test("a viewer may chat, and gets only the agent's text back", async () => {
  reset();
  const res = await post();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { text: "¡Hola! ¿En qué te ayudo?" });
  assert.deepEqual(memberChecks, [{ workspaceId: "ws_1", minRole: "viewer" }]);
});

test("the server talks to the ACTIVE agent, whatever the request says", async () => {
  reset();
  await post({ messages: [{ role: "user", content: "hola" }], agentId: "agent_other" });
  assert.ok(agentLookups.includes("agent_active"));
  assert.ok(!agentLookups.includes("agent_other"));
});

test("only read-only tools run, even for an admin", async () => {
  for (const role of ["viewer", "agent", "manager", "admin"]) {
    reset();
    member = { ok: true, userId: "user_1", role };
    enabledTools = WORKSPACE_TOOLS;
    const res = await post();
    assert.equal(res.status, 200, role);
    assert.deepEqual(generateOpts[0].tools?.map((t) => t.name), ["check_availability", "n8n_lookup"], role);
  }
});

test("each call is reserved per person before the model, and recorded with who ran it", async () => {
  reset();
  await post();
  assert.deepEqual(guardCalls, [{ kind: "client", args: ["ws_1", "user_1"] }]);
  assert.deepEqual(calls, ["guard", "generate"]);
  assert.equal(recorded[0].type, "client_test_chat");
  assert.equal(recorded[0].reservationId, "res_1");
  assert.deepEqual(recorded[0].extra, { agent_id: "agent_active", user_id: "user_1" });
  assert.equal(generateOpts[0].maxOutputTokens, 500);
});

test("a refused reservation answers with its response and never calls the model", async () => {
  reset();
  guardResult = { ok: false, response: NextResponse.json({ error: "límite" }, { status: 429 }) };
  const res = await post();
  assert.equal(res.status, 429);
  assert.ok(!calls.includes("generate"));
});

test("a non-member is turned away before anything runs", async () => {
  reset();
  member = { ok: false, response: NextResponse.json({ error: "Acceso denegado" }, { status: 403 }) };
  const res = await post();
  assert.equal(res.status, 403);
  assert.equal(guardCalls.length, 0);
  assert.ok(!calls.includes("generate"));
});

test("input stays small: 1,000 characters a message, 20 messages", async () => {
  reset();
  assert.equal((await post({ messages: [{ role: "user", content: "x".repeat(1_001) }] })).status, 400);
  const many = Array.from({ length: 21 }, () => ({ role: "user", content: "hola" }));
  assert.equal((await post({ messages: many })).status, 400);
  const heavy = Array.from({ length: 9 }, () => ({ role: "user", content: "x".repeat(1_000) }));
  assert.equal((await post({ messages: heavy })).status, 400);
  assert.equal(guardCalls.length, 0);
});

test("no active agent → 404 with a plain message", async () => {
  reset();
  activeAgent = null;
  const res = await post();
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /agente activo/);
});

test("failures don't leak the model or the provider's error", async () => {
  reset();
  generateError = new Error("upstream 502 from anthropic/claude-sonnet-4.6");
  const res = await post();
  assert.equal(res.status, 502);
  const { error } = await res.json();
  assert.doesNotMatch(error, /claude|anthropic|502/);

  reset();
  agentRow = { ...agentRow, model: "some/unlisted-model" };
  const off = await post();
  assert.equal(off.status, 503);
  assert.doesNotMatch((await off.json()).error, /unlisted/);
});
