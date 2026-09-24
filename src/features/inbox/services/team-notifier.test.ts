import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

interface QueueEntry {
  data?: unknown;
  error?: unknown;
}

let membershipsRow: QueueEntry = {
  data: [{ users: { email: "a@ws.com" } }, { users: { email: "b@ws.com" } }],
  error: null,
};
let conversationRow: QueueEntry = {
  data: { contact_id: "contact_1" },
  error: null,
};
let contactRow: QueueEntry = {
  data: { name: "Juanita", phone: "+15550001111" },
  error: null,
};
let teamEventsRow: QueueEntry = { data: [], error: null };
const inserts: Array<{ table: string; row: unknown }> = [];

const fakeClient = {
  from(table: string) {
    if (table === "memberships") {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              in: () => ({ limit: async () => membershipsRow }),
            }),
          }),
        }),
      };
    }
    if (table === "conversations") {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => conversationRow }),
          }),
        }),
      };
    }
    if (table === "contacts") {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => contactRow }),
          }),
        }),
      };
    }
    if (table === "events") {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                gte: () => ({ limit: async () => teamEventsRow }),
              }),
            }),
          }),
        }),
        insert: (row: unknown) => {
          inserts.push({ table, row });
          return Promise.resolve({ data: null, error: null });
        },
      };
    }
    throw new Error(`unexpected table: ${table}`);
  },
};

mock.module("@supabase/supabase-js", {
  exports: { createClient: () => fakeClient },
});

const { notifyTeamHandoff } = await import("./team-notifier.ts");

function reset() {
  membershipsRow = {
    data: [{ users: { email: "a@ws.com" } }, { users: { email: "b@ws.com" } }],
    error: null,
  };
  conversationRow = { data: { contact_id: "contact_1" }, error: null };
  contactRow = { data: { name: "Juanita", phone: "+15550001111" }, error: null };
  teamEventsRow = { data: [], error: null };
  inserts.length = 0;
  process.env.RESEND_API_KEY = "re_fake";
  process.env.HANDOFF_NOTIFY_FROM = "avisos@example.com";
}

function eventsOfType(type: string) {
  return inserts.filter(
    (i) => i.table === "events" && (i.row as { type: string }).type === type,
  );
}

test("manda el correo a los operadores activos y registra handoff_team_notified", async () => {
  reset();
  const fetchCalls: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: unknown) => {
    fetchCalls.push({ url, init });
    return { ok: true } as Response;
  }) as typeof fetch;

  try {
    await notifyTeamHandoff({
      workspaceId: "ws_1",
      conversationId: "conv_1",
      trigger: "keyword",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetchCalls.length, 1);
  const body = JSON.parse((fetchCalls[0] as { init: { body: string } }).init.body);
  assert.deepEqual(body.to, ["a@ws.com", "b@ws.com"]);
  assert.match(body.text, /Juanita/);
  assert.match(body.text, /conv_1/);

  const sent = eventsOfType("handoff_team_notified");
  assert.equal(sent.length, 1);
});

test("sin RESEND_API_KEY o HANDOFF_NOTIFY_FROM se salta sin lanzar", async () => {
  reset();
  delete process.env.RESEND_API_KEY;
  const fetchCalls: unknown[] = [];
  globalThis.fetch = (async () => {
    fetchCalls.push(1);
    return { ok: true } as Response;
  }) as typeof fetch;

  await notifyTeamHandoff({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    trigger: "keyword",
  });

  assert.equal(fetchCalls.length, 0);
  const skipped = eventsOfType("handoff_team_notify_skipped");
  assert.equal(skipped.length, 1);
  assert.equal(
    (skipped[0].row as { payload: { reason: string } }).payload.reason,
    "not_configured",
  );
});

test("sin miembros activos elegibles se salta", async () => {
  reset();
  membershipsRow = { data: [], error: null };
  const fetchCalls: unknown[] = [];
  globalThis.fetch = (async () => {
    fetchCalls.push(1);
    return { ok: true } as Response;
  }) as typeof fetch;

  await notifyTeamHandoff({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    trigger: "keyword",
  });

  assert.equal(fetchCalls.length, 0);
  const skipped = eventsOfType("handoff_team_notify_skipped");
  assert.equal(skipped.length, 1);
  assert.equal(
    (skipped[0].row as { payload: { reason: string } }).payload.reason,
    "no_recipients",
  );
});

test("dedupe: un aviso ya mandado en los últimos 15 min no se repite", async () => {
  reset();
  teamEventsRow = { data: [{ id: "evt_1" }], error: null };
  const fetchCalls: unknown[] = [];
  globalThis.fetch = (async () => {
    fetchCalls.push(1);
    return { ok: true } as Response;
  }) as typeof fetch;

  await notifyTeamHandoff({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    trigger: "keyword",
  });

  assert.equal(fetchCalls.length, 0);
  const skipped = eventsOfType("handoff_team_notify_skipped");
  assert.equal(skipped.length, 1);
  assert.equal(
    (skipped[0].row as { payload: { reason: string } }).payload.reason,
    "deduped",
  );
});

test("Resend responde 4xx/5xx: evento warn, no lanza", async () => {
  reset();
  globalThis.fetch = (async () => {
    return { ok: false, status: 422 } as Response;
  }) as typeof fetch;

  await assert.doesNotReject(() =>
    notifyTeamHandoff({
      workspaceId: "ws_1",
      conversationId: "conv_1",
      trigger: "keyword",
    }),
  );

  const failed = eventsOfType("handoff_team_notify_failed");
  assert.equal(failed.length, 1);
  assert.equal((failed[0].row as { level: string }).level, "warn");
});

test("fetch que lanza (red caída) no lanza y registra handoff_team_notify_failed", async () => {
  reset();
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;

  await assert.doesNotReject(() =>
    notifyTeamHandoff({
      workspaceId: "ws_1",
      conversationId: "conv_1",
      trigger: "keyword",
    }),
  );

  const failed = eventsOfType("handoff_team_notify_failed");
  assert.equal(failed.length, 1);
});

test("timeout del fetch (AbortError) se registra como fallo sin lanzar", async () => {
  reset();
  const fetchCalls: Array<{ init: RequestInit }> = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    fetchCalls.push({ init });
    throw new DOMException("The operation was aborted", "AbortError");
  }) as typeof fetch;

  await assert.doesNotReject(() =>
    notifyTeamHandoff({
      workspaceId: "ws_1",
      conversationId: "conv_1",
      trigger: "keyword",
    }),
  );

  assert.ok(
    fetchCalls[0]?.init.signal,
    "el fetch a Resend tiene que llevar una señal de timeout",
  );
  const failed = eventsOfType("handoff_team_notify_failed");
  assert.equal(failed.length, 1);
  assert.equal((failed[0].row as { level: string }).level, "warn");
});

test("se manda igual con trigger 'tool:*' (el corte del ACK al cliente no aplica acá)", async () => {
  reset();
  const fetchCalls: unknown[] = [];
  globalThis.fetch = (async () => {
    fetchCalls.push(1);
    return { ok: true } as Response;
  }) as typeof fetch;

  await notifyTeamHandoff({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    trigger: "tool:agent_stuck",
  });

  assert.equal(fetchCalls.length, 1);
  assert.equal(eventsOfType("handoff_team_notified").length, 1);
});

// ── aislamiento de tenant en el contacto ──

test("conversationId que no pertenece al workspace: NO manda correo", async () => {
  reset();
  conversationRow = { data: null, error: null };
  const fetchCalls: unknown[] = [];
  globalThis.fetch = (async () => {
    fetchCalls.push(1);
    return { ok: true } as Response;
  }) as typeof fetch;

  await notifyTeamHandoff({
    workspaceId: "ws_1",
    conversationId: "conv_ajena",
    trigger: "keyword",
  });

  assert.equal(fetchCalls.length, 0, "no hay que exponer un enlace ajeno");
  const skipped = eventsOfType("handoff_team_notify_skipped");
  assert.equal(skipped.length, 1);
  assert.equal(
    (skipped[0].row as { payload: { reason: string } }).payload.reason,
    "conversation_not_in_workspace",
  );
  assert.equal((skipped[0].row as { level: string }).level, "warn");
});

test("contacto de otro workspace: correo sale, sin nombre ni teléfono", async () => {
  reset();
  contactRow = { data: null, error: null };
  const fetchCalls: Array<{ init: { body: string } }> = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    fetchCalls.push({ init });
    return { ok: true } as Response;
  }) as typeof fetch;

  await notifyTeamHandoff({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    trigger: "keyword",
  });

  assert.equal(fetchCalls.length, 1, "el equipo igual tiene que enterarse");
  const body = JSON.parse(fetchCalls[0].init.body);
  assert.doesNotMatch(body.text, /Juanita/);
  assert.doesNotMatch(body.text, /\+1555/);

  const anomaly = eventsOfType("handoff_team_notify_anomaly");
  assert.equal(anomaly.length, 1);
  assert.equal(
    (anomaly[0].row as { payload: { reason: string } }).payload.reason,
    "contact_workspace_mismatch",
  );
  assert.equal((anomaly[0].row as { level: string }).level, "warn");
});

// ── un error de la consulta de destinatarios no es "no hay destinatarios" ──

test("error en la consulta de memberships: evento warn distinto de no_recipients", async () => {
  reset();
  membershipsRow = { data: null, error: { message: "connection reset" } };
  const fetchCalls: unknown[] = [];
  globalThis.fetch = (async () => {
    fetchCalls.push(1);
    return { ok: true } as Response;
  }) as typeof fetch;

  await notifyTeamHandoff({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    trigger: "keyword",
  });

  assert.equal(fetchCalls.length, 0);
  assert.equal(eventsOfType("no_recipients").length, 0);
  const failed = eventsOfType("handoff_team_notify_failed");
  assert.equal(failed.length, 1);
  assert.equal(
    (failed[0].row as { payload: { reason: string } }).payload.reason,
    "recipients_query_failed",
  );
  assert.equal((failed[0].row as { level: string }).level, "warn");
  // el detalle técnico NUNCA va al evento
  assert.doesNotMatch(
    JSON.stringify(failed[0].row),
    /connection reset/,
  );
});

// ── un email con formato inválido no tumba el envío ──

test("un destinatario con email inválido se descarta; a los válidos sí les llega", async () => {
  reset();
  membershipsRow = {
    data: [
      { users: { email: "a@ws.com" } },
      { users: { email: "not-an-email" } },
      { users: { email: "b@ws.com" } },
    ],
    error: null,
  };
  const fetchCalls: Array<{ init: { body: string } }> = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    fetchCalls.push({ init });
    return { ok: true } as Response;
  }) as typeof fetch;

  await notifyTeamHandoff({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    trigger: "keyword",
  });

  assert.equal(fetchCalls.length, 1);
  const body = JSON.parse(fetchCalls[0].init.body);
  assert.deepEqual(body.to, ["a@ws.com", "b@ws.com"]);

  const anomaly = eventsOfType("handoff_team_notify_anomaly").filter(
    (i) =>
      (i.row as { payload: { reason: string } }).payload.reason ===
      "invalid_recipient_emails",
  );
  assert.equal(anomaly.length, 1);
  assert.equal(
    (anomaly[0].row as { payload: { discarded: number } }).payload.discarded,
    1,
  );
  assert.equal((anomaly[0].row as { level: string }).level, "warn");
  // ninguna dirección de correo va en el evento del descarte
  assert.doesNotMatch(JSON.stringify(anomaly[0].row), /not-an-email|@ws\.com/);

  assert.equal(eventsOfType("handoff_team_notified").length, 1);
});

test("todos los destinatarios con email inválido: no manda correo, motivo no_valid_recipients", async () => {
  reset();
  membershipsRow = {
    data: [
      { users: { email: "not-an-email" } },
      { users: { email: "tampoco" } },
    ],
    error: null,
  };
  const fetchCalls: unknown[] = [];
  globalThis.fetch = (async () => {
    fetchCalls.push(1);
    return { ok: true } as Response;
  }) as typeof fetch;

  await notifyTeamHandoff({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    trigger: "keyword",
  });

  assert.equal(fetchCalls.length, 0);
  const skipped = eventsOfType("handoff_team_notify_skipped").filter(
    (i) =>
      (i.row as { payload: { reason: string } }).payload.reason ===
      "no_valid_recipients",
  );
  assert.equal(skipped.length, 1);
  assert.equal((skipped[0].row as { level: string }).level, "warn");
  assert.doesNotMatch(
    JSON.stringify(skipped[0].row),
    /not-an-email|tampoco/,
  );
});

// ── un fallo de infraestructura ≠ inconsistencia de datos ──

test("error en la consulta de conversación: no manda correo, motivo conversation_read_failed", async () => {
  reset();
  conversationRow = { data: null, error: { message: "connection reset" } };
  const fetchCalls: unknown[] = [];
  globalThis.fetch = (async () => {
    fetchCalls.push(1);
    return { ok: true } as Response;
  }) as typeof fetch;

  await notifyTeamHandoff({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    trigger: "keyword",
  });

  assert.equal(fetchCalls.length, 0, "no se puede afirmar de quién es la conversación");
  assert.equal(
    eventsOfType("handoff_team_notify_skipped").filter(
      (i) =>
        (i.row as { payload: { reason: string } }).payload.reason ===
        "conversation_not_in_workspace",
    ).length,
    0,
    "un fallo de infra no es lo mismo que una conversación ajena",
  );
  const failed = eventsOfType("handoff_team_notify_failed").filter(
    (i) =>
      (i.row as { payload: { reason: string } }).payload.reason ===
      "conversation_read_failed",
  );
  assert.equal(failed.length, 1);
  assert.equal((failed[0].row as { level: string }).level, "warn");
  assert.doesNotMatch(JSON.stringify(failed[0].row), /connection reset/);
});

test("error en la consulta de contacto: manda correo genérico, motivo contact_read_failed", async () => {
  reset();
  contactRow = { data: null, error: { message: "connection reset" } };
  const fetchCalls: Array<{ init: { body: string } }> = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    fetchCalls.push({ init });
    return { ok: true } as Response;
  }) as typeof fetch;

  await notifyTeamHandoff({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    trigger: "keyword",
  });

  assert.equal(fetchCalls.length, 1, "el equipo igual tiene que enterarse");
  const body = JSON.parse(fetchCalls[0].init.body);
  assert.doesNotMatch(body.text, /Juanita/);

  const failed = eventsOfType("handoff_team_notify_failed").filter(
    (i) =>
      (i.row as { payload: { reason: string } }).payload.reason ===
      "contact_read_failed",
  );
  assert.equal(failed.length, 1);
  assert.equal((failed[0].row as { level: string }).level, "warn");
  assert.doesNotMatch(JSON.stringify(failed[0].row), /connection reset/);

  assert.equal(
    eventsOfType("handoff_team_notify_anomaly").filter(
      (i) =>
        (i.row as { payload: { reason: string } }).payload.reason ===
        "contact_workspace_mismatch",
    ).length,
    0,
    "un fallo de infra no es la misma inconsistencia de tenant",
  );
});

test("el caso real de inconsistencia entre tenants sigue dando contact_workspace_mismatch", async () => {
  reset();
  contactRow = { data: null, error: null };
  globalThis.fetch = (async () => ({ ok: true }) as Response) as typeof fetch;

  await notifyTeamHandoff({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    trigger: "keyword",
  });

  const anomaly = eventsOfType("handoff_team_notify_anomaly").filter(
    (i) =>
      (i.row as { payload: { reason: string } }).payload.reason ===
      "contact_workspace_mismatch",
  );
  assert.equal(anomaly.length, 1);
});
