import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

// ── Fakes ────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
let contacts: Row[] = [];
let currentUser: { id: string } | null = { id: "user_1" };

/** Tabla en memoria: los `.eq()` se aplican, así un filtro equivocado no devuelve fila. */
function contactsQuery() {
  const filters: Array<[string, unknown]> = [];
  let patch: Row | null = null;
  const rows = () => contacts.filter((r) => filters.every(([c, v]) => r[c] === v));
  const chain = {
    select: () => chain,
    update: (p: Row) => {
      patch = p;
      return chain;
    },
    eq: (c: string, v: unknown) => {
      filters.push([c, v]);
      return chain;
    },
    // Copia, como PostgREST: un UPDATE posterior no muta lo que ya se leyó.
    maybeSingle: async () => ({ data: rows()[0] ? { ...rows()[0] } : null, error: null }),
    single: async () => {
      const r = rows()[0];
      if (r && patch) Object.assign(r, patch);
      return { data: r ?? null, error: r ? null : { message: "not found" } };
    },
  };
  return chain;
}

const fakeClient = {
  auth: { getUser: async () => ({ data: { user: currentUser }, error: null }) },
  from: () => contactsQuery(),
};
mock.module("@/lib/supabase/server.ts", {
  exports: { createClient: async () => fakeClient },
});
mock.module("@supabase/supabase-js", {
  exports: { createClient: () => fakeClient },
});

let memberResult: unknown = { ok: true, userId: "user_1", role: "agent" };
const memberCalls: unknown[] = [];
mock.module("@/lib/auth/workspace-access.ts", {
  exports: {
    checkWorkspaceMember: async (...args: unknown[]) => {
      memberCalls.push(args);
      return memberResult;
    },
  },
});

const syncCalls: Array<{ ws: string; contactId: string; opts: unknown }> = [];
const manualCalls: string[] = [];
let manualResult: unknown = { ok: false, reason: "failed" };
let manualThrows: Error | null = null;
const realCrmSync = await import("./crm-sync.ts");
mock.module("./crm-sync.ts", {
  exports: {
    contactSyncOptions: realCrmSync.contactSyncOptions,
    syncContactToCrm: async (ws: string, contactId: string, opts?: unknown) => {
      syncCalls.push({ ws, contactId, opts });
      return { ok: false, reason: "no_crm" };
    },
    syncContactManually: async (ws: string) => {
      manualCalls.push(ws);
      if (manualThrows) throw manualThrows;
      return manualResult;
    },
  },
});

// El sync de una edición va por `after()` de Next (mantiene viva la función hasta que termina),
// no como promesa suelta. El mock retiene la tarea para afirmar que se ENTREGÓ a after.
const afterTasks: Array<() => unknown> = [];
mock.module("next/server", {
  exports: { after: (task: () => unknown) => void afterTasks.push(task) },
});

const { updateContact, syncContactCrm } = await import("./contact-actions.ts");

function reset() {
  contacts = [{ id: "contact_1", workspace_id: "ws_1", name: "Ana", email: null, tags: ["a"] }];
  currentUser = { id: "user_1" };
  memberResult = { ok: true, userId: "user_1", role: "agent" };
  memberCalls.length = 0;
  syncCalls.length = 0;
  manualCalls.length = 0;
  manualResult = { ok: false, reason: "failed" };
  manualThrows = null;
  afterTasks.length = 0;
}

async function runAfter() {
  for (const t of afterTasks) await t();
}

// ── syncContactCrm (botón "Sincronizar CRM") ────────────────────────────────

test("syncContactCrm sincroniza con el workspace del contacto y exige rol que escribe", async () => {
  reset();
  manualResult = { ok: true, provider: "hubspot", id: "hs_42" };
  const result = await syncContactCrm("contact_1");
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { provider: "hubspot", id: "hs_42" });
  assert.deepEqual(manualCalls, ["ws_1"]);
  assert.deepEqual(memberCalls[0], ["ws_1", { minRole: "agent" }]);
});

test("syncContactCrm traduce cada motivo a un mensaje en español", async () => {
  reset();
  manualResult = { ok: false, reason: "no_crm" };
  assert.equal((await syncContactCrm("contact_1")).error, "No hay un CRM conectado. Conéctalo en Configuración → Integraciones.");
  manualResult = { ok: false, reason: "crm_conflict" };
  assert.equal((await syncContactCrm("contact_1")).error, "Hay dos CRM activos. Desactiva uno en Configuración → Integraciones.");
  manualResult = { ok: false, reason: "failed", code: "properties_not_ready" };
  assert.equal((await syncContactCrm("contact_1")).error, "Falta probar la conexión de HubSpot en Configuración → Integraciones.");
  manualResult = { ok: false, reason: "failed", code: "unexpected_error" };
  assert.equal((await syncContactCrm("contact_1")).error, "No pudimos sincronizar con el CRM. Intenta de nuevo.");
});

test("syncContactCrm: si el sync lanza, responde ok:false sin detalle técnico", async () => {
  reset();
  manualThrows = new Error("decrypt: bad ciphertext");
  const result = await syncContactCrm("contact_1");
  assert.equal(result.ok, false);
  assert.equal(result.error, "No pudimos sincronizar con el CRM. Intenta de nuevo.");
});

test("syncContactCrm rechaza sin sesión, a otro tenant y al viewer, sin tocar el CRM", async () => {
  for (const [member, error] of [
    [{ ok: false, status: 401 }, "No autorizado"],
    [{ ok: false, status: 403, reason: "not_member" }, "No encontramos el contacto"],
    [{ ok: false, status: 403, reason: "insufficient_role" }, "Tu rol solo permite ver el contacto, no editarlo"],
  ] as const) {
    reset();
    memberResult = member;
    const result = await syncContactCrm("contact_1");
    assert.equal(result.ok, false);
    assert.equal(result.error, error);
    assert.deepEqual(manualCalls, []);
  }
});

test("syncContactCrm con un contacto inexistente no toca el CRM", async () => {
  reset();
  const result = await syncContactCrm("no-existe");
  assert.equal(result.ok, false);
  assert.equal(result.error, "No encontramos el contacto");
  assert.deepEqual(manualCalls, []);
});

// ── updateContact → CRM ──────────────────────────────────────────────────────

test("updateContact entrega el sync a after() y empuja el perfil solo si cambió", async () => {
  reset();
  const result = await updateContact("contact_1", { name: "Ana María" });
  assert.equal(result.ok, true);
  assert.equal(afterTasks.length, 1, "el sync quedó en manos de after");
  assert.deepEqual(syncCalls, [], "nada salió por fuera de after");
  await runAfter();
  assert.deepEqual(syncCalls, [{ ws: "ws_1", contactId: "contact_1", opts: { pushProfile: true } }]);
});

test("updateContact: reenviar el mismo nombre con otra etapa sincroniza sin empujar el perfil", async () => {
  reset();
  await updateContact("contact_1", { name: "Ana", stage: "qualified" });
  await runAfter();
  assert.deepEqual(syncCalls.map((c) => c.opts), [{}]);
});

test("updateContact manda las etiquetas como delta: altas juntas, cada baja aparte", async () => {
  reset();
  contacts[0].tags = ["a", "b"];
  await updateContact("contact_1", { tags: ["b", "c", "d"] });
  await runAfter();
  assert.deepEqual(syncCalls.map((c) => c.opts), [{ addTags: ["c", "d"] }, { removeTag: "a" }]);
});

test("updateContact rechazado por validación no agenda ningún sync", async () => {
  reset();
  const result = await updateContact("contact_1", { email: "no-es-email" });
  assert.equal(result.ok, false);
  assert.equal(afterTasks.length, 0);
});

test("updateContact de un contacto que no se ve (otro tenant por RLS) falla sin sync", async () => {
  reset();
  const result = await updateContact("otro", { name: "X" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "Error al actualizar el contacto");
  assert.equal(afterTasks.length, 0);
});
