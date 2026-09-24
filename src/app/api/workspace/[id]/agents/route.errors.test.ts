import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { NextRequest } from "next/server";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

const RAW = 'relation "agents" violates constraint agents_pkey';
const AGENT_ID = "11111111-1111-4111-8111-111111111111";

let memberRole: string | null = "admin";
let rpcError: { message: string } | null = null;
let listAgentsImpl: () => Promise<unknown[]> = async () => [{ id: AGENT_ID, name: "Ana" }];

const membershipChain: any = {
  eq: () => membershipChain,
  maybeSingle: async () => ({ data: memberRole ? { role: memberRole } : null, error: null }),
};
const userClient = {
  auth: { getUser: async () => ({ data: { user: { id: "user_1" } } }) },
  from: () => ({ select: () => membershipChain }),
};
mock.module("@/lib/supabase/server.ts", {
  exports: { createClient: async () => userClient },
});
mock.module("@supabase/supabase-js", {
  exports: { createClient: () => ({ rpc: async () => ({ error: rpcError }) }) },
});
mock.module("@/features/agents/services/agent-queries.ts", {
  exports: { listAgents: () => listAgentsImpl() },
});

const { GET, PATCH } = await import("./route.ts");

const params = { params: Promise.resolve({ id: "ws_1" }) };
function patchReq(body: unknown) {
  return new NextRequest("http://localhost/api/workspace/ws_1/agents", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

let errorLogs: unknown[][] = [];
const originalError = console.error;
function reset() {
  memberRole = "admin";
  rpcError = null;
  listAgentsImpl = async () => [{ id: AGENT_ID, name: "Ana" }];
  errorLogs = [];
  console.error = (...args: unknown[]) => {
    errorLogs.push(args);
  };
}
function restore() {
  console.error = originalError;
}

test("GET lists the agents", async () => {
  reset();
  try {
    const res = await GET(new NextRequest("http://localhost/x"), params);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { agents: [{ id: AGENT_ID, name: "Ana" }] });
  } finally {
    restore();
  }
});

test("GET hides the database error from the body and logs it server-side", async () => {
  reset();
  listAgentsImpl = async () => {
    throw new Error(RAW);
  };
  try {
    const res = await GET(new NextRequest("http://localhost/x"), params);
    assert.equal(res.status, 500);
    const body = JSON.stringify(await res.json());
    assert.ok(!body.includes(RAW), `raw error leaked: ${body}`);
    assert.ok(errorLogs.some((a) => a.map(String).join(" ").includes(RAW)));
  } finally {
    restore();
  }
});

test("PATCH setActive returns the fresh agent", async () => {
  reset();
  try {
    const res = await PATCH(patchReq({ agentId: AGENT_ID, setActive: true }), params);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { agent: { id: AGENT_ID, name: "Ana" } });
  } finally {
    restore();
  }
});

test("PATCH rejects an agentId that is not a uuid with 400", async () => {
  reset();
  try {
    const res = await PATCH(patchReq({ agentId: "abc", setActive: true }), params);
    assert.equal(res.status, 400);
  } finally {
    restore();
  }
});

test("PATCH hides the set_active_agent RPC error from the body and logs it", async () => {
  reset();
  rpcError = { message: RAW };
  try {
    const res = await PATCH(patchReq({ agentId: AGENT_ID, setActive: true }), params);
    assert.equal(res.status, 500);
    const body = JSON.stringify(await res.json());
    assert.ok(!body.includes(RAW), `raw error leaked: ${body}`);
    assert.ok(errorLogs.some((a) => a.map(String).join(" ").includes(RAW)));
  } finally {
    restore();
  }
});

test("PATCH hides the reload error from the body and logs it", async () => {
  reset();
  listAgentsImpl = async () => {
    throw new Error(RAW);
  };
  try {
    const res = await PATCH(patchReq({ agentId: AGENT_ID, setActive: true }), params);
    assert.equal(res.status, 500);
    const body = JSON.stringify(await res.json());
    assert.ok(!body.includes(RAW), `raw error leaked: ${body}`);
    assert.ok(errorLogs.some((a) => a.map(String).join(" ").includes(RAW)));
  } finally {
    restore();
  }
});
