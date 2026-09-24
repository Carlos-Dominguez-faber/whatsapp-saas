import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { NextRequest } from "next/server";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

// ── Cliente de sesión: auth + membresía ──────────────────────────────────────
let authUser: unknown = { id: "user_1" };
let memberRow: unknown = { role: "admin" };

const fakeSession = {
  auth: {
    getUser: async () => ({ data: { user: authUser }, error: null }),
  },
  from: () => ({
    select: () => ({
      eq: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: memberRow, error: null }),
        }),
      }),
    }),
  }),
};

mock.module("@/lib/supabase/server.ts", {
  exports: { createClient: async () => fakeSession },
});

// ── Cliente service-role ─────────────────────────────────────────────────────
// `versionUpdateRows` es lo que devuelve el primer UPDATE (prompt_versions →
// published) tras el .select("id"): vacío simula "no pertenece a este
// workspace". `updatedFilters` registra, por tabla, los pares [col, val]
// reales que cada UPDATE aplicó — si alguien borra el
// `.eq("workspace_id", …)` esto lo detecta.
let versionUpdateRows: Array<{ id: string }> = [{ id: "version_1" }];
const updatedFilters: Record<string, unknown[][][]> = {
  prompt_versions: [],
  prompts: [],
};

function updateChain(table: string, resolveValue: () => unknown) {
  const filters: unknown[][] = [];
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    eq: (col: string, val: unknown) => {
      filters.push(["eq", col, val]);
      return chain;
    },
    neq: (col: string, val: unknown) => {
      filters.push(["neq", col, val]);
      return chain;
    },
    select: () => {
      updatedFilters[table].push(filters);
      return Promise.resolve(resolveValue());
    },
    // El tercer UPDATE (demote) no encadena .select(): resuelve directo.
    then: (resolve: (v: unknown) => void) => {
      updatedFilters[table].push(filters);
      resolve(resolveValue());
    },
  });
  return chain;
}

const fakeSvc = {
  from: (table: string) => ({
    update: () => {
      if (table === "prompt_versions") {
        // Dos updates distintos comparten la tabla: el de publish (con
        // .select) y el demote (con .then). Distinguimos por si el caller
        // encadena .select() o no — ambos casos ya están cubiertos arriba
        // porque el chain expone las dos formas.
        return updateChain("prompt_versions", () => ({
          data: versionUpdateRows,
          error: null,
        }));
      }
      return updateChain("prompts", () => ({ data: null, error: null }));
    },
  }),
};

mock.module("@supabase/supabase-js", {
  exports: { createClient: () => fakeSvc },
});

const { PATCH } = await import("./route.ts");

const WORKSPACE_A = "ws_a";
const PROMPT_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";

function patchReq(body: unknown) {
  return new NextRequest("http://localhost/api/workspace/ws_a/prompts", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const params = { params: Promise.resolve({ id: WORKSPACE_A }) };

function reset() {
  authUser = { id: "user_1" };
  memberRow = { role: "admin" };
  versionUpdateRows = [{ id: "version_1" }];
  updatedFilters.prompt_versions.length = 0;
  updatedFilters.prompts.length = 0;
}

test("PATCH: admin de A publica un prompt de A -> 200", async () => {
  reset();
  const res = await PATCH(
    patchReq({ promptId: PROMPT_ID, versionId: VERSION_ID }),
    params,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { success: true });

  // El primer UPDATE (prompt_versions -> published) filtró por workspace_id.
  assert.equal(updatedFilters.prompt_versions.length, 2, "publish + demote");
  const publishFilters = updatedFilters.prompt_versions[0];
  assert.deepEqual(publishFilters, [
    ["eq", "id", VERSION_ID],
    ["eq", "prompt_id", PROMPT_ID],
    ["eq", "workspace_id", WORKSPACE_A],
  ]);

  // El UPDATE de prompts.active_version_id también filtró por workspace_id.
  assert.equal(updatedFilters.prompts.length, 1);
  assert.deepEqual(updatedFilters.prompts[0], [
    ["eq", "id", PROMPT_ID],
    ["eq", "workspace_id", WORKSPACE_A],
  ]);

  // El tercer UPDATE (demote de las otras versiones a draft) también filtró
  // por workspace_id — sin ese filtro, un admin de A podría degradar
  // versiones de un prompt de otro workspace con el mismo id.
  const demoteFilters = updatedFilters.prompt_versions[1];
  assert.deepEqual(demoteFilters, [
    ["eq", "prompt_id", PROMPT_ID],
    ["eq", "workspace_id", WORKSPACE_A],
    ["neq", "id", VERSION_ID],
  ]);
});

test("IDOR cruzado: admin de A publica ids del workspace B -> 404, y no toca prompts", async () => {
  reset();
  versionUpdateRows = []; // el filtro workspace_id no matcheó ninguna fila
  const res = await PATCH(
    patchReq({ promptId: PROMPT_ID, versionId: VERSION_ID }),
    params,
  );
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.deepEqual(body, {
    error: "No se encontró el prompt o la versión indicada",
  });

  // No se ejecutó el UPDATE sobre prompts: active_version_id de B intacto.
  assert.equal(
    updatedFilters.prompts.length,
    0,
    "no debe tocar prompts.active_version_id cuando el primer UPDATE afecta 0 filas",
  );
});

test("sin sesion responde 401", async () => {
  reset();
  authUser = null;
  const res = await PATCH(
    patchReq({ promptId: PROMPT_ID, versionId: VERSION_ID }),
    params,
  );
  assert.equal(res.status, 401);
});

test("rol agent (sin permiso admin/manager) responde 403", async () => {
  reset();
  memberRow = { role: "agent" };
  const res = await PATCH(
    patchReq({ promptId: PROMPT_ID, versionId: VERSION_ID }),
    params,
  );
  assert.equal(res.status, 403);
});

test("body invalido: falta versionId responde 400", async () => {
  reset();
  const res = await PATCH(patchReq({ promptId: PROMPT_ID }), params);
  assert.equal(res.status, 400);
});

test("body invalido: promptId no es uuid responde 400", async () => {
  reset();
  const res = await PATCH(
    patchReq({ promptId: "not-a-uuid", versionId: VERSION_ID }),
    params,
  );
  assert.equal(res.status, 400);
});
