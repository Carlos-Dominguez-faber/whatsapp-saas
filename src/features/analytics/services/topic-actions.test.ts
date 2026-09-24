import assert from "node:assert/strict";
import { mock, test } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

type Member = { ok: true; userId: string; role: string } | { ok: false; status: 401 | 403 };
let member: Member = { ok: true, userId: "user-1", role: "manager" };
let memberCalls: Array<{ workspaceId: string; opts: unknown }> = [];

mock.module("@/lib/auth/workspace-access.ts", {
  exports: {
    checkWorkspaceMember: async (workspaceId: string, opts: unknown) => {
      memberCalls.push({ workspaceId, opts });
      return member;
    },
  },
});

let revalidated: string[] = [];
mock.module("next/cache", { exports: { revalidatePath: (p: string) => revalidated.push(p) } });

// Fake encadenable: registra la operación y devuelve `nextResult` al final.
type Op = { table: string; kind: string; payload?: unknown; filters: Array<[string, unknown]> };
let ops: Op[] = [];
let nextResult: { data: unknown; error: { code?: string; message: string } | null } = { data: null, error: null };

function chain(op: Op) {
  const c = {
    eq(col: string, val: unknown) {
      op.filters.push([col, val]);
      return c;
    },
    select() {
      return c;
    },
    single: async () => nextResult,
    maybeSingle: async () => nextResult,
  };
  return c;
}

mock.module("@supabase/supabase-js", {
  exports: {
    createClient: () => ({
      from: (table: string) => ({
        insert(payload: unknown) {
          const op: Op = { table, kind: "insert", payload, filters: [] };
          ops.push(op);
          return chain(op);
        },
        update(payload: unknown) {
          const op: Op = { table, kind: "update", payload, filters: [] };
          ops.push(op);
          return chain(op);
        },
      }),
    }),
  },
});

const { createTopicAction, updateTopicAction, archiveTopicAction } = await import("./topic-actions.ts");

const WS = "11111111-1111-4111-8111-111111111111";
const TOPIC = "22222222-2222-4222-8222-222222222222";
const row = {
  id: TOPIC,
  name: "Precio",
  description: "Objeción de precio",
  status: "active",
  backfill_status: "pending",
  created_at: "2026-09-15T12:00:00Z",
};

function reset() {
  member = { ok: true, userId: "user-1", role: "manager" };
  memberCalls = [];
  revalidated = [];
  ops = [];
  nextResult = { data: row, error: null };
}

test("manager crea un tema: exige manager, inserta con workspace y autor, revalida", async () => {
  reset();
  const r = await createTopicAction(WS, { name: " Precio ", description: "Objeción de precio" });
  assert.deepEqual(r, { data: row });
  assert.deepEqual(memberCalls, [{ workspaceId: WS, opts: { minRole: "manager" } }]);
  assert.deepEqual(ops[0], {
    table: "insight_topics",
    kind: "insert",
    payload: { workspace_id: WS, name: "Precio", description: "Objeción de precio", created_by: "user-1" },
    filters: [],
  });
  assert.deepEqual(revalidated, ["/analisis"]);
});

test("rol insuficiente (viewer o agent): no escribe y responde en lenguaje natural", async () => {
  reset();
  member = { ok: false, status: 403 };
  const r = await createTopicAction(WS, { name: "Precio", description: "x" });
  assert.deepEqual(r, { error: "No tienes permiso para gestionar temas en este espacio." });
  assert.equal(ops.length, 0);
});

test("sesión vencida → mensaje de sesión, sin escribir", async () => {
  reset();
  member = { ok: false, status: 401 };
  const r = await archiveTopicAction(WS, TOPIC);
  assert.deepEqual(r, { error: "Tu sesión expiró. Vuelve a iniciar sesión." });
  assert.equal(ops.length, 0);
});

test("validación: nombre vacío y descripción larga devuelven mensaje por campo sin escribir", async () => {
  reset();
  const r = await createTopicAction(WS, { name: "", description: "x".repeat(501) });
  assert.ok("error" in r);
  if ("error" in r) {
    assert.equal(r.fieldErrors?.name, "Escribe un nombre para el tema.");
    assert.equal(r.fieldErrors?.description, "La descripción puede tener hasta 500 caracteres.");
  }
  assert.equal(ops.length, 0);
});

test("validación: input que no es objeto → error genérico de datos, sin escribir", async () => {
  reset();
  const r = await createTopicAction(WS, "no soy un objeto");
  assert.ok("error" in r);
  assert.equal(ops.length, 0);
});

test("tope de 10 activos → mensaje de tope", async () => {
  reset();
  nextResult = { data: null, error: { code: "P0001", message: "insight_topics_cap" } };
  const r = await createTopicAction(WS, { name: "Precio", description: "x" });
  assert.deepEqual(r, { error: "Llegaste al máximo de 10 temas activos. Archiva uno para crear otro." });
  assert.deepEqual(revalidated, []);
});

test("error interno de la base → mensaje genérico, sin filtrar detalle", async () => {
  reset();
  nextResult = { data: null, error: { code: "23503", message: "insert violates foreign key constraint fk_secret" } };
  const r = await createTopicAction(WS, { name: "Precio", description: "x" });
  assert.deepEqual(r, { error: "No se pudo guardar el tema. Intenta de nuevo en unos minutos." });
  assert.doesNotMatch(JSON.stringify(r), /fk_secret/);
});

test("editar: filtra por id, workspace y activo; solo cambia nombre y descripción", async () => {
  reset();
  const r = await updateTopicAction(WS, TOPIC, { name: "Precio alto", description: "Cliente dice que es caro" });
  assert.ok("data" in r);
  assert.deepEqual(ops[0].payload, { name: "Precio alto", description: "Cliente dice que es caro" });
  assert.deepEqual(ops[0].filters, [["id", TOPIC], ["workspace_id", WS], ["status", "active"]]);
});

test("editar un tema archivado, inexistente o de otro workspace → no encontrado", async () => {
  reset();
  nextResult = { data: null, error: null };
  const r = await updateTopicAction(WS, TOPIC, { name: "Precio", description: "x" });
  assert.deepEqual(r, { error: "Ese tema no existe o ya está archivado." });
});

test("topicId que no es uuid → error sin tocar la base ni la membresía", async () => {
  reset();
  const r = await archiveTopicAction(WS, "abc");
  assert.deepEqual(r, { error: "Ese tema no existe o ya está archivado." });
  assert.equal(ops.length, 0);
});

test("claves extra en el input (workspace_id, status, id) nunca llegan al insert (mass assignment)", async () => {
  // Hoy Zod las descarta porque TopicInputSchema es strict por defecto; si alguien
  // lo cambiara a passthrough(), este test es el que se rompe, no uno de schemas.test.ts.
  reset();
  const r = await createTopicAction(WS, {
    name: "Precio",
    description: "Objeción de precio",
    workspace_id: "otro-tenant",
    status: "archived",
    id: "999",
  });
  assert.deepEqual(r, { data: row });
  assert.deepEqual(ops[0].payload, {
    workspace_id: WS,
    name: "Precio",
    description: "Objeción de precio",
    created_by: "user-1",
  });
});

test("archivar: pone status archived filtrando workspace y activo", async () => {
  reset();
  nextResult = { data: { id: TOPIC }, error: null };
  const r = await archiveTopicAction(WS, TOPIC);
  assert.deepEqual(r, { data: { id: TOPIC } });
  assert.deepEqual(ops[0].payload, { status: "archived" });
  assert.deepEqual(ops[0].filters, [["id", TOPIC], ["workspace_id", WS], ["status", "active"]]);
  assert.deepEqual(revalidated, ["/analisis"]);
});
