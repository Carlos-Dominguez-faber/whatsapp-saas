import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test, mock } from "node:test";
import { NextRequest } from "next/server";

// POST /api/webhooks/kapso — which workspace an event belongs to. Only a
// workspace whose own secret verifies the signature may take it.

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

const statusCalls: Array<{ workspaceId: string; wamid: string }> = [];
mock.module("@/features/inbox/services/message-status.ts", {
  exports: {
    applyMessageStatus: async (_db: unknown, workspaceId: string, wamid: string) => {
      statusCalls.push({ workspaceId, wamid });
    },
  },
});
mock.module("@/shared/lib/integration-secrets.ts", {
  exports: { decryptCredentials: async (c: unknown) => c ?? {} },
});
const unused = async () => {
  throw new Error("not expected in this test");
};
mock.module("@/features/inbox/services/normalizer.ts", {
  exports: { processInbound: unused, processOutboundEcho: unused },
});
mock.module("@/features/inbox/services/cost-tracker.ts", { exports: { checkRateLimits: unused } });
mock.module("@/features/inbox/services/buffer.ts", {
  exports: { upsertBatch: unused, processNextBatch: unused },
});
mock.module("@/features/inbox/services/media-handler.ts", {
  exports: { downloadAndStoreMedia: unused, patchMessageMedia: unused },
});
mock.module("@/features/inbox/services/media-understanding.ts", {
  exports: { transcribeAudio: unused, describeImage: unused },
});

type Row = { workspace_id: string; credentials: Record<string, unknown>; config: Record<string, unknown> };
let rows: Row[] = [];
const fakeSvc = {
  from: () => ({
    select: () => {
      const filters: Array<(r: Row) => boolean> = [];
      const q: any = {
        eq: (col: string, v: unknown) => {
          if (col === "config->>phone_number_id") filters.push((r) => r.config.phone_number_id === v);
          else if (col === "workspace_id") filters.push((r) => r.workspace_id === v);
          return q;
        },
        limit: async () => ({ data: rows.filter((r) => filters.every((f) => f(r))), error: null }),
        maybeSingle: async () => ({ data: rows.find((r) => filters.every((f) => f(r))) ?? null, error: null }),
      };
      return q;
    },
  }),
};
mock.module("@supabase/supabase-js", { exports: { createClient: () => fakeSvc } });

const { POST } = await import("./route.ts");

function delivered(secret: string, query = "") {
  const body = JSON.stringify({ phone_number_id: "pn_1", message: { id: "wamid.1" } });
  return POST(
    new NextRequest(`http://localhost/api/webhooks/kapso${query}`, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "X-Webhook-Event": "whatsapp.message.delivered",
        "X-Webhook-Signature": createHmac("sha256", secret).update(body).digest("hex"),
      },
    }),
  );
}

const OWNER: Row = {
  workspace_id: "ws_owner",
  credentials: { webhook_signing_secret: "owner-secret" },
  config: { phone_number_id: "pn_1" },
};
// Another workspace that typed the same phone_number_id.
const SQUATTER: Row = {
  workspace_id: "ws_squatter",
  credentials: { webhook_signing_secret: "squatter-secret" },
  config: { phone_number_id: "pn_1" },
};

test("without wsid, the event goes to the workspace whose secret verifies", async () => {
  rows = [SQUATTER, OWNER];
  statusCalls.length = 0;
  const res = await delivered("owner-secret");
  assert.equal(res.status, 200);
  assert.deepEqual(statusCalls, [{ workspaceId: "ws_owner", wamid: "wamid.1" }]);
});

test("a workspace squatting a phone_number_id cannot take (or block) the events", async () => {
  rows = [SQUATTER];
  statusCalls.length = 0;
  const res = await delivered("owner-secret");
  assert.equal(res.status, 401);
  assert.equal(statusCalls.length, 0);
});

test("with wsid, only that workspace's secret is accepted", async () => {
  rows = [SQUATTER, OWNER];
  statusCalls.length = 0;
  assert.equal((await delivered("owner-secret", "?wsid=ws_squatter")).status, 401);
  assert.equal((await delivered("owner-secret", "?wsid=ws_owner")).status, 200);
  assert.deepEqual(statusCalls.map((c) => c.workspaceId), ["ws_owner"]);
});
