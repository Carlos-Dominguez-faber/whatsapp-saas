import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

let messages: Array<{ direction: string; body: string }> = [
  { direction: "in", body: "hola, quiero precio" },
];
const updates: Array<{ table: string; row: unknown }> = [];
const rpcCalls: Array<{ fn: string; args: unknown }> = [];
let rpcError: { message: string } | null = null;

const fakeClient = {
  from(table: string) {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: async () => ({ data: messages, error: null }),
      maybeSingle: async () => ({ data: { tags: ["vip"] }, error: null }),
      update(row: unknown) {
        updates.push({ table, row });
        return { eq: async () => ({ data: null, error: null }) };
      },
    };
    return chain;
  },
  rpc(fn: string, args: unknown) {
    rpcCalls.push({ fn, args });
    return Promise.resolve({
      data: [{ contact_found: true, tags_added: 2 }],
      error: rpcError,
    });
  },
};
mock.module("@supabase/supabase-js", {
  exports: { createClient: () => fakeClient },
});

let replyText = '{"tags":["interesado","precio"],"summary":"Pide precios"}';
mock.module("@/features/inbox/services/openrouter.ts", {
  exports: { generateChatReply: async () => ({ text: replyText }) },
});

const { maybeAutoProcess } = await import("./auto-tagging.ts");

function reset() {
  updates.length = 0;
  rpcCalls.length = 0;
  rpcError = null;
  messages = [{ direction: "in", body: "hola, quiero precio" }];
  replyText = '{"tags":["interesado","precio"],"summary":"Pide precios"}';
}

const opts = {
  workspaceId: "ws_1",
  conversationId: "conv_1",
  contactId: "contact_1",
  config: { autoTag: true, summarize: false } as never,
};

// ── Camino correcto ──────────────────────────────────────────────────────────

test("las etiquetas van por la RPC atómica, con el workspace y en UNA llamada", async () => {
  reset();
  await maybeAutoProcess(opts);
  assert.deepEqual(rpcCalls, [
    {
      fn: "append_contact_tags",
      args: {
        p_workspace_id: "ws_1",
        p_contact_id: "contact_1",
        p_tags: ["interesado", "precio"],
      },
    },
  ]);
});

test("ya NO lee tags para reescribir el array completo", async () => {
  reset();
  await maybeAutoProcess(opts);
  assert.equal(
    updates.filter((u) => u.table === "contacts").length,
    0,
    "el read-modify-write borraba las etiquetas que ponía el motor",
  );
});

// ── Caminos de error ─────────────────────────────────────────────────────────

test("un fallo de la RPC no lanza: el auto-tagging es best-effort", async () => {
  reset();
  rpcError = { message: "permission denied" };
  await assert.doesNotReject(() => maybeAutoProcess(opts));
});

test("sin etiquetas en la respuesta del modelo no se llama a la RPC", async () => {
  reset();
  replyText = '{"tags":[],"summary":"nada"}';
  await maybeAutoProcess(opts);
  assert.equal(rpcCalls.length, 0);
});
