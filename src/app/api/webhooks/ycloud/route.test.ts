import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

const statusCalls: Array<{ workspaceId: string; event: Record<string, unknown> }> = [];
mock.module("@/features/inbox/services/message-status.ts", {
  exports: {
    applyMessageStatus: async (
      _db: unknown,
      workspaceId: string,
      event: Record<string, unknown>,
    ) => {
      statusCalls.push({ workspaceId, event });
    },
  },
});
mock.module("@/shared/lib/integration-secrets.ts", {
  exports: { decryptCredentials: async (c: unknown) => c ?? {} },
});
const unused = async () => {
  throw new Error("not expected in this test");
};
mock.module("@/features/inbox/services/normalizer.ts", { exports: { processInbound: unused } });
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

const ROW = {
  workspace_id: "ws_1",
  credentials: { webhook_signing_secret: "yc-secret" },
  config: { phone_number: "+15550000000" },
};
const fakeSvc = {
  from: () => ({
    select: () => {
      const q: any = {
        eq: () => q,
        single: async () => ({ data: ROW, error: null }),
      };
      return q;
    },
  }),
};
mock.module("@supabase/supabase-js", { exports: { createClient: () => fakeSvc } });

const { POST } = await import("./route.ts");

function updated(whatsappMessage: Record<string, unknown>) {
  const body = JSON.stringify({ type: "whatsapp.message.updated", whatsappMessage });
  const t = Math.floor(Date.now() / 1000);
  const s = createHmac("sha256", "yc-secret").update(`${t}.${body}`).digest("hex");
  return POST(
    new NextRequest("http://localhost/api/webhooks/ycloud?wsid=ws_1", {
      method: "POST",
      body,
      headers: { "content-type": "application/json", "YCloud-Signature": `t=${t},s=${s}` },
    }),
  );
}

test("a YCloud status with no wamid yet is applied by YCloud's own id", async () => {
  statusCalls.length = 0;
  const res = await updated({ id: "yc_123", status: "sent" });
  assert.equal(res.status, 200);
  assert.equal(statusCalls.length, 1);
  assert.equal(statusCalls[0].event.providerMessageId, "yc_123");
  assert.equal(statusCalls[0].event.wamid, null);
});

test("a failed YCloud status carries the reason, translated", async () => {
  statusCalls.length = 0;
  await updated({
    id: "yc_123",
    wamid: "wamid.1",
    status: "failed",
    errorCode: "131026",
    errorMessage: "Message undeliverable",
  });
  const error = statusCalls[0].event.error as { code: number; message: string };
  assert.equal(error.code, 131026);
  assert.match(error.message, /no tenga WhatsApp/);
});
