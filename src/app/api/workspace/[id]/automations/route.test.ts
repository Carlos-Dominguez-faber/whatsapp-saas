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
// `activeCount` es lo que devuelve el conteo de reglas habilitadas del
// workspace. `countCalls` guarda los filtros para poder afirmar que el PATCH
// excluye la propia regla.
let activeCount = 0;
let countError: unknown = null;
let countCalls: Array<Array<unknown[]>> = [];
const inserted: unknown[] = [];
const updated: unknown[] = [];
// Filtros reales que cada UPDATE aplicó (un array por llamada), en el mismo
// patrón que `deleted` de más abajo: si alguien borra el
// `.eq("workspace_id", …)` del PATCH, esto lo detecta.
const updatedFilters: unknown[][][] = [];
const deleted: unknown[] = [];
let deleteError: unknown = null;

function countChain() {
  const filters: unknown[][] = [];
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    eq(col: string, val: unknown) {
      filters.push(["eq", col, val]);
      return chain;
    },
    neq(col: string, val: unknown) {
      filters.push(["neq", col, val]);
      return chain;
    },
    then(resolve: (v: unknown) => void) {
      countCalls.push(filters);
      resolve({ data: null, count: activeCount, error: countError });
    },
  });
  return chain;
}

const fakeSvc = {
  from: () => ({
    select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
      if (opts?.head) return countChain();
      return { single: async () => ({ data: { id: "rule_x" }, error: null }) };
    },
    insert: (row: unknown) => {
      inserted.push(row);
      return {
        select: () => ({
          single: async () => ({ data: { id: "rule_new", ...(row as object) }, error: null }),
        }),
      };
    },
    update: (row: unknown) => {
      updated.push(row);
      // Mismo patrón que `delete()` de más abajo: los `.eq()` registran
      // `[col, val]` reales en vez de aceptar cualquier argumento. Acá no se
      // resuelve al segundo `.eq()` (la ruta encadena `.select().single()`
      // después), así que se acumulan los filtros y se registran recién al
      // resolver, en `updatedFilters`.
      const filters: unknown[][] = [];
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          return chain;
        },
        select: () => ({
          single: async () => {
            updatedFilters.push(filters);
            return { data: { id: "rule_1", ...(row as object) }, error: null };
          },
        }),
      });
      return chain;
    },
    delete: () => {
      const filters: unknown[][] = [];
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          // El DELETE encadena dos .eq() (id y workspace_id);
          // recién con el segundo se resuelve, como hace supabase-js real.
          if (filters.length < 2) return chain;
          deleted.push(filters);
          return Promise.resolve({ error: deleteError });
        },
      });
      return chain;
    },
  }),
};

mock.module("@supabase/supabase-js", {
  exports: { createClient: () => fakeSvc },
});

const { GET, POST, PATCH, DELETE } = await import("./route.ts");
// La constante ya NO la exporta la ruta: vive en el helper compartido.
const { MAX_ACTIVE_RULES_PER_WORKSPACE, RuleCapError } = await import(
  "@/features/automations/services/rule-cap.ts"
);

const params = { params: Promise.resolve({ id: "ws_1" }) };
// El mensaje sale de la clase, no de un literal copiado: si alguien lo reescribe
// en rule-cap.ts, estos tests siguen valiendo.
const LIMIT_MESSAGE = new RuleCapError().message;

// El helper de UUID de este repo (AutomationRuleUpdateSchema, zod v4 `z.uuid()`)
// exige el nibble de variante (8/9/a/b) en el cuarto grupo — una cadena de puros
// "1" como "11111111-1111-1111-1111-111111111111" ya NO valida ahí. Verificado
// contra rule-schema.ts antes de escribir este archivo (no está en el brief).
const RULE_ID = "11111111-1111-4111-8111-111111111111";

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/workspace/ws_1/automations", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function patchReq(body: unknown) {
  return new NextRequest("http://localhost/api/workspace/ws_1/automations", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function deleteReq(body: unknown) {
  return new NextRequest("http://localhost/api/workspace/ws_1/automations", {
    method: "DELETE",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const VALID_RULE = {
  name: "regla nueva",
  trigger_type: "first_message",
  action_type: "add_tag",
  action_config: { tag: "nuevo" },
};

function reset() {
  authUser = { id: "user_1" };
  memberRow = { role: "admin" };
  activeCount = 0;
  countError = null;
  countCalls = [];
  inserted.length = 0;
  updated.length = 0;
  updatedFilters.length = 0;
  deleted.length = 0;
  deleteError = null;
}

test("la constante del tope es 20", () => {
  assert.equal(MAX_ACTIVE_RULES_PER_WORKSPACE, 20);
});

test("POST: la regla 20 activa pasa", async () => {
  reset();
  activeCount = 19; // ya hay 19; esta sería la 20ª
  const res = await POST(postReq(VALID_RULE), params);
  assert.equal(res.status, 201);
  assert.equal(inserted.length, 1);
});

test("POST: la regla 21 se rechaza con 422 y el mensaje en español", async () => {
  reset();
  activeCount = 20;
  const res = await POST(postReq(VALID_RULE), params);
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.error, LIMIT_MESSAGE);
  assert.equal(inserted.length, 0, "no debe insertar cuando rechaza");
});

test("POST: enabled:false no cuenta contra el tope", async () => {
  reset();
  activeCount = 20; // el workspace ya está en el tope
  const res = await POST(postReq({ ...VALID_RULE, enabled: false }), params);
  assert.equal(res.status, 201);
  assert.equal(countCalls.length, 0, "una regla deshabilitada ni siquiera cuenta");
});

test("POST: el conteo filtra por workspace y por enabled", async () => {
  reset();
  activeCount = 0;
  await POST(postReq(VALID_RULE), params);
  assert.deepEqual(countCalls[0], [
    ["eq", "workspace_id", "ws_1"],
    ["eq", "enabled", true],
  ]);
});

test("POST: enabled no booleano se rechaza con 400, no con 422", async () => {
  reset();
  activeCount = 0;
  const res = await POST(postReq({ ...VALID_RULE, enabled: "yes" }), params);
  assert.equal(res.status, 400);
  assert.equal(inserted.length, 0);
});

test("POST: si el conteo falla, responde 500 y no inserta", async () => {
  reset();
  countError = { message: "boom" };
  const errSpy = mock.method(console, "error", () => {});
  try {
    const res = await POST(postReq(VALID_RULE), params);
    assert.equal(res.status, 500);
    assert.equal(inserted.length, 0, "fail-closed: sin conteo no se crea la regla");
  } finally {
    errSpy.mock.restore();
  }
});

test("PATCH: si el conteo falla, responde 500 y no actualiza", async () => {
  reset();
  countError = { message: "boom" };
  const errSpy = mock.method(console, "error", () => {});
  try {
    const res = await PATCH(
      patchReq({ ...VALID_RULE, id: RULE_ID, enabled: true }),
      params,
    );
    assert.equal(res.status, 500);
    assert.equal(updated.length, 0, "fail-closed: sin conteo no se actualiza la regla");
  } finally {
    errSpy.mock.restore();
  }
});

test("GET: sin usuario autenticado responde 401", async () => {
  reset();
  authUser = null;
  const req = new NextRequest(
    "http://localhost/api/workspace/ws_1/automations",
  );
  const res = await GET(req, params);
  assert.equal(res.status, 401);
});

test("POST: rol agent (sin permiso admin/manager) responde 403", async () => {
  reset();
  memberRow = { role: "agent" };
  const res = await POST(postReq(VALID_RULE), params);
  assert.equal(res.status, 403);
  assert.equal(inserted.length, 0);
});

// ── PATCH ─────────────────────────────────────────────────────────────────────
// Nota: PATCH no acepta updates parciales — valida con
// AutomationRuleUpdateSchema, que exige la regla COMPLETA (incluido `id`).
// Los payloads de abajo llevan siempre el objeto entero; mandar solo
// `{ id, enabled }` o `{ id, name }` fallaría 400 por faltarle
// trigger_type/action_type, no por el tope.

test("PATCH: reactivar la 21ª se rechaza con 422", async () => {
  reset();
  activeCount = 20;
  const res = await PATCH(
    patchReq({ ...VALID_RULE, id: RULE_ID, enabled: true }),
    params,
  );
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.error, LIMIT_MESSAGE);
  assert.equal(updated.length, 0);
});

test("PATCH: el conteo excluye la propia regla (deshabilitar y reactivar libera cupo)", async () => {
  reset();
  activeCount = 19; // 19 activas SIN contar esta
  const res = await PATCH(
    patchReq({ ...VALID_RULE, id: RULE_ID, enabled: true }),
    params,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(countCalls[0], [
    ["eq", "workspace_id", "ws_1"],
    ["eq", "enabled", true],
    ["neq", "id", RULE_ID],
  ]);
});

test("PATCH: renombrar una regla activa corre el tope (excluyéndose a sí misma) y no la bloquea si hay cupo", async () => {
  // El schema completo siempre trae `enabled` (con default `true` si el body
  // no lo manda explícito — BaseFields en rule-schema.ts), así que un PATCH
  // que solo cambia el nombre no puede distinguirse de uno que reafirma
  // enabled:true. La regla activa se excluye de su propio conteo, así que
  // renombrarla nunca se rechaza salvo que YA existan 20 activas aparte de
  // esta (ventana de carrera aceptada, ver rule-cap.ts). Se fija el workspace AL TOPE
  // (sin contar esta regla) para que el 200 pruebe algo: con activeCount bajo
  // el 200 sería trivial y no distinguiría "excluye a sí misma" de "nunca
  // llega a consultar el tope".
  reset();
  activeCount = MAX_ACTIVE_RULES_PER_WORKSPACE - 1; // el workspace queda lleno
  const res = await PATCH(
    patchReq({ ...VALID_RULE, id: RULE_ID, name: "otro nombre" }),
    params,
  );
  assert.equal(res.status, 200);
  assert.equal(countCalls.length, 1, "el payload completo trae enabled implícito, sí consulta el tope");
  assert.equal(updated.length, 1);
});

test("PATCH: deshabilitar nunca se rechaza, aunque el workspace esté al tope", async () => {
  reset();
  activeCount = 20;
  const res = await PATCH(
    patchReq({ ...VALID_RULE, id: RULE_ID, enabled: false }),
    params,
  );
  assert.equal(res.status, 200);
  assert.equal(countCalls.length, 0);
});

test("PATCH: es full-replace — omitir enabled REACTIVA la regla, no la deja como estaba", async () => {
  // CONTRATO DELIBERADO, no un bug: el PATCH reemplaza la regla entera contra
  // `AutomationRuleUpdateSchema`, cuyo `enabled` es `z.boolean().default(true)`
  // (BaseFields en rule-schema.ts). Omitir el campo NO es "dejalo como está",
  // es "ponelo en el default", así que un PATCH que solo cambia el nombre de
  // una regla DESHABILITADA la deja habilitada y escribiendo.
  //
  // No es alcanzable desde la UI: automation-rule-form.tsx:172-175 siempre
  // manda `enabled` explícito. Solo se llega por HTTP directo.
  //
  // Este test existe para que el comportamiento sea una decisión y no un
  // accidente: si alguien lo ve raro y quiere que omitir `enabled` preserve el
  // valor actual, eso es cambiar el contrato del endpoint (PATCH parcial en vez
  // de full-replace) y se decide antes de tocar el schema. Que este test se
  // ponga rojo es la señal de que se cambió sin decidirlo.
  // VALID_RULE no trae `enabled`: el body es el de un edit que solo renombra.
  // La regla en la base está deshabilitada; da igual, la ruta no la lee.
  reset();
  const res = await PATCH(
    patchReq({ ...VALID_RULE, id: RULE_ID, name: "solo cambié el nombre" }),
    params,
  );
  assert.equal(res.status, 200);
  assert.equal(updated.length, 1);
  assert.equal(
    (updated[0] as { enabled?: unknown }).enabled,
    true,
    "full-replace: sin `enabled` en el body, la ruta escribe el default `true`",
  );
});

test("PATCH: el UPDATE filtra por id Y por workspace_id (aislamiento entre tenants)", async () => {
  reset();
  const res = await PATCH(
    patchReq({ ...VALID_RULE, id: RULE_ID, enabled: false }),
    params,
  );
  assert.equal(res.status, 200);
  assert.equal(updatedFilters.length, 1);
  assert.deepEqual(
    updatedFilters[0],
    [
      ["id", RULE_ID],
      ["workspace_id", "ws_1"],
    ],
    "el PATCH debe filtrar por id Y por workspace_id (aislamiento entre tenants)",
  );
});

test("PATCH: enabled no booleano se rechaza con 400", async () => {
  reset();
  const res = await PATCH(
    patchReq({ ...VALID_RULE, id: RULE_ID, enabled: "yes" }),
    params,
  );
  assert.equal(res.status, 400);
  assert.equal(updated.length, 0);
});

// ── DELETE ────────────────────────────────────────────────────────────────────

test("DELETE: id válido borra la regla", async () => {
  reset();
  const res = await DELETE(deleteReq({ id: RULE_ID }), params);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { success: true });
  assert.equal(deleted.length, 1);
  assert.deepEqual(
    deleted[0],
    [
      ["id", RULE_ID],
      ["workspace_id", "ws_1"],
    ],
    "el DELETE debe filtrar por id Y por workspace_id (aislamiento entre tenants)",
  );
});

test("DELETE: rol agent (sin permiso admin/manager) responde 403", async () => {
  reset();
  memberRow = { role: "agent" };
  const res = await DELETE(deleteReq({ id: RULE_ID }), params);
  assert.equal(res.status, 403);
  assert.equal(deleted.length, 0);
});

test("DELETE con id inválido responde 400 con un string en español, no el fieldErrors crudo de zod", async () => {
  reset();
  const res = await DELETE(deleteReq({ id: "x" }), params);
  assert.equal(res.status, 400);
  const body = await res.json();
  // Antes del fix: body.error era { fieldErrors: { id: ["Invalid UUID"] } }.
  // Con firstErrorMessage (mismo patrón que POST/PATCH), es un string y
  // "Invalid UUID" (mensaje genérico de zod) queda filtrado por el copy en
  // español de rule-schema.ts.
  assert.equal(typeof body.error, "string");
  assert.equal(body.error, "Revisa los datos de la regla");
  assert.equal(deleted.length, 0, "no debe borrar cuando rechaza la validación");
});

test("DELETE: sin usuario autenticado responde 401", async () => {
  reset();
  authUser = null;
  const res = await DELETE(deleteReq({ id: RULE_ID }), params);
  assert.equal(res.status, 401);
  assert.equal(deleted.length, 0);
});
