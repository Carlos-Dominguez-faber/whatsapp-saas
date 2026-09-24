import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

interface QueueEntry {
  data?: unknown;
  error?: unknown;
}

interface StoredEvent {
  workspace_id: string;
  conversation_id: string;
  type: string;
  created_at: string;
}

let integrationsRow: QueueEntry = { data: { config: {} }, error: null };
// Tabla `events` real (no un stub estático): wasRecentlyLogged filtra por
// workspace_id + conversation_id + type + created_at, y hace falta un fake
// que respete esos filtros para probar que un evento de OTRO workspace no
// cuenta como dedupe.
let eventsTable: StoredEvent[] = [];
const inserts: Array<{ table: string; row: unknown }> = [];

/** Chain que acumula filtros `.eq()`/`.gte()` y los aplica recién en `.limit()`. */
function eventsSelectChain(filters: Array<{ col: string; op: "eq" | "gte"; val: unknown }>) {
  return {
    eq: (col: string, val: unknown) =>
      eventsSelectChain([...filters, { col, op: "eq", val }]),
    gte: (col: string, val: unknown) =>
      eventsSelectChain([...filters, { col, op: "gte", val }]),
    limit: async (n: number) => {
      const matched = eventsTable.filter((row) =>
        filters.every(({ col, op, val }) => {
          const rowVal = (row as unknown as Record<string, unknown>)[col];
          return op === "eq" ? rowVal === val : (rowVal as string) >= (val as string);
        }),
      );
      return { data: matched.slice(0, n).map((_, i) => ({ id: `evt_${i}` })), error: null };
    },
  };
}

const fakeClient = {
  from(table: string) {
    if (table === "integrations") {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => integrationsRow }),
          }),
        }),
      };
    }
    if (table === "events") {
      return {
        select: () => eventsSelectChain([]),
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

const dispatchCalls: unknown[] = [];
let dispatchResult: { ok: boolean; error?: string; errorCode?: string } = {
  ok: true,
};
mock.module("./dispatch.ts", {
  exports: {
    dispatchText: async (opts: unknown) => {
      dispatchCalls.push(opts);
      return dispatchResult;
    },
  },
});

const { notifyHandoffPending, wasRecentlyLogged } = await import(
  "./handoff-notifier.ts"
);

function reset() {
  integrationsRow = { data: { config: {} }, error: null };
  eventsTable = [];
  inserts.length = 0;
  dispatchCalls.length = 0;
  dispatchResult = { ok: true };
}

// ── el ACK genérico no duplica la despedida de handoff_human ──

test("un trigger 'tool:*' no despacha el ACK y registra handoff_ack_skipped", async () => {
  reset();
  await notifyHandoffPending({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    trigger: "tool:agent_stuck",
  });

  assert.equal(
    dispatchCalls.length,
    0,
    "el agente ya se despidió del cliente en ese mismo turno",
  );
  const skipped = inserts.find(
    (i) =>
      i.table === "events" &&
      (i.row as { type: string }).type === "handoff_ack_skipped",
  );
  assert.ok(skipped, "tiene que quedar registrado por qué no se mandó el ACK");
  const payload = (skipped!.row as { payload: Record<string, unknown> }).payload;
  assert.equal(payload.reason, "agent_farewell");
  assert.equal(payload.trigger, "tool:agent_stuck");
});

test("un trigger 'tool_unsent:*' SÍ despacha el ACK (el cliente no recibió la despedida)", async () => {
  reset();
  await notifyHandoffPending({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    trigger: "tool_unsent:agent_stuck",
  });

  assert.equal(
    dispatchCalls.length,
    1,
    "la despedida del agente no salió: el cliente no puede quedarse sin nada",
  );
  assert.equal(
    inserts.some(
      (i) => (i.row as { type: string }).type === "handoff_ack_skipped",
    ),
    false,
  );
});

// ── aviso al equipo: no depende de ninguno de los cortes del ACK al cliente ──

test("el aviso al equipo se intenta con config.enabled=false (ese flag es del ACK, no del equipo)", async () => {
  reset();
  integrationsRow = { data: { config: { handoff_ack_enabled: false } }, error: null };
  delete process.env.RESEND_API_KEY;

  await notifyHandoffPending({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    trigger: "keyword",
  });

  const teamSkipped = inserts.find(
    (i) =>
      i.table === "events" &&
      (i.row as { type: string }).type === "handoff_team_notify_skipped",
  );
  assert.ok(
    teamSkipped,
    "el aviso al equipo tiene que intentarse (y quedar registrado) aunque el ACK esté apagado",
  );
});

test("el aviso al equipo se intenta con trigger 'tool:*' (ese corte también es del ACK, no del equipo)", async () => {
  reset();
  delete process.env.RESEND_API_KEY;

  await notifyHandoffPending({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    trigger: "tool:agent_stuck",
  });

  const teamSkipped = inserts.find(
    (i) =>
      i.table === "events" &&
      (i.row as { type: string }).type === "handoff_team_notify_skipped",
  );
  assert.ok(teamSkipped, "el aviso al equipo tiene que intentarse igual");
});

test("un trigger normal (keyword) sí despacha el ACK", async () => {
  reset();
  await notifyHandoffPending({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    trigger: "keyword",
  });

  assert.equal(dispatchCalls.length, 1);
  const sent = inserts.find(
    (i) =>
      i.table === "events" &&
      (i.row as { type: string }).type === "handoff_ack_sent",
  );
  assert.ok(sent);
  assert.equal(
    inserts.some(
      (i) => (i.row as { type: string }).type === "handoff_ack_skipped",
    ),
    false,
  );
});

// ── el dedupe filtra por workspace, no solo por conversación+tipo ──

test("wasRecentlyLogged: un evento del mismo workspace dentro de la ventana SÍ cuenta", async () => {
  reset();
  eventsTable = [
    {
      workspace_id: "ws_1",
      conversation_id: "conv_1",
      type: "handoff_ack_sent",
      created_at: new Date().toISOString(),
    },
  ];

  assert.equal(
    await wasRecentlyLogged("ws_1", "conv_1", "handoff_ack_sent", 15),
    true,
  );
});

test("wasRecentlyLogged: un evento de OTRO workspace NO cuenta, aunque calcen conversación y tipo", async () => {
  reset();
  // Un operador de ws_other pudo insertar esta fila apuntando al
  // conversation_id de ws_1 (la policy events_insert no lo impide). Sin el
  // filtro de workspace, este evento silenciaría el aviso real de ws_1.
  eventsTable = [
    {
      workspace_id: "ws_other",
      conversation_id: "conv_1",
      type: "handoff_ack_sent",
      created_at: new Date().toISOString(),
    },
  ];

  assert.equal(
    await wasRecentlyLogged("ws_1", "conv_1", "handoff_ack_sent", 15),
    false,
  );
});

test("dedupe cruzado de OTRO workspace no silencia el ACK real de este workspace", async () => {
  reset();
  eventsTable = [
    {
      workspace_id: "ws_other",
      conversation_id: "conv_1",
      type: "handoff_ack_sent",
      created_at: new Date().toISOString(),
    },
  ];

  await notifyHandoffPending({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    trigger: "keyword",
  });

  assert.equal(dispatchCalls.length, 1, "el ACK real no se puede quedar sin mandar");
});
