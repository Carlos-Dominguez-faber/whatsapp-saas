import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

interface QueueEntry {
  data?: unknown;
  error?: unknown;
}

let integrationsRow: QueueEntry = { data: { config: {} }, error: null };
let ackEventsRow: QueueEntry = { data: [], error: null };
const inserts: Array<{ table: string; row: unknown }> = [];

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
        select: () => ({
          eq: () => ({
            eq: () => ({
              gte: () => ({ limit: async () => ackEventsRow }),
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

const { notifyHandoffPending } = await import("./handoff-notifier.ts");

function reset() {
  integrationsRow = { data: { config: {} }, error: null };
  ackEventsRow = { data: [], error: null };
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
