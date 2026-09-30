import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

// ── In-memory tables: two tenants on DIFFERENT WhatsApp providers ────────────
// ws_a talks through YCloud, ws_b through Kapso; ws_b also keeps a disabled
// YCloud row from before it switched, which must never be used.
type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {
  conversations: [
    { id: "conv_a", workspace_id: "ws_a", contact_id: "ct_a", window_expires_at: null },
    { id: "conv_b", workspace_id: "ws_b", contact_id: "ct_b", window_expires_at: null },
  ],
  contacts: [
    { id: "ct_a", workspace_id: "ws_a", phone: "+15550000001", opt_in: true },
    { id: "ct_b", workspace_id: "ws_b", phone: "+15550000002", opt_in: true },
  ],
  integrations: [
    {
      id: "int_a",
      workspace_id: "ws_a",
      provider: "ycloud",
      enabled: true,
      credentials: { ycloud_api_key: "yc-key-a" },
      config: { phone_number: "+15559999999" },
    },
    {
      id: "int_b_old",
      workspace_id: "ws_b",
      provider: "ycloud",
      enabled: false,
      credentials: { ycloud_api_key: "yc-key-b-old" },
      config: { phone_number: "+15558888888" },
    },
    {
      id: "int_b",
      workspace_id: "ws_b",
      provider: "kapso",
      enabled: true,
      credentials: { kapso_api_key: "kp-key-b" },
      config: { phone_number_id: "pn_b" },
    },
  ],
};

let upserted: Array<{ table: string; row: Row }> = [];
tables.messages = [];
tables.events = [];
tables.contact_opt_outs = [];
/** The messages table as dispatch left it. */
const msgs = () => tables.messages;

/** The next N UPDATEs fail. */
let failUpdates = 0;
/** Reads of these tables fail like a dropped connection. */
const failReads = new Set<string>();

// A PostgREST-ish fake that honors eq() on reads, updates and deletes, so a
// write scoped to the wrong row or workspace misses, as it would for real.
function query(table: string, mode: "select" | "update" | "delete" = "select", patch?: Row) {
  const filters: Array<(r: Row) => boolean> = [];
  const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const builder: any = {
    select: () => builder,
    eq(column: string, value: unknown) {
      filters.push((r) => r[column] === value);
      return builder;
    },
    in(column: string, values: unknown[]) {
      filters.push((r) => values.includes(r[column]));
      return builder;
    },
    single: async () => {
      const r = rows();
      return r.length === 1
        ? { data: r[0], error: null }
        : { data: null, error: { message: "JSON object requested, multiple (or no) rows returned" } };
    },
    limit: async (n: number) =>
      failReads.has(table)
        ? { data: null, error: { message: "connection refused" } }
        : { data: rows().slice(0, n), error: null },
    maybeSingle: async () => {
      if (failReads.has(table)) return { data: null, error: { message: "connection refused" } };
      const r = rows();
      return r.length > 1
        ? { data: null, error: { message: "multiple rows" } }
        : { data: r[0] ?? null, error: null };
    },
    then(resolve: (v: unknown) => void) {
      if (mode === "update") {
        if (failUpdates > 0) {
          failUpdates--;
          resolve({ error: { message: "update failed" } });
          return;
        }
        rows().forEach((r) => Object.assign(r, patch));
        resolve({ error: null });
      } else if (mode === "delete") {
        const hit = new Set(rows());
        tables[table] = tables[table].filter((r) => !hit.has(r));
        resolve({ error: null });
      } else {
        resolve({ data: rows(), error: null });
      }
    },
  };
  return builder;
}

const fakeClient = {
  from(table: string) {
    return {
      select: () => query(table),
      insert(row: Row) {
        const stored = { id: `row_${(tables[table] ?? []).length + 1}`, ...row };
        (tables[table] ??= []).push(stored);
        const done = { data: stored, error: null };
        return {
          select: () => ({ single: async () => done, maybeSingle: async () => done }),
          then: (resolve: (v: unknown) => void) => resolve({ error: null }),
        };
      },
      upsert(row: Row) {
        upserted.push({ table, row });
        return Promise.resolve({ error: null });
      },
      update: (patch: Row) => query(table, "update", patch),
      delete: () => query(table, "delete"),
    };
  },
};

mock.module("@supabase/supabase-js", {
  exports: { createClient: () => fakeClient },
});

mock.module("@/shared/lib/integration-secrets.ts", {
  exports: { decryptCredentials: async (creds: Row) => creds ?? {} },
});

let sends: Array<Record<string, unknown>> = [];
// Set to make the next YCloud send fail the way the API does.
let ycloudFailure: { status: number; body: unknown } | null = null;
/** Runs inside the YCloud send, before it returns. */
let sendHook: (() => void) | null = null;
class FakeYCloudError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(`YCloud API error ${status}`);
    this.status = status;
    this.body = body;
  }
}
mock.module("./ycloud-client.ts", {
  exports: {
    YCloudError: FakeYCloudError,
    sendText: async (p: Record<string, unknown>) => {
      sends.push({ provider: "ycloud", kind: "text", ...p });
      sendHook?.();
      if (ycloudFailure) throw new FakeYCloudError(ycloudFailure.status, ycloudFailure.body);
      return { id: "yc_text", wamid: "wamid_text" };
    },
    sendTemplate: async (p: Record<string, unknown>) => {
      sends.push({ provider: "ycloud", kind: "template", ...p });
      return { id: "yc_tpl", wamid: "wamid_tpl" };
    },
  },
});
mock.module("./kapso-client.ts", {
  exports: {
    KapsoError: class KapsoError extends Error {},
    sendText: async (p: Record<string, unknown>) => {
      sends.push({ provider: "kapso", kind: "text", ...p });
      return { id: "kp_text", wamid: "wamid_k_text" };
    },
    sendTemplate: async (p: Record<string, unknown>) => {
      sends.push({ provider: "kapso", kind: "template", ...p });
      return { id: "kp_tpl", wamid: "wamid_k_tpl" };
    },
  },
});

const { dispatchText, dispatchTemplate, prepareTemplateDispatch, sendPreparedTemplate } =
  await import("./dispatch.ts");

function reset() {
  tables.messages = [];
  tables.events = [];
  upserted = [];
  sends = [];
  ycloudFailure = null;
  failReads.clear();
  tables.contact_opt_outs = [];
  (tables.contacts[0] as Row).opt_in = true;
}

test("a YCloud workspace sends through YCloud, from its E.164 number", async () => {
  reset();
  const res = await dispatchText({ workspaceId: "ws_a", conversationId: "conv_a", body: "hola" });
  assert.equal(res.ok, true);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].provider, "ycloud");
  assert.equal(sends[0].from, "+15559999999");
  assert.equal(sends[0].apiKey, "yc-key-a");
  assert.equal(sends[0].to, "+15550000001");
  assert.equal(msgs()[0].status, "sent");
  assert.equal((msgs()[0].meta as Row).ycloud_id, "yc_text");
});

test("a Kapso workspace sends through Kapso with its phone_number_id, never its old YCloud row", async () => {
  reset();
  const res = await dispatchText({ workspaceId: "ws_b", conversationId: "conv_b", body: "hola" });
  assert.equal(res.ok, true);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].provider, "kapso");
  assert.equal(sends[0].phoneNumberId, "pn_b");
  assert.equal(sends[0].apiKey, "kp-key-b");
  assert.equal(msgs()[0].wamid, "wamid_k_text");
  assert.equal((msgs()[0].meta as Row).ycloud_id, undefined);
});

test("templates follow the workspace's provider too", async () => {
  reset();
  await dispatchTemplate({ workspaceId: "ws_a", conversationId: "conv_a", templateName: "welcome" });
  await dispatchTemplate({ workspaceId: "ws_b", conversationId: "conv_b", templateName: "welcome" });
  assert.deepEqual(
    sends.map((s) => [s.provider, s.kind]),
    [
      ["ycloud", "template"],
      ["kapso", "template"],
    ],
  );
  assert.deepEqual(
    msgs().map((m) => m.workspace_id),
    ["ws_a", "ws_b"],
  );
});

test("a conversation from another workspace is not sent nor persisted", async () => {
  reset();
  const text = await dispatchText({ workspaceId: "ws_a", conversationId: "conv_b", body: "hola" });
  const tpl = await dispatchTemplate({ workspaceId: "ws_a", conversationId: "conv_b", templateName: "welcome" });
  assert.equal(text.errorCode, "NOT_FOUND");
  assert.equal(tpl.errorCode, "NOT_FOUND");
  assert.equal(sends.length, 0);
  assert.equal(msgs().length, 0);
});

test("an opted-out contact still gets replies in the open window, never a template", async () => {
  reset();
  (tables.contacts[0] as Row).opt_in = false;
  const reply = await dispatchText({ workspaceId: "ws_a", conversationId: "conv_a", body: "hola" });
  assert.equal(reply.ok, true, "STOP stops proactive messages, not the replies they asked for");
  assert.equal(sends.length, 1);

  const tpl = await dispatchTemplate({ workspaceId: "ws_a", conversationId: "conv_a", templateName: "welcome" });
  assert.equal(tpl.ok, false);
  assert.equal(tpl.errorCode, "OPT_OUT");
  assert.match(tpl.error ?? "", /no recibir mensajes automáticos ni plantillas/);
  assert.equal(sends.length, 1, "the template never left");
});

test("a workspace without an active WhatsApp provider fails loudly", async () => {
  reset();
  tables.conversations.push({ id: "conv_c", workspace_id: "ws_c", contact_id: "ct_c", window_expires_at: null });
  tables.contacts.push({ id: "ct_c", workspace_id: "ws_c", phone: "+15550000003", opt_in: true });
  await assert.rejects(
    () => dispatchText({ workspaceId: "ws_c", conversationId: "conv_c", body: "hola" }),
    /WhatsApp integration not found/,
  );
  assert.equal(sends.length, 0);
});

test("a YCloud template keeps YCloud's id and is stored as sent", async () => {
  reset();
  await dispatchTemplate({ workspaceId: "ws_a", conversationId: "conv_a", templateName: "welcome" });
  assert.equal(msgs()[0].status, "sent");
  assert.equal((msgs()[0].meta as Row).ycloud_id, "yc_tpl");
});

test("a failed send stores the reason in Spanish and the detail in message_errors only", async () => {
  reset();
  ycloudFailure = {
    status: 400,
    body: {
      error: {
        code: "WHATSAPP_ERROR",
        whatsappApiError: {
          code: 131026,
          message: "Message undeliverable",
          fbtrace_id: "trace_1",
        },
      },
    },
  };
  const res = await dispatchText({ workspaceId: "ws_a", conversationId: "conv_a", body: "hola" });
  assert.equal(res.ok, false);
  assert.equal(res.errorCode, "SEND_FAILED");
  assert.equal(res.retryable, false);
  const failed = msgs()[0];
  assert.equal(failed.status, "failed");
  assert.match(String(failed.error_message), /no tenga WhatsApp/);
  // Nothing technical in the row the browser reads.
  assert.ok(!JSON.stringify(failed).includes("trace_1"));
  assert.ok(!JSON.stringify(failed).includes("undeliverable"));
  const detail = upserted.find((u) => u.table === "message_errors")?.row as Row;
  assert.equal(detail.code, 131026);
  assert.equal(detail.fbtrace_id, "trace_1");
});

test("a send WhatsApp did not accept is retryable, and the buffer can skip the failed row", async () => {
  reset();
  ycloudFailure = { status: 429, body: { error: { whatsappApiError: { code: 130429 } } } };
  const res = await dispatchText({
    workspaceId: "ws_a",
    conversationId: "conv_a",
    body: "hola",
    recordRetryableFailure: false,
    meta: { batch_id: "b_1" },
  });
  assert.equal(res.retryable, true);
  // Never deleted (open inboxes don't hear deletes): marked for the retry to skip.
  assert.equal(msgs().length, 1);
  assert.equal(msgs()[0].status, "failed");
  const meta = msgs()[0].meta as Row;
  assert.equal(meta.not_accepted, true);
  assert.equal(meta.batch_id, "b_1", "the row keeps its meta");
  assert.match(String(msgs()[0].error_message), /vuelve a intentar/);
  assert.equal(upserted.length, 0, "not a final failure: no message_errors row");

  reset();
  ycloudFailure = { status: 429, body: { error: { whatsappApiError: { code: 130429 } } } };
  await dispatchText({ workspaceId: "ws_a", conversationId: "conv_a", body: "hola" });
  assert.equal(msgs().length, 1, "by default the failure is recorded");
  assert.equal(msgs()[0].status, "failed");
});

test("a not-accepted row that can't be marked is retried, then deleted — never left 'queued'", async () => {
  const original = console.error;
  console.error = () => {};
  try {
    reset();
    failUpdates = 1;
    ycloudFailure = { status: 429, body: { error: { whatsappApiError: { code: 130429 } } } };
    await dispatchText({ workspaceId: "ws_a", conversationId: "conv_a", body: "hola", recordRetryableFailure: false });
    assert.equal(msgs()[0]?.status, "failed", "the second attempt marks it");

    reset();
    failUpdates = 2;
    ycloudFailure = { status: 429, body: { error: { whatsappApiError: { code: 130429 } } } };
    await dispatchText({ workspaceId: "ws_a", conversationId: "conv_a", body: "hola", recordRetryableFailure: false });
    assert.equal(msgs().length, 0, "a row still 'queued' would block the retry: deleted");
  } finally {
    console.error = original;
    failUpdates = 0;
  }
});

test("a network error may have delivered the message, so it is never retryable", async () => {
  reset();
  ycloudFailure = { status: 503, body: null };
  const res = await dispatchText({ workspaceId: "ws_a", conversationId: "conv_a", body: "hola" });
  assert.equal(res.retryable, false);
  assert.equal(msgs().length, 1);
  assert.match(String(msgs()[0].error_message), /es posible que el mensaje sí haya llegado/);
});

test("the row is queued before the send, so a failure after it still has a row", async () => {
  reset();
  let rowsAtSend = -1;
  let statusAtSend: unknown = null;
  const originalFailure = ycloudFailure;
  ycloudFailure = null;
  sendHook = () => {
    rowsAtSend = msgs().length;
    statusAtSend = msgs()[0]?.status;
  };
  await dispatchText({ workspaceId: "ws_a", conversationId: "conv_a", body: "hola" });
  sendHook = null;
  ycloudFailure = originalFailure;
  assert.equal(rowsAtSend, 1, "the queued row exists when the provider is called");
  assert.equal(statusAtSend, "queued", "and it is queued, not already 'sent'");
  assert.equal(msgs()[0].status, "sent");
});

test("extra meta (the buffer's batch id) lands on the outbound row", async () => {
  reset();
  await dispatchText({
    workspaceId: "ws_a",
    conversationId: "conv_a",
    body: "hola",
    meta: { batch_id: "batch_9" },
  });
  assert.equal((msgs()[0].meta as Row).batch_id, "batch_9");
});

test("a blocked AI reply leaves an internal note with its text; a person's send doesn't", async () => {
  const closeWindow = () =>
    ((tables.conversations[0] as Row).window_expires_at = "2020-01-01T00:00:00Z");
  reset();
  closeWindow();
  await dispatchText({ workspaceId: "ws_a", conversationId: "conv_a", body: "tu cita", noteWhenBlocked: true });
  assert.equal(sends.length, 0);
  assert.equal(msgs().length, 1);
  assert.equal(msgs()[0].type, "system");
  assert.equal((msgs()[0].meta as Row).internal, true);
  assert.match(String(msgs()[0].body), /tu cita/);

  reset();
  closeWindow();
  await dispatchText({ workspaceId: "ws_a", conversationId: "conv_a", body: "hola" });
  (tables.conversations[0] as Row).window_expires_at = null;
  assert.equal(msgs().length, 0);
});

test("a reply outside the 24h window is noted, never sent", async () => {
  reset();
  (tables.conversations[0] as Row).window_expires_at = "2020-01-01T00:00:00Z";
  const res = await dispatchText({ workspaceId: "ws_a", conversationId: "conv_a", body: "hola", noteWhenBlocked: true });
  (tables.conversations[0] as Row).window_expires_at = null;
  assert.equal(res.errorCode, "WINDOW_EXPIRED");
  assert.equal(sends.length, 0);
  assert.equal((msgs()[0].meta as Row).reason, "send_blocked");
});

test("a conversation the send can't find is logged for the workspace", async () => {
  reset();
  await dispatchText({ workspaceId: "ws_a", conversationId: "conv_b", body: "hola", noteWhenBlocked: true });
  assert.equal(msgs().length, 0);
  assert.equal(tables.events[0]?.type, "outbound_not_sent");
});

// ── prepare / send split (the automation engine marks its run in between) ────

test("preparing a template reads everything and neither writes nor sends", async () => {
  reset();
  const prep = await prepareTemplateDispatch({
    workspaceId: "ws_b",
    conversationId: "conv_b",
    templateName: "recordatorio",
    templateLanguage: "es_MX",
  });
  assert.equal(prep.ok, true);
  if (!prep.ok) return;
  assert.equal(prep.prepared.toPhone, "+15550000002");
  assert.equal(prep.prepared.sender.live, true);
  assert.equal(sends.length, 0);
  assert.equal(msgs().length, 0);
});

test("sending a prepared template queues the row with its meta, then sends in its language", async () => {
  reset();
  const prep = await prepareTemplateDispatch({
    workspaceId: "ws_b",
    conversationId: "conv_b",
    templateName: "recordatorio",
    templateLanguage: "es_MX",
    meta: { automation_rule_id: "rule_1", automation_run_id: "run_1" },
  });
  assert.equal(prep.ok, true);
  if (!prep.ok) return;
  const res = await sendPreparedTemplate(prep.prepared);
  assert.equal(res.ok, true);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].provider, "kapso");
  assert.equal(sends[0].language, "es_MX");
  const row = msgs()[0];
  assert.equal(row.workspace_id, "ws_b");
  assert.equal(row.type, "template");
  assert.equal((row.meta as Row).automation_run_id, "run_1");
  assert.equal((row.meta as Row).template_language, "es_MX");
});

test("preparing refuses another workspace's conversation and an opted-out contact, for good", async () => {
  reset();
  const other = await prepareTemplateDispatch({
    workspaceId: "ws_a",
    conversationId: "conv_b",
    templateName: "welcome",
  });
  assert.deepEqual(other.ok ? null : [other.errorCode, other.retryable], ["NOT_FOUND", false]);

  (tables.contacts[0] as Row).opt_in = false;
  const optedOut = await prepareTemplateDispatch({
    workspaceId: "ws_a",
    conversationId: "conv_a",
    templateName: "welcome",
  });
  assert.deepEqual(optedOut.ok ? null : [optedOut.errorCode, optedOut.retryable], ["OPT_OUT", false]);
  assert.equal(sends.length, 0);
  assert.equal(msgs().length, 0);
});

test("a failed read of the integration is retryable, not a missing integration", async () => {
  reset();
  failReads.add("integrations");
  const prep = await prepareTemplateDispatch({
    workspaceId: "ws_a",
    conversationId: "conv_a",
    templateName: "welcome",
  });
  assert.deepEqual(prep.ok ? null : [prep.errorCode, prep.retryable], ["DB_ERROR", true]);
});

test("an unattended sender refuses development mode; an interactive send accepts it", async () => {
  reset();
  const live = tables.integrations[0].credentials;
  tables.integrations[0].credentials = { ycloud_api_key: "placeholder" };
  try {
    const unattended = await prepareTemplateDispatch({
      workspaceId: "ws_a",
      conversationId: "conv_a",
      templateName: "welcome",
    });
    assert.deepEqual(unattended.ok ? null : [unattended.errorCode, unattended.retryable], [
      "CONFIG_ERROR",
      false,
    ]);
    const interactive = await dispatchTemplate({
      workspaceId: "ws_a",
      conversationId: "conv_a",
      templateName: "welcome",
    });
    assert.equal(interactive.ok, true);
    assert.equal(sends.length, 0, "development mode records the row and sends nothing");
  } finally {
    tables.integrations[0].credentials = live;
  }
});

test("a phone that opted out is refused a template even if its contact row says opted in", async () => {
  reset();
  // The contact was deleted and re-created after its STOP: the row is clean,
  // the phone's suppression is not.
  tables.contact_opt_outs.push({ workspace_id: "ws_a", phone_key: "15550000001" });
  const tpl = await dispatchTemplate({ workspaceId: "ws_a", conversationId: "conv_a", templateName: "welcome" });
  assert.equal(tpl.errorCode, "OPT_OUT");
  assert.equal(sends.length, 0);

  const other = await dispatchTemplate({ workspaceId: "ws_b", conversationId: "conv_b", templateName: "welcome" });
  assert.equal(other.ok, true, "another workspace's suppression doesn't apply");
});
