import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

interface QueueEntry {
  data?: unknown;
  error?: unknown;
}

let responseQueue: QueueEntry[] = [];
let inserts: Array<{ table: string; row: unknown }> = [];
let updates: Array<{ table: string; row: unknown }> = [];
let upserts: Array<{ table: string; row: unknown }> = [];

function nextResponse(): QueueEntry {
  return responseQueue.shift() ?? { data: null, error: null };
}

function makeSelectChain() {
  const chain: any = {
    eq() {
      return chain;
    },
    single() {
      return Promise.resolve(nextResponse());
    },
    maybeSingle() {
      return Promise.resolve(nextResponse());
    },
  };
  return chain;
}

const fakeClient = {
  from(table: string) {
    return {
      select() {
        return makeSelectChain();
      },
      insert(row: unknown) {
        inserts.push({ table, row });
        return {
          select() {
            return { maybeSingle: () => Promise.resolve(nextResponse()) };
          },
          then(resolve: (v: QueueEntry) => void) {
            resolve(nextResponse());
          },
        };
      },
      update(row: unknown) {
        return {
          eq() {
            updates.push({ table, row });
            return Promise.resolve(nextResponse());
          },
        };
      },
      upsert(row: unknown) {
        upserts.push({ table, row });
        return Promise.resolve(nextResponse());
      },
    };
  },
};

mock.module("@supabase/supabase-js", {
  exports: { createClient: () => fakeClient },
});

class FakeKapsoError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
    this.name = "KapsoError";
  }
}

let sendTextImpl: (...args: unknown[]) => Promise<{ wamid: string }> = async () => ({
  wamid: "wamid_1",
});
let sendTemplateImpl: (...args: unknown[]) => Promise<{ wamid: string }> = async () => ({
  wamid: "wamid_1",
});
mock.module("./kapso-client.ts", {
  exports: {
    KapsoError: FakeKapsoError,
    sendText: (...args: unknown[]) => sendTextImpl(...args),
    sendTemplate: (...args: unknown[]) => sendTemplateImpl(...args),
  },
});

const { dispatchText, dispatchTemplate } = await import("./dispatch.ts");

function reset() {
  responseQueue = [];
  inserts = [];
  updates = [];
  upserts = [];
  sendTextImpl = async () => ({ wamid: "wamid_1" });
  sendTemplateImpl = async () => ({ wamid: "wamid_1" });
}

const REAL_INTEGRATION = {
  credentials: { kapso_api_key: "real_key" },
  config: { phone_number_id: "pn_1" },
};
const NOT_EXPIRED = new Date(Date.now() + 3_600_000).toISOString();
const EXPIRED = new Date(Date.now() - 3_600_000).toISOString();

// ── dispatchText ─────────────────────────────────────────────────────────

test("dispatchText sends via Kapso, persists 'sent', and refreshes last_message_at", async () => {
  reset();
  responseQueue = [
    { data: { window_expires_at: NOT_EXPIRED, contact_id: "contact_1" }, error: null }, // conversations (window)
    { data: { phone: "+15550000001", opt_in: true }, error: null }, // contacts (phone + opt_in)
    { data: REAL_INTEGRATION, error: null }, // integrations
    { error: null }, // messages insert (final persist)
    { error: null }, // conversations update (last_message_at)
  ];
  const result = await dispatchText({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    body: "hola **mundo**",
  });
  assert.deepEqual(result, { ok: true, wamid: "wamid_1" });
  const messageInsert = inserts.find((i) => i.table === "messages");
  assert.equal((messageInsert!.row as { status: string }).status, "sent");
  assert.equal((messageInsert!.row as { body: string }).body, "hola *mundo*");
  assert.equal(updates.length, 1);
});

test("dispatchText persists 'queued' without calling Kapso when the API key is the dev placeholder", async () => {
  reset();
  responseQueue = [
    { data: { window_expires_at: NOT_EXPIRED, contact_id: "contact_1" }, error: null },
    { data: { phone: "+15550000001", opt_in: true }, error: null },
    { data: { credentials: { kapso_api_key: "placeholder" }, config: {} }, error: null },
    { error: null },
    { error: null },
  ];
  let sendTextCalled = false;
  sendTextImpl = async () => {
    sendTextCalled = true;
    return { wamid: "wamid_1" };
  };
  const result = await dispatchText({ workspaceId: "ws_1", conversationId: "conv_1", body: "hola" });
  assert.equal(result.ok, true);
  assert.equal(sendTextCalled, false);
  const messageInsert = inserts.find((i) => i.table === "messages");
  assert.equal((messageInsert!.row as { status: string }).status, "queued");
});

test("dispatchText blocks with OPT_OUT before loading integration credentials when the contact opted out", async () => {
  reset();
  responseQueue = [
    { data: { window_expires_at: NOT_EXPIRED, contact_id: "contact_1" }, error: null },
    { data: { phone: "+15550000001", opt_in: false }, error: null },
  ];
  const result = await dispatchText({ workspaceId: "ws_1", conversationId: "conv_1", body: "hola" });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "OPT_OUT");
  assert.equal(inserts.length, 0);
});

test("dispatchText returns WINDOW_EXPIRED when the 24h window elapsed and there is no admin override", async () => {
  reset();
  responseQueue = [
    { data: { window_expires_at: EXPIRED, contact_id: "contact_1" }, error: null },
    { data: { phone: "+15550000001", opt_in: true }, error: null },
  ];
  const result = await dispatchText({ workspaceId: "ws_1", conversationId: "conv_1", body: "hola" });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "WINDOW_EXPIRED");
});

test("dispatchText's overrideAdmin bypasses an expired window", async () => {
  reset();
  responseQueue = [
    { data: { window_expires_at: EXPIRED, contact_id: "contact_1" }, error: null },
    { data: { phone: "+15550000001", opt_in: true }, error: null },
    { data: REAL_INTEGRATION, error: null },
    { error: null },
    { error: null },
  ];
  const result = await dispatchText({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    body: "hola",
    overrideAdmin: true,
  });
  assert.equal(result.ok, true);
});

test("dispatchText maps a KapsoError to a WhatsAppError, persists the failed message, and records message_errors", async () => {
  reset();
  responseQueue = [
    { data: { window_expires_at: NOT_EXPIRED, contact_id: "contact_1" }, error: null },
    { data: { phone: "+15550000001", opt_in: true }, error: null },
    { data: REAL_INTEGRATION, error: null },
    { data: { id: "msg_failed_1" }, error: null }, // failed-message insert .select("id").maybeSingle()
  ];
  // No `code` field → falls through the CATALOG to fromHttpStatus(400); traced
  // against whatsapp-errors.ts's unwrap()/parseWhatsAppError() (only `message`
  // feeds `detail`, `error_user_msg` is never read by any code path).
  sendTextImpl = async () => {
    throw new FakeKapsoError(400, { error: { message: "x" } }, "x");
  };
  const result = await dispatchText({ workspaceId: "ws_1", conversationId: "conv_1", body: "hola" });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "SEND_FAILED");
  assert.equal(
    result.error,
    "WhatsApp rechazó el mensaje. Revisa el contenido y el número de destino.",
  );
  const failedInsert = inserts.find((i) => i.table === "messages");
  assert.equal((failedInsert!.row as { status: string }).status, "failed");
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].table, "message_errors");
  const errorRow = upserts[0].row as {
    message_id: string;
    code: number | null;
    detail: string | null;
    source: string;
    http_status: number | null;
  };
  assert.equal(errorRow.message_id, "msg_failed_1");
  assert.equal(errorRow.code, null);
  assert.equal(errorRow.detail, "x");
  assert.equal(errorRow.source, "response");
  assert.equal(errorRow.http_status, 400);
  // 400 sale del catálogo como permanente: el buffer no debe reencolar.
  assert.equal(result.retryable, false);
});

test("dispatchText marks a network-level send failure (not a KapsoError) as retryable", async () => {
  reset();
  responseQueue = [
    { data: { window_expires_at: NOT_EXPIRED, contact_id: "contact_1" }, error: null },
    { data: { phone: "+15550000001", opt_in: true }, error: null },
    { data: REAL_INTEGRATION, error: null },
    { data: { id: "msg_failed_net" }, error: null },
  ];
  // Kapso caído del todo: fetch revienta antes de que haya respuesta HTTP, así
  // que el error NO es KapsoError y no hay status que consultar en el catálogo.
  sendTextImpl = async () => {
    throw new TypeError("fetch failed");
  };
  const result = await dispatchText({ workspaceId: "ws_1", conversationId: "conv_1", body: "hola" });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "SEND_FAILED");
  assert.equal(result.retryable, true);
});

test("dispatchText returns DB_ERROR when the final message insert fails after a successful send", async () => {
  reset();
  responseQueue = [
    { data: { window_expires_at: NOT_EXPIRED, contact_id: "contact_1" }, error: null },
    { data: { phone: "+15550000001", opt_in: true }, error: null },
    { data: REAL_INTEGRATION, error: null },
    { error: { message: "constraint violation" } }, // final messages insert fails
  ];
  const result = await dispatchText({ workspaceId: "ws_1", conversationId: "conv_1", body: "hola" });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "DB_ERROR");
});

// ── dispatchTemplate ─────────────────────────────────────────────────────

test("dispatchTemplate sends the template, bypassing the 24h window entirely", async () => {
  reset();
  responseQueue = [
    { data: { window_expires_at: EXPIRED, contact_id: "contact_1" }, error: null }, // window ignored for templates
    { data: { phone: "+15550000001", opt_in: true }, error: null },
    { data: REAL_INTEGRATION, error: null },
    { error: null },
    { error: null },
  ];
  const result = await dispatchTemplate({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    templateName: "confirmacion",
  });
  assert.equal(result.ok, true);
  const templateInsert = inserts.find((i) => i.table === "messages");
  assert.equal((templateInsert!.row as { type: string }).type, "template");
});

test("dispatchTemplate blocks with OPT_OUT for an opted-out contact", async () => {
  reset();
  responseQueue = [
    { data: { window_expires_at: NOT_EXPIRED, contact_id: "contact_1" }, error: null },
    { data: { phone: "+15550000001", opt_in: false }, error: null },
  ];
  const result = await dispatchTemplate({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    templateName: "confirmacion",
  });
  assert.equal(result.errorCode, "OPT_OUT");
});

test("dispatchTemplate records message_errors on a send failure, same as dispatchText", async () => {
  reset();
  responseQueue = [
    { data: { window_expires_at: NOT_EXPIRED, contact_id: "contact_1" }, error: null },
    { data: { phone: "+15550000001", opt_in: true }, error: null },
    { data: REAL_INTEGRATION, error: null },
    { data: { id: "msg_failed_2" }, error: null },
  ];
  // Empty body → no code, no detail candidate → fromHttpStatus(500).
  sendTemplateImpl = async () => {
    throw new FakeKapsoError(500, {}, "x");
  };
  const result = await dispatchTemplate({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    templateName: "confirmacion",
  });
  assert.equal(result.errorCode, "SEND_FAILED");
  assert.equal(
    result.error,
    "WhatsApp no está disponible en este momento. Vuelve a intentar en unos minutos.",
  );
  assert.equal(upserts.length, 1);
  const errorRow = upserts[0].row as {
    message_id: string;
    code: number | null;
    detail: string | null;
    source: string;
    http_status: number | null;
  };
  assert.equal(errorRow.message_id, "msg_failed_2");
  assert.equal(errorRow.code, null);
  assert.equal(errorRow.detail, null);
  assert.equal(errorRow.source, "unknown");
  assert.equal(errorRow.http_status, 500);
});
