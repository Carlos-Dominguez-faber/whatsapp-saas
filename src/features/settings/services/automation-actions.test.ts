import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

// `revalidatePath` toca el runtime de Next; acá solo tiene que no explotar.
mock.module("next/cache", { exports: { revalidatePath: () => {} } });

// ── Cliente de sesión: assertAdminOrManager ─────────────────────────────────
const fakeSession = {
  auth: {
    getUser: async () => ({ data: { user: { id: "user_1" } }, error: null }),
  },
  from: () => ({
    select: () => ({
      eq: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { role: "admin" }, error: null }),
        }),
      }),
    }),
  }),
};

mock.module("@/lib/supabase/server.ts", {
  exports: { createClient: async () => fakeSession },
});

// ── Cliente service-role ─────────────────────────────────────────────────────
let activeCount = 0;
let countError: unknown = null;
let countThrows: unknown = null;
let countCalls: unknown[][][] = [];
const inserted: unknown[] = [];
const updated: unknown[] = [];

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
      // Simula un `db.from(...)` que LANZA en vez de devolver `{ error }`
      // (falla de red en el fetch, cliente mal armado): distinto camino del
      // helper, mismo fail-closed esperado (Finding 1 de la revisión).
      if (countThrows) throw countThrows;
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
          single: async () => ({
            data: { id: "rule_new", ...(row as object) },
            error: null,
          }),
        }),
      };
    },
    update: (row: unknown) => {
      updated.push(row);
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        eq: () => chain,
        select: () => ({
          single: async () => ({
            data: { id: "rule_1", ...(row as object) },
            error: null,
          }),
        }),
      });
      return chain;
    },
  }),
};

mock.module("@supabase/supabase-js", {
  exports: { createClient: () => fakeSvc },
});

const { saveAutomationRule, toggleAutomationRule } = await import(
  "./automation-actions.ts"
);
const { MAX_ACTIVE_RULES_PER_WORKSPACE, RuleCapError } = await import(
  "@/features/automations/services/rule-cap.ts"
);

const CAP_MESSAGE = new RuleCapError().message;
// El schema (rule-schema.ts, zod v4 `z.uuid()`) exige el nibble de variante
// (8/9/a/b) en el cuarto grupo — "11111111-1111-1111-1111-111111111111" no
// valida ahí. Verificado antes de escribir este archivo (no está en el brief).
const RULE_ID = "11111111-1111-4111-8111-111111111111";

const VALID_RULE = {
  name: "regla nueva",
  enabled: true,
  trigger_type: "first_message" as const,
  trigger_config: {},
  action_type: "add_tag" as const,
  action_config: { tag: "nuevo" },
};

function reset() {
  activeCount = 0;
  countError = null;
  countThrows = null;
  countCalls = [];
  inserted.length = 0;
  updated.length = 0;
}

test("saveAutomationRule: crear habilitada con 20 activas se rechaza", async () => {
  reset();
  activeCount = MAX_ACTIVE_RULES_PER_WORKSPACE;
  const res = await saveAutomationRule("ws_1", VALID_RULE);
  assert.equal(res.error, CAP_MESSAGE);
  assert.equal(res.data, undefined);
  assert.equal(inserted.length, 0, "no debe insertar cuando rechaza");

  // Camino correcto con el mismo código: con 19 activas sí crea.
  reset();
  activeCount = MAX_ACTIVE_RULES_PER_WORKSPACE - 1;
  const ok = await saveAutomationRule("ws_1", VALID_RULE);
  assert.equal(ok.error, undefined);
  assert.equal(inserted.length, 1);
});

test("toggleAutomationRule: activar con 20 activas se rechaza", async () => {
  reset();
  activeCount = MAX_ACTIVE_RULES_PER_WORKSPACE;
  const res = await toggleAutomationRule("ws_1", RULE_ID, true);
  assert.equal(res.error, CAP_MESSAGE);
  assert.equal(updated.length, 0);

  // Camino correcto: con 19 activas el toggle pasa.
  reset();
  activeCount = MAX_ACTIVE_RULES_PER_WORKSPACE - 1;
  const ok = await toggleAutomationRule("ws_1", RULE_ID, true);
  assert.equal(ok.error, undefined);
  assert.equal(updated.length, 1);
});

test("saveAutomationRule: editar una regla ya activa no cuenta contra sí misma", async () => {
  reset();
  activeCount = MAX_ACTIVE_RULES_PER_WORKSPACE - 1; // 19 SIN contar esta
  const res = await saveAutomationRule("ws_1", { ...VALID_RULE, id: RULE_ID });
  assert.equal(res.error, undefined);
  assert.deepEqual(countCalls[0], [
    ["eq", "workspace_id", "ws_1"],
    ["eq", "enabled", true],
    ["neq", "id", RULE_ID],
  ]);
  assert.equal(updated.length, 1);
});

test("saveAutomationRule: si el conteo devuelve error, falla cerrado y no inserta", async () => {
  reset();
  countError = { message: "boom" };
  const errSpy = mock.method(console, "error", () => {});
  try {
    const res = await saveAutomationRule("ws_1", VALID_RULE);
    assert.equal(
      res.error,
      "No se pudo guardar la automatización. Intenta de nuevo.",
    );
    assert.equal(inserted.length, 0, "fail-closed: no debe insertar sin conteo");
  } finally {
    errSpy.mock.restore();
  }
});

test("toggleAutomationRule: si el conteo devuelve error, falla cerrado y no actualiza", async () => {
  reset();
  countError = { message: "boom" };
  const errSpy = mock.method(console, "error", () => {});
  try {
    const res = await toggleAutomationRule("ws_1", RULE_ID, true);
    assert.equal(
      res.error,
      "No se pudo guardar la automatización. Intenta de nuevo.",
    );
    assert.equal(updated.length, 0, "fail-closed: no debe actualizar sin conteo");
  } finally {
    errSpy.mock.restore();
  }
});

test("saveAutomationRule: si el conteo LANZA (no devuelve error), igual falla cerrado y el detalle se loguea", async () => {
  reset();
  countThrows = new Error("network down");
  const errSpy = mock.method(console, "error", () => {});
  try {
    const res = await saveAutomationRule("ws_1", VALID_RULE);
    assert.equal(
      res.error,
      "No se pudo guardar la automatización. Intenta de nuevo.",
    );
    assert.equal(inserted.length, 0, "fail-closed también cuando el conteo lanza");
    const logged = errSpy.mock.calls.some((c) =>
      String(c.arguments[0]).includes(
        "[automations] failed to count active rules",
      ),
    );
    assert.ok(
      logged,
      "el helper debe loguear el detalle técnico aunque el conteo haya lanzado",
    );
  } finally {
    errSpy.mock.restore();
  }
});

test("toggleAutomationRule: enabled no booleano se rechaza sin tocar la base", async () => {
  reset();
  // @ts-expect-error — probando el caso de un caller que no respeta el tipo.
  const res = await toggleAutomationRule("ws_1", RULE_ID, "false");
  assert.equal(res.error, "El estado de la automatización no es válido");
  assert.equal(countCalls.length, 0, "no debe ni consultar el tope");
  assert.equal(updated.length, 0);
});

test("deshabilitar siempre pasa, aunque el workspace esté al tope", async () => {
  reset();
  activeCount = MAX_ACTIVE_RULES_PER_WORKSPACE;

  const off = await toggleAutomationRule("ws_1", RULE_ID, false);
  assert.equal(off.error, undefined);
  assert.equal(countCalls.length, 0, "deshabilitar no consulta el tope");

  const saved = await saveAutomationRule("ws_1", { ...VALID_RULE, enabled: false });
  assert.equal(saved.error, undefined);
  assert.equal(countCalls.length, 0, "guardar deshabilitada tampoco lo consulta");
});
