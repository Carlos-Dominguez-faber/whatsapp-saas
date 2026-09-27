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
let inboundCalls = 0;
mock.module("@/features/inbox/services/normalizer.ts", {
  exports: {
    processInbound: async () => {
      inboundCalls++;
      return {
        contact: { id: "ct_1" },
        conversation: { id: "conv_1", ai_enabled: true },
        message: { id: "msg_1" },
      };
    },
  },
});
let batchCalls = 0;
mock.module("@/features/inbox/services/cost-tracker.ts", {
  exports: { checkRateLimits: async () => ({ allowed: true }) },
});
mock.module("@/features/inbox/services/buffer.ts", {
  exports: {
    upsertBatch: async () => {
      batchCalls++;
      return "batch_1";
    },
    processNextBatch: unused,
    hasTimeToClaim: () => true,
  },
});
mock.module("@/features/inbox/services/media-handler.ts", {
  exports: { downloadAndStoreMedia: unused, patchMessageMedia: unused },
});
mock.module("@/features/inbox/services/media-understanding.ts", {
  exports: { transcribeAudio: unused, describeImage: unused },
});
const events: Array<{ workspaceId: string; type: string; payload: Record<string, unknown> }> = [];
mock.module("@/features/inbox/services/daily-events.ts", {
  exports: {
    emitEventOncePerDay: async (
      _db: unknown,
      workspaceId: string,
      type: string,
      _level: string,
      payload: Record<string, unknown>,
    ) => {
      events.push({ workspaceId, type, payload });
    },
  },
});
const countryCodeCalls: string[] = [];
mock.module("@/features/inbox/services/country-code.ts", {
  exports: {
    workspaceCountryCode: async (_db: unknown, workspaceId: string) => {
      countryCodeCalls.push(workspaceId);
      return "52";
    },
  },
});
// after() needs a request scope; here it just runs the callback.
const afterTasks: Array<Promise<unknown>> = [];
mock.module("next/server", {
  exports: {
    NextRequest,
    NextResponse: (await import("next/server")).NextResponse,
    after: (task: () => unknown) => {
      afterTasks.push(Promise.resolve().then(task));
    },
  },
});
async function settled() {
  await Promise.all(afterTasks.splice(0));
}

const ROW: { workspace_id: string; credentials: Record<string, unknown>; config: Record<string, unknown> } = {
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

function signedPost(payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
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

function inbound(to: string, message: Record<string, unknown>) {
  return signedPost({
    type: "whatsapp.inbound_message.received",
    whatsappInboundMessage: { wamid: "wamid.in.1", from: "+5215512345678", to, ...message },
  });
}

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

test("a message for another number on this workspace's URL is ignored, not filed here", async () => {
  inboundCalls = 0;
  events.length = 0;
  const res = await inbound("+15559999999", { type: "text", text: { body: "hola" } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ignored, "destination_mismatch");
  assert.equal(inboundCalls, 0);
  await settled();
  assert.deepEqual(
    events.map((e) => [e.workspaceId, e.type]),
    [["ws_1", "inbound_destination_mismatch"]],
    "left as an event for the workspace, not only in the logs",
  );
});

test("a number configured in national format is not enforced: the message is filed, with an event", async () => {
  const original = ROW.config;
  for (const national of ["998 123 4567", "(998) 123-4567", "555-123-4567"]) {
    ROW.config = { phone_number: national };
    inboundCalls = 0;
    events.length = 0;
    const res = await inbound("+15551234567", { type: "reaction", reaction: { emoji: "👍" } });
    assert.equal(res.status, 200, national);
    assert.equal(inboundCalls, 1, `${national}: filed, never lost`);
    await settled();
    assert.equal(events[0]?.type, "inbound_destination_unchecked", national);
  }
  ROW.config = original;
});

test("a phone_number that isn't a string never breaks the webhook", async () => {
  const original = ROW.config;
  for (const odd of [15550000000, { number: "+1555" }, null]) {
    ROW.config = { phone_number: odd };
    inboundCalls = 0;
    const res = await inbound("+15550000000", { type: "reaction", reaction: { emoji: "👍" } });
    assert.equal(res.status, 200, JSON.stringify(odd));
    assert.equal(inboundCalls, 1);
  }
  ROW.config = original;
  await settled();
});

test("the workspace's own number matches even written another way", async () => {
  inboundCalls = 0;
  batchCalls = 0;
  // Configured "+15550000000"; YCloud sends it with separators.
  const res = await inbound("+1 555 000 0000", { type: "reaction", reaction: { emoji: "👍" } });
  assert.equal(inboundCalls, 1);
  assert.equal((await res.json()).reaction, true);
  assert.equal(batchCalls, 0, "a reaction is stored but starts no paid turn");
});

test("a configured 1 998 123 4567 is read as a Mexican mobile: filed, unverified, never enforced as +1", async () => {
  const original = ROW.config;
  ROW.config = { phone_number: "1 998 123 4567" };
  inboundCalls = 0;
  events.length = 0;
  countryCodeCalls.length = 0;
  const res = await inbound("+5219981234567", { type: "reaction", reaction: { emoji: "👍" } });
  assert.equal(res.status, 200);
  assert.equal(inboundCalls, 1);
  await settled();
  assert.equal(events[0]?.type, "inbound_destination_unchecked");
  assert.deepEqual(countryCodeCalls, ["ws_1"], "read with the workspace's code");
  ROW.config = original;
});

test("bare digits with the workspace's code are enforced; a + number never needs the code", async () => {
  const original = ROW.config;
  ROW.config = { phone_number: "5219981234567" };
  inboundCalls = 0;
  const res = await inbound("+5219980000000", { type: "text", text: { body: "hola" } });
  assert.equal((await res.json()).ignored, "destination_mismatch");
  assert.equal(inboundCalls, 0);

  ROW.config = original; // "+15550000000"
  countryCodeCalls.length = 0;
  await inbound("+15550000000", { type: "reaction", reaction: { emoji: "👍" } });
  assert.deepEqual(countryCodeCalls, [], "no business_info read on the common path");
  await settled();
});
