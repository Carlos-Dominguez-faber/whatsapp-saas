import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { NextRequest } from "next/server";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

let storedModel: string | null = "openai/gpt-4.1";
const updates: unknown[] = [];

const fakeSupabase = {
  auth: { getUser: async () => ({ data: { user: { id: "user_1" } } }) },
  from: () => ({
    select: () => {
      const chain: any = {
        eq: () => chain,
        maybeSingle: async () => ({ data: { model: storedModel }, error: null }),
      };
      return chain;
    },
    update: (row: unknown) => {
      updates.push(row);
      const chain: any = {
        eq: () => chain,
        then: (resolve: (v: unknown) => void) => resolve({ error: null }),
      };
      return chain;
    },
  }),
};
mock.module("@/lib/supabase/server.ts", {
  exports: { createClient: async () => fakeSupabase },
});
mock.module("@/features/agents/services/agent-queries.ts", {
  exports: { listAgents: async () => [{ id: "11111111-1111-4111-8111-111111111111" }] },
});

const { PATCH } = await import("./route.ts");
const params = { params: Promise.resolve({ id: "ws_1" }) };
const AGENT = "11111111-1111-4111-8111-111111111111";

function patch(body: Record<string, unknown>) {
  return PATCH(
    new NextRequest("http://localhost/api/workspace/ws_1/agents", {
      method: "PATCH",
      body: JSON.stringify({ agentId: AGENT, ...body }),
    }),
    params,
  );
}

test("an agent model outside the catalog is refused and nothing is written", async () => {
  updates.length = 0;
  storedModel = "openai/gpt-4.1";
  const res = await patch({ model: "some/unlisted-model" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /catálogo/);
  assert.equal(updates.length, 0);
});

test("a catalog model, or the agent's own older model sent back unchanged, is saved", async () => {
  updates.length = 0;
  const ok = await patch({ model: "anthropic/claude-sonnet-4.6" });
  assert.equal(ok.status, 200);

  storedModel = "legacy/model-x";
  const unchanged = await patch({ model: "legacy/model-x", name: "Sofía" });
  assert.equal(unchanged.status, 200);
  assert.equal(updates.length, 2);
});
