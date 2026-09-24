import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

/**
 * Lo que devuelve append_contact_tags: una fila { contact_found, tags_added }.
 * PostgREST entrega las funciones RETURNS TABLE como ARRAY de filas, así que el
 * fake lo imita — si el servicio asume un objeto suelto, este fake lo delata.
 * Las columnas no se llaman `found`: chocaría con la variable implícita FOUND
 * de PL/pgSQL y la RPC devolvería NULL.
 */
let rpcResult: { data: unknown; error: { message: string } | null } = {
  data: [{ contact_found: true, tags_added: 1 }],
  error: null,
};
const rpcCalls: Array<{ fn: string; args: unknown }> = [];
const updates: Array<{ table: string; row: unknown }> = [];

const fakeClient = {
  from(table: string) {
    return {
      // Sigue existiendo para detectar una regresión: si addTagToContact vuelve
      // al read-modify-write, `updates` deja de estar vacío y los tests lo ven.
      update(row: unknown) {
        const chain: any = {
          eq: () => chain,
          then(resolve: (v: unknown) => void) {
            updates.push({ table, row });
            resolve({ data: null, error: null });
          },
        };
        return chain;
      },
    };
  },
  rpc(fn: string, args: unknown) {
    rpcCalls.push({ fn, args });
    return Promise.resolve(rpcResult);
  },
};
mock.module("@supabase/supabase-js", {
  exports: { createClient: () => fakeClient },
});

// TransitionError se toma de la implementación real (módulo puro, sin DB): el
// `instanceof` de requestHandoff tiene que probarse contra la clase de verdad, no contra
// una copia del test.
const { TransitionError } = await import("./state-machine.ts");

const transitions: unknown[][] = [];
let transitionThrows: Error | null = null;
mock.module("./decision-engine.ts", {
  exports: {
    TransitionError,
    applyTransition: async (...args: unknown[]) => {
      if (transitionThrows) throw transitionThrows;
      transitions.push(args);
    },
  },
});

const hlSyncs: string[] = [];
mock.module("./highlevel-client.ts", {
  exports: {
    syncContactToHL: async (_ws: string, contactId: string) => {
      hlSyncs.push(contactId);
      return null;
    },
  },
});

const { addTagToContact, requestHandoff, ConfigError } = await import(
  "./conversation-actions.ts"
);

function reset() {
  rpcResult = { data: [{ contact_found: true, tags_added: 1 }], error: null };
  rpcCalls.length = 0;
  updates.length = 0;
  transitions.length = 0;
  transitionThrows = null;
  hlSyncs.length = 0;
}

// ── Camino correcto ──────────────────────────────────────────────────────────

test("addTagToContact delega en la RPC atómica, nunca en un read-modify-write", async () => {
  reset();
  assert.equal(
    await addTagToContact({
      workspaceId: "ws_1",
      contactId: "contact_1",
      tag: "  interesado  ",
    }),
    true,
  );
  assert.deepEqual(rpcCalls, [
    {
      fn: "append_contact_tags",
      args: {
        p_workspace_id: "ws_1",
        p_contact_id: "contact_1",
        p_tags: ["interesado"],
      },
    },
  ]);
  assert.equal(
    updates.length,
    0,
    "leer las tags y volver a escribirlas pierde etiquetas bajo concurrencia",
  );
  assert.deepEqual(hlSyncs, ["contact_1"]);
});

test("una etiqueta que ya estaba es ÉXITO idempotente: false, sin sync y sin lanzar", async () => {
  reset();
  // contact_found=true, tags_added=0. Si esto se tratara como fallo, el segundo
  // mensaje que matchea la misma regla reintentaría hasta agotar intentos, en
  // vez de que los DOS runs queden 'done'.
  rpcResult = { data: [{ contact_found: true, tags_added: 0 }], error: null };
  assert.equal(
    await addTagToContact({
      workspaceId: "ws_1",
      contactId: "contact_1",
      tag: "interesado",
    }),
    false,
  );
  assert.deepEqual(hlSyncs, [], "no cambió nada: un sync por vuelta sería ruido");
});

test("requestHandoff pasa por applyTransition con el scope del workspace", async () => {
  reset();
  assert.equal(
    await requestHandoff({
      workspaceId: "ws_1",
      conversationId: "conv_1",
      reason: "automation",
    }),
    true,
  );
  assert.deepEqual(transitions[0], [
    "conv_1",
    "handoff_pending",
    { trigger: "automation", workspaceId: "ws_1" },
  ]);
  assert.equal(updates.length, 0, "no debe tocar conversations a mano");
});

// ── Caminos de error ─────────────────────────────────────────────────────────

test("addTagToContact con etiqueta vacía ni siquiera llama a la RPC", async () => {
  reset();
  // Configuración rota (la regla se guardó sin `tag`), no un transitorio:
  // reintentarla tres veces no la arregla.
  await assert.rejects(
    () =>
      addTagToContact({ workspaceId: "ws_1", contactId: "contact_1", tag: "   " }),
    (err: unknown) =>
      err instanceof ConfigError && (err as { code: string }).code === "empty_tag",
  );
  assert.equal(rpcCalls.length, 0);
  assert.deepEqual(hlSyncs, []);
});

test("un contacto inexistente o de otro workspace lanza ConfigError, no un false ambiguo", async () => {
  reset();
  // La RPC filtra por (id, workspace_id): sin fila ⇒ contact_found=FALSE.
  // Es configuración rota, no un transitorio: el ejecutor lo cierra 'failed'
  // sin reintento, y por eso NO puede confundirse con tags_added=0.
  rpcResult = { data: [{ contact_found: false, tags_added: 0 }], error: null };
  await assert.rejects(
    () => addTagToContact({ workspaceId: "ws_1", contactId: "fantasma", tag: "x" }),
    (err: unknown) =>
      err instanceof ConfigError &&
      (err as { code: string }).code === "contact_not_found",
  );
  assert.deepEqual(hlSyncs, []);
});

test("addTagToContact propaga el error de la RPC para que el run se reintente", async () => {
  reset();
  rpcResult = { data: null, error: { message: "permission denied" } };
  await assert.rejects(
    () => addTagToContact({ workspaceId: "ws_1", contactId: "contact_1", tag: "x" }),
    (err: unknown) => !(err instanceof ConfigError),
  );
  assert.deepEqual(hlSyncs, []);
});

test("una RPC que no devuelve ninguna fila es 'no sé', y 'no sé' se reintenta", async () => {
  reset();
  rpcResult = { data: [], error: null }; // RETURNS TABLE sin filas
  await assert.rejects(
    () => addTagToContact({ workspaceId: "ws_1", contactId: "contact_1", tag: "x" }),
    (err: unknown) => !(err instanceof ConfigError),
  );
  assert.deepEqual(hlSyncs, []);
});

test("requestHandoff devuelve false ante TransitionError, sin lanzar", async () => {
  reset();
  transitionThrows = new TransitionError("closed", "handoff_pending");
  assert.equal(
    await requestHandoff({
      workspaceId: "ws_1",
      conversationId: "conv_cerrada",
      reason: "automation",
    }),
    false,
  );
});

test("requestHandoff RELANZA cualquier error que no sea TransitionError", async () => {
  reset();
  // Tragar una caída de la base como `false` convertiría un handoff perdido en
  // un `skipped` silencioso: el cliente se quedaría esperando a un humano que
  // nunca fue avisado, y nadie lo vería.
  transitionThrows = new Error(
    "[decision-engine] failed to apply transition: connection reset",
  );
  await assert.rejects(
    () =>
      requestHandoff({
        workspaceId: "ws_1",
        conversationId: "conv_1",
        reason: "automation",
      }),
    /connection reset/,
  );
});
