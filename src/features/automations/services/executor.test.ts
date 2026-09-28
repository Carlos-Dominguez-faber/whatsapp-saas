import assert from "node:assert/strict";
import { test, mock } from "node:test";
import type { AutomationRun } from "./executor.ts";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

type Row = Record<string, unknown> | null;

// ── Fake de supabase-js ───────────────────────────────────────────────────────
//
// El fake APLICA los `.eq` / `.is` como Postgres, no los ignora. Es la única
// forma de que un test de aislamiento muerda: con un fake que descarta los
// argumentos, borrar `.eq("workspace_id", …)` deja la suite entera en verde.
// Cada filtro se registra además en `selectFilters` / `updates[].filters` para
// poder afirmar sobre el filtro mismo y no solo sobre el resultado.

let ruleRow: Row = null;
let conversationRow: Row = null;
let contactRow: Row = null;
let memberRow: Row = null;
/**
 * Lo que devuelve la RELECTURA de `automation_runs`, el único SELECT que el
 * ejecutor hace sobre su propia tabla: desambiguar el `not_found` de la RPC de
 * despacho. `null` = la fila ya no está en `processing` (o no existe).
 */
let runRow: Row = null;
/**
 * Lo que devuelve el SELECT de `automation_events` que resuelve
 * `subject_id` (`resolveAppointmentSubjectId`). Solo se consulta
 * cuando `run.trigger_type === "appointment_upcoming"`.
 */
let eventRow: Row = null;

/** Tablas cuyo SELECT devuelve error de base. */
let readErrorTables = new Set<string>();
/** Tablas cuyo INSERT devuelve error — hoy solo se usa para `events`. */
let insertErrorTables = new Set<string>();
/** false ⇒ el UPDATE con condición de lease afecta 0 filas. */
let leaseHeld = true;
/**
 * El UPDATE de `automation_runs` devuelve error. Distinto de
 * `leaseHeld = false`, que devuelve 0 filas SIN error.
 */
let runUpdateError: string | null = null;
/**
 * Cuántas filas devuelve el UPDATE de conversations con `assigned_to IS NULL`.
 * 1 = se asignó; 0 = ya tenía dueño (o no existe) y el ejecutor relee.
 */
let assignUpdateRows = 1;
/** La conversación se borra ENTRE la carga y el UPDATE de assign_agent. */
let deleteConversationOnAssign = false;
/** Filas que afecta el UPDATE que apaga la regla tras 132015. */
let disableRuleUpdateRows = 1;
/** El UPDATE que apaga la regla devuelve error de base. */
let disableRuleUpdateError: string | null = null;
/** Lo que devuelve `mark_automation_run_dispatched`. */
let dispatchClaim = "ok";
let dispatchRpcError: string | null = null;
/** Error de la RPC del claim, para el corte del drenaje. */
let claimRpcError: { message: string } | null = null;
/** Reclamos que salen BIEN antes de que empiece a fallar `claimRpcError`. */
let claimOkBeforeError = 0;
/** Filas que sirve `claim_next_automation_run()`, en orden. */
let claimQueue: Array<Record<string, unknown>> = [];

interface UpdateCall {
  table: string;
  row: Record<string, unknown>;
  filters: Array<[string, unknown]>;
  /** Los `.is(columna, valor)` — es donde vive el `assigned_to IS NULL`. */
  isArgs: Array<[string, unknown]>;
}

const updates: UpdateCall[] = [];
/** UPDATEs de automation_runs que REALMENTE escribieron (sin error y con fila). */
const successfulRunUpdates: UpdateCall[] = [];
const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
const selectFilters: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
const selectOrders: Array<{ table: string; column: string; options: unknown }> = [];
/**
 * Columnas pedidas en cada `select(cols)`. Si el fake ignorara `cols` y
 * devolviera la fila entera pasara lo que pasara, cambiar lo que pide el
 * select de `executor.ts` no rompería ningún test. Este registro es lo único
 * que puede notar esa regresión, porque el fake no proyecta columnas de verdad.
 */
const selectColumns: Array<{ table: string; columns: unknown }> = [];
const rpcCalls: Array<{ fn: string; args: unknown }> = [];
/** Orden real de los efectos, para fijar preparar → marcar → enviar. */
const callLog: string[] = [];

function rowFor(table: string): Row {
  if (table === "automation_rules") return ruleRow;
  if (table === "conversations") return conversationRow;
  if (table === "contacts") return contactRow;
  if (table === "memberships") return memberRow;
  if (table === "automation_runs") return runRow;
  if (table === "automation_events") return eventRow;
  return null;
}

function updateResponse(table: string, row: Record<string, unknown>) {
  if (table === "automation_runs") {
    if (runUpdateError) {
      return { data: null, error: { message: runUpdateError }, wrote: false };
    }
    return {
      data: leaseHeld ? [{ id: "run_1" }] : [],
      error: null,
      wrote: leaseHeld,
    };
  }
  if (table === "automation_rules" && row.enabled === false) {
    if (disableRuleUpdateError) {
      return { data: null, error: { message: disableRuleUpdateError }, wrote: false };
    }
    return {
      data: disableRuleUpdateRows > 0 ? [{ id: "rule_1" }] : [],
      error: null,
      wrote: disableRuleUpdateRows > 0,
    };
  }
  if (table === "conversations" && row.assigned_to) {
    return {
      data: assignUpdateRows === 1 ? [{ id: "conv_1" }] : [],
      error: null,
      wrote: assignUpdateRows === 1,
    };
  }
  return { data: null, error: null, wrote: true };
}

const fakeClient = {
  from(table: string) {
    return {
      select(cols?: unknown) {
        selectColumns.push({ table, columns: cols });
        const filters: Array<[string, unknown]> = [];
        const passes = (row: Record<string, unknown>) =>
          filters.every(([column, value]) => row[column] === value);
        const chain: Record<string, unknown> = {};
        Object.assign(chain, {
          eq: (c: string, v: unknown) => {
            filters.push([c, v]);
            return chain;
          },
          is: (c: string, v: unknown) => {
            filters.push([c, v]);
            return chain;
          },
          order: (column: string, options: unknown) => {
            selectOrders.push({ table, column, options });
            return chain;
          },
          // Terminador de la única consulta que devuelve un ARRAY: la búsqueda
          // de la conversación por contacto (lead_qualified).
          limit: async (n: number) => {
            selectFilters.push({ table, filters });
            if (readErrorTables.has(table)) {
              return { data: null, error: { message: "connection refused" } };
            }
            const row = rowFor(table);
            const rows = row && passes(row) ? [row] : [];
            return { data: rows.slice(0, n), error: null };
          },
          maybeSingle: async () => {
            selectFilters.push({ table, filters });
            if (readErrorTables.has(table)) {
              return { data: null, error: { message: "connection refused" } };
            }
            const row = rowFor(table);
            if (!row || !passes(row)) return { data: null, error: null };
            return { data: row, error: null };
          },
        });
        return chain;
      },
      update(row: Record<string, unknown>) {
        const call: UpdateCall = { table, row, filters: [], isArgs: [] };
        const settle = () => {
          updates.push(call);
          const response = updateResponse(table, row);
          if (table === "automation_runs" && response.wrote) {
            successfulRunUpdates.push(call);
          }
          if (table === "conversations" && row.assigned_to && deleteConversationOnAssign) {
            conversationRow = null;
          }
          return { data: response.data, error: response.error };
        };
        const chain: Record<string, unknown> = {};
        Object.assign(chain, {
          eq: (c: string, v: unknown) => {
            call.filters.push([c, v]);
            return chain;
          },
          is: (c: string, v: unknown) => {
            call.isArgs.push([c, v]);
            return chain;
          },
          select() {
            return {
              then(resolve: (v: unknown) => void) {
                resolve(settle());
              },
            };
          },
          then(resolve: (v: unknown) => void) {
            resolve(settle());
          },
        });
        return chain;
      },
      insert(row: Record<string, unknown>) {
        inserts.push({ table, row });
        return {
          then(resolve: (v: unknown) => void) {
            resolve(
              insertErrorTables.has(table)
                ? { data: null, error: { message: "events insert failed" } }
                : { data: null, error: null },
            );
          },
        };
      },
    };
  },
  rpc(fn: string, args?: unknown) {
    rpcCalls.push({ fn, args });
    if (fn === "mark_automation_run_dispatched") {
      callLog.push("markDispatched");
      return Promise.resolve(
        dispatchRpcError
          ? { data: null, error: { message: dispatchRpcError } }
          : { data: dispatchClaim, error: null },
      );
    }
    const row = claimQueue.shift() ?? null;
    // `claimOkBeforeError` deja pasar N reclamos buenos antes de fallar, para
    // poder probar que el tally de lo ya ejecutado sobrevive al fallo de fase.
    const error = claimOkBeforeError > 0 ? null : claimRpcError;
    if (claimOkBeforeError > 0) claimOkBeforeError -= 1;
    return Promise.resolve({ data: row ? [row] : [], error });
  },
};

mock.module("@supabase/supabase-js", {
  exports: { createClient: () => fakeClient },
});

// ── Dependencias del ejecutor ────────────────────────────────────────────────

class FakeConfigError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ConfigError";
    this.code = code;
  }
}

class FakeTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransitionError";
  }
}

const tagCalls: unknown[] = [];
let tagImpl: (params: unknown) => Promise<boolean> = async () => true;
let handoffImpl: (params: unknown) => Promise<boolean> = async () => true;

mock.module("@/features/inbox/services/conversation-actions.ts", {
  exports: {
    ConfigError: FakeConfigError,
    addTagToContact: async (p: unknown) => {
      tagCalls.push(p);
      return tagImpl(p);
    },
    requestHandoff: async (p: unknown) => handoffImpl(p),
  },
});

const transitions: unknown[][] = [];
let transitionImpl: (...args: unknown[]) => Promise<void> = async () => {};

mock.module("@/features/inbox/services/decision-engine.ts", {
  exports: {
    TransitionError: FakeTransitionError,
    applyTransition: async (...args: unknown[]) => {
      transitions.push(args);
      await transitionImpl(...args);
    },
  },
});

const prepareCalls: unknown[] = [];
const sendCalls: unknown[] = [];
let prepareResult: Record<string, unknown> = {
  ok: true,
  prepared: { toPhone: "+15550000001", templateName: "bienvenida" },
};
let sendResult: Record<string, unknown> = { ok: true };

mock.module("@/features/inbox/services/dispatch.ts", {
  exports: {
    prepareTemplateDispatch: async (p: unknown) => {
      callLog.push("prepare");
      prepareCalls.push(p);
      return prepareResult;
    },
    sendPreparedTemplate: async (p: unknown) => {
      callLog.push("send");
      sendCalls.push(p);
      return sendResult;
    },
  },
});

const OK_CONTEXT = {
  ok: true,
  ctx: {
    contactName: "María",
    contactPhone: "+15550000001",
    businessName: "Vet Demo",
    appointment: null,
  },
};
let loadVariableContextImpl: () => Promise<unknown> = async () => OK_CONTEXT;
/** Params con los que se llamó a `loadVariableContext` en cada `executeRun`. */
const loadVariableContextCalls: unknown[] = [];

mock.module("./variables.ts", {
  exports: {
    loadVariableContext: async (params: unknown) => {
      loadVariableContextCalls.push(params);
      return loadVariableContextImpl();
    },
    resolveVariables: (vars: string[]) => vars.map((v) => `<${v}>`),
    buildTemplateComponents: (values: string[]) =>
      values.length
        ? [{ type: "body", parameters: values.map((text) => ({ type: "text", text })) }]
        : undefined,
  },
});

const { executeRun, drainAutomationRuns } = await import("./executor.ts");

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeRun(over: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: "run_1",
    workspace_id: "ws_1",
    rule_id: "rule_1",
    event_id: 42,
    trigger_type: "first_message",
    conversation_id: "conv_1",
    contact_id: "contact_1",
    status: "processing",
    attempts: 1,
    error: null,
    not_before: "2026-09-03T00:00:00.000Z",
    claimed_at: "2026-09-03T10:00:00.000Z",
    dispatched_at: null,
    finished_at: null,
    created_at: "2026-09-03T09:59:00.000Z",
    ...over,
  };
}

const ADD_TAG_RULE = {
  id: "rule_1",
  workspace_id: "ws_1",
  name: "Etiqueta al primer mensaje",
  action_type: "add_tag",
  action_config: { tag: "nuevo" },
  enabled: true,
};
const TEMPLATE_RULE = {
  id: "rule_1",
  workspace_id: "ws_1",
  name: "Bienvenida",
  action_type: "send_template",
  action_config: { template_name: "bienvenida", variables: ["{{contact.name}}"] },
  enabled: true,
};
const HANDOFF_RULE = {
  id: "rule_1",
  workspace_id: "ws_1",
  name: "Pasar a humano",
  action_type: "handoff_human",
  action_config: {},
  enabled: true,
};
const CLOSE_RULE = {
  id: "rule_1",
  workspace_id: "ws_1",
  name: "Cerrar",
  action_type: "close_conversation",
  action_config: {},
  enabled: true,
};
const ASSIGN_RULE = {
  id: "rule_1",
  workspace_id: "ws_1",
  name: "Asignar",
  action_type: "assign_agent",
  action_config: { user_id: "user_1" },
  enabled: true,
};
const APPOINTMENT_RULE = {
  id: "rule_1",
  workspace_id: "ws_1",
  name: "Recordatorio de cita",
  action_type: "send_template",
  action_config: {
    template_name: "recordatorio",
    variables: ["{{appointment.date}}", "{{appointment.time}}"],
  },
  enabled: true,
};

function reset() {
  updates.length = 0;
  successfulRunUpdates.length = 0;
  inserts.length = 0;
  selectFilters.length = 0;
  selectOrders.length = 0;
  selectColumns.length = 0;
  rpcCalls.length = 0;
  callLog.length = 0;
  tagCalls.length = 0;
  transitions.length = 0;
  prepareCalls.length = 0;
  sendCalls.length = 0;

  ruleRow = null;
  conversationRow = null;
  contactRow = null;
  runRow = null;
  eventRow = null;
  memberRow = { user_id: "user_1", workspace_id: "ws_1", is_active: true };

  readErrorTables = new Set();
  insertErrorTables = new Set();
  leaseHeld = true;
  runUpdateError = null;
  assignUpdateRows = 1;
  deleteConversationOnAssign = false;
  disableRuleUpdateRows = 1;
  disableRuleUpdateError = null;
  dispatchClaim = "ok";
  dispatchRpcError = null;
  claimRpcError = null;
  claimOkBeforeError = 0;
  claimQueue = [];

  tagImpl = async () => true;
  handoffImpl = async () => true;
  transitionImpl = async () => {};
  prepareResult = {
    ok: true,
    prepared: { toPhone: "+15550000001", templateName: "bienvenida" },
  };
  sendResult = { ok: true };
  loadVariableContextImpl = async () => OK_CONTEXT;
  loadVariableContextCalls.length = 0;
}

const runUpdates = () => updates.filter((u) => u.table === "automation_runs");
const lastRunUpdate = () => runUpdates().at(-1)!.row;
const eventTypes = () =>
  inserts.filter((i) => i.table === "events").map((i) => i.row.type);
const firstFiltersFor = (table: string) =>
  selectFilters.find((s) => s.table === table)!.filters;
const firstColumnsFor = (table: string) =>
  selectColumns.find((s) => s.table === table)?.columns;
const dispatchRpcCalls = () =>
  rpcCalls.filter((c) => c.fn === "mark_automation_run_dispatched");

/** Escenario feliz de la mayoría de los tests: conversación y contacto vivos. */
function withLiveConversation() {
  conversationRow = { id: "conv_1", workspace_id: "ws_1", contact_id: "contact_1" };
  contactRow = { id: "contact_1", workspace_id: "ws_1", opt_in: true };
}

// ── 1-6. Camino correcto, una prueba por acción ──────────────────────────────

test("1. add_tag etiqueta, cierra done y registra automation_fired con run_id y rule_id", async () => {
  reset();
  ruleRow = { ...ADD_TAG_RULE };
  withLiveConversation();

  assert.equal(await executeRun(makeRun()), "done");
  assert.deepEqual(tagCalls[0], {
    workspaceId: "ws_1",
    contactId: "contact_1",
    tag: "nuevo",
  });
  assert.equal(lastRunUpdate().status, "done");
  assert.deepEqual(eventTypes(), ["automation_fired"]);
  const payload = inserts.find((i) => i.table === "events")!.row.payload as Record<
    string,
    unknown
  >;
  assert.equal(payload.run_id, "run_1");
  assert.equal(payload.rule_id, "rule_1");
  assert.equal(payload.event_id, 42);
});

test("2. send_template prepara, marca el despacho, envía y queda done", async () => {
  reset();
  ruleRow = { ...TEMPLATE_RULE };
  withLiveConversation();

  assert.equal(await executeRun(makeRun()), "done");
  assert.equal(prepareCalls.length, 1);
  assert.deepEqual((prepareCalls[0] as Record<string, unknown>).components, [
    { type: "body", parameters: [{ type: "text", text: "<{{contact.name}}>" }] },
  ]);
  assert.equal(dispatchRpcCalls().length, 1);
  assert.equal(sendCalls.length, 1);
  assert.deepEqual(sendCalls[0], prepareResult.prepared);
  assert.equal(lastRunUpdate().status, "done");
});

test("3. assign_agent con miembro activo escribe assigned_to y queda done", async () => {
  reset();
  ruleRow = { ...ASSIGN_RULE };
  withLiveConversation();

  assert.equal(await executeRun(makeRun()), "done");
  const convUpdate = updates.find((u) => u.table === "conversations")!;
  assert.equal(convUpdate.row.assigned_to, "user_1");
  assert.ok(
    convUpdate.filters.some(([c, v]) => c === "workspace_id" && v === "ws_1"),
    "sin este filtro se puede asignar una conversación de otro tenant",
  );
  const memberFilters = firstFiltersFor("memberships");
  assert.deepEqual(memberFilters.find(([c]) => c === "workspace_id"), [
    "workspace_id",
    "ws_1",
  ]);
  assert.deepEqual(memberFilters.find(([c]) => c === "is_active"), ["is_active", true]);
});

test("4. handoff_human con requestHandoff true queda done", async () => {
  reset();
  ruleRow = { ...HANDOFF_RULE };
  withLiveConversation();

  assert.equal(await executeRun(makeRun()), "done");
  assert.deepEqual(eventTypes(), ["automation_fired"]);
});

test("5. close_conversation con applyTransition OK queda done", async () => {
  reset();
  ruleRow = { ...CLOSE_RULE };
  withLiveConversation();

  assert.equal(await executeRun(makeRun()), "done");
  assert.deepEqual(transitions[0], [
    "conv_1",
    "closed",
    { trigger: "automation", workspaceId: "ws_1" },
  ]);
});

test("6. lead_qualified sin conversación resuelve la más reciente, la persiste y ejecuta", async () => {
  reset();
  ruleRow = { ...TEMPLATE_RULE };
  conversationRow = { id: "conv_9", workspace_id: "ws_1", contact_id: "contact_1" };
  contactRow = { id: "contact_1", workspace_id: "ws_1", opt_in: true };

  const outcome = await executeRun(
    makeRun({ trigger_type: "lead_qualified", conversation_id: null }),
  );
  assert.equal(outcome, "done");

  assert.deepEqual(selectOrders.find((o) => o.table === "conversations"), {
    table: "conversations",
    column: "last_message_at",
    options: { ascending: false, nullsFirst: false },
  });
  const busqueda = firstFiltersFor("conversations");
  assert.deepEqual(busqueda.find(([c]) => c === "workspace_id"), [
    "workspace_id",
    "ws_1",
  ]);

  const persist = runUpdates().find((u) => "conversation_id" in u.row)!;
  assert.equal(persist.row.conversation_id, "conv_9");
  assert.ok(
    persist.filters.some(
      ([c, v]) => c === "claimed_at" && v === "2026-09-03T10:00:00.000Z",
    ),
    "persistir sin la condición de lease pisa el trabajo de otro worker",
  );
  assert.equal(sendCalls.length, 1);
});

// ── 7-10. Regla: despacho previo y habilitación ────────────────────────────────────────────────────

test("7. un run que YA trae dispatched_at queda failed/outcome_unknown y no reenvía", async () => {
  reset();
  ruleRow = { ...TEMPLATE_RULE };
  withLiveConversation();

  const outcome = await executeRun(
    makeRun({ dispatched_at: "2026-09-03T09:59:30.000Z" }),
  );
  assert.equal(outcome, "failed");
  assert.equal(lastRunUpdate().error, "outcome_unknown");
  assert.equal(sendCalls.length, 0, "no se reenvía");
  assert.deepEqual(eventTypes(), ["automation_failed"]);
});

test("8. una regla inexistente deja el run skipped/rule_disabled", async () => {
  reset();
  ruleRow = null;
  withLiveConversation();

  assert.equal(await executeRun(makeRun()), "skipped");
  assert.equal(lastRunUpdate().error, "rule_disabled");
});

test("9. una regla apagada deja el run skipped/rule_disabled", async () => {
  reset();
  ruleRow = { ...ADD_TAG_RULE, enabled: false };
  withLiveConversation();

  assert.equal(await executeRun(makeRun()), "skipped");
  assert.equal(lastRunUpdate().error, "rule_disabled");
  assert.equal(tagCalls.length, 0);
});

test("9b. el ejecutor NO evalúa el piso temporal: eso lo decide el claim", async () => {
  // Reemplaza a los viejos 9b/9c/9d, que probaban un guard que vivía acá y
  // comparaba `run.created_at` contra `rule.enabled_since`. Ese guard se mudó
  // a `claim_next_automation_run()` (migración 20260904000002), donde la
  // comparación es `enabled_since > occurred_at` del EVENTO, en SQL y con la
  // precisión completa del timestamptz. El contrato que queda de este lado es
  // que el ejecutor ejecuta lo que la RPC le entrega y no vuelve a filtrar:
  // si volviera a filtrar acá, el invariante tendría dos definiciones otra vez
  // y la de TypeScript sería la equivocada (`created_at` no es el instante del
  // hecho).
  reset();
  // Peor caso para el guard viejo: la regla se reactivó MUCHO después de que
  // la fila del run se escribió. El guard viejo cerraba esto como
  // skipped/rule_reenabled; ahora se ejecuta, porque quien decide es el claim.
  ruleRow = { ...ADD_TAG_RULE, enabled_since: "2026-09-03T10:00:00.000Z" };
  withLiveConversation();

  const outcome = await executeRun(
    makeRun({ created_at: "2026-09-03T09:00:00.000Z" }),
  );
  assert.equal(outcome, "done", "el ejecutor no descarta por enabled_since");
  assert.equal(tagCalls.length, 1);
  assert.equal(
    runUpdates().some((u) => u.row.error === "rule_reenabled"),
    false,
    "`rule_reenabled` ya no lo escribe este archivo: lo escribe la RPC del claim",
  );

  // Y no se pide la columna: el fake no proyecta de verdad, así que afirmar el
  // `select` es lo único que nota que alguien reintrodujo el guard viejo junto
  // con su lectura.
  assert.doesNotMatch(
    String(firstColumnsFor("automation_rules")),
    /\benabled_since\b/,
    "el select de automation_rules ya no necesita enabled_since: el piso temporal vive en claim_next_automation_run()",
  );
});

test("10. una regla renombrada DESPUÉS de expandir el run igual se ejecuta", async () => {
  reset();
  ruleRow = {
    id: "rule_1",
    workspace_id: "ws_1",
    name: "Bienvenida (renombrada)",
    action_type: "add_tag",
    action_config: { tag: "nuevo" },
    enabled: true,
    // Posterior al run: no debe matarlo.
    updated_at: "2026-09-03T23:00:00.000Z",
  };
  withLiveConversation();

  const outcome = await executeRun(makeRun({ created_at: "2026-09-03T09:00:00.000Z" }));

  assert.equal(
    outcome,
    "done",
    "cambiarle el nombre a una regla no puede cancelar un run ya expandido",
  );
});

// ── 11-16. Aislamiento y opt-out fail-closed ─────────────────────────────────

test("11. una regla de otro workspace queda failed/cross_workspace", async () => {
  reset();
  ruleRow = { ...TEMPLATE_RULE, workspace_id: "ws_otro" };
  withLiveConversation();

  assert.equal(await executeRun(makeRun()), "failed");
  assert.equal(lastRunUpdate().error, "cross_workspace");
  assert.equal(sendCalls.length, 0);
  assert.deepEqual(
    firstFiltersFor("automation_rules").find(([c]) => c === "workspace_id"),
    ["workspace_id", "ws_1"],
    "la regla se cargó sin filtrar por workspace_id",
  );
  assert.deepEqual(eventTypes(), ["automation_failed"]);
});

test("12. un error de base leyendo la regla deja el run pending con backoff", async () => {
  reset();
  ruleRow = { ...ADD_TAG_RULE };
  withLiveConversation();
  readErrorTables = new Set(["automation_rules"]);

  assert.equal(await executeRun(makeRun()), "retry");
  assert.equal(lastRunUpdate().status, "pending");
  assert.equal(lastRunUpdate().claimed_at, null);
  // attempts = 1 ⇒ 2 minutos
  const notBefore = Date.parse(lastRunUpdate().not_before as string);
  assert.ok(notBefore - Date.now() > 60_000, "el backoff empuja el próximo intento");
  assert.equal(inserts.length, 0, "un reintento todavía no terminó nada");
});

test("13. una conversación inexistente deja el run skipped/no_conversation", async () => {
  reset();
  ruleRow = { ...ADD_TAG_RULE };
  conversationRow = null;

  assert.equal(await executeRun(makeRun()), "skipped");
  assert.equal(lastRunUpdate().error, "no_conversation");
  assert.deepEqual(eventTypes(), ["automation_skipped"]);
});

test("14. una conversación de otro workspace queda failed/cross_workspace", async () => {
  reset();
  ruleRow = { ...TEMPLATE_RULE };
  conversationRow = { id: "conv_1", workspace_id: "ws_otro", contact_id: "contact_1" };

  assert.equal(await executeRun(makeRun()), "failed");
  assert.equal(lastRunUpdate().error, "cross_workspace");
  assert.equal(sendCalls.length, 0);
});

test("15. un contacto con opt_in=false queda skipped/opted_out, sin envío ni RPC de despacho", async () => {
  reset();
  ruleRow = { ...TEMPLATE_RULE };
  conversationRow = { id: "conv_1", workspace_id: "ws_1", contact_id: "contact_1" };
  contactRow = { id: "contact_1", workspace_id: "ws_1", opt_in: false };

  assert.equal(await executeRun(makeRun()), "skipped");
  assert.equal(lastRunUpdate().error, "opted_out");
  assert.equal(sendCalls.length, 0);
  assert.equal(dispatchRpcCalls().length, 0);
  assert.deepEqual(eventTypes(), ["automation_skipped"]);
});

test("16. una lectura caída del contacto se reintenta SIN enviar (fail-closed)", async () => {
  reset();
  ruleRow = { ...TEMPLATE_RULE };
  conversationRow = { id: "conv_1", workspace_id: "ws_1", contact_id: "contact_1" };
  readErrorTables = new Set(["contacts"]);

  assert.equal(await executeRun(makeRun()), "retry");
  assert.equal(sendCalls.length, 0);
  assert.equal(dispatchRpcCalls().length, 0);
  assert.equal(lastRunUpdate().status, "pending");
});

// ── 17-26. send_template ─────────────────────────────────────────────────────

test("17. send_template sin template_name queda failed/invalid_config", async () => {
  reset();
  ruleRow = { ...TEMPLATE_RULE, action_config: {} };
  withLiveConversation();

  assert.equal(await executeRun(makeRun()), "failed");
  assert.equal(lastRunUpdate().error, "invalid_config");
  assert.equal(prepareCalls.length, 0);
});

test("18. {{business.name}} sin negocio configurado queda failed/missing_business_name", async () => {
  reset();
  ruleRow = {
    ...TEMPLATE_RULE,
    action_config: { template_name: "bienvenida", variables: ["{{business.name}}"] },
  };
  withLiveConversation();
  loadVariableContextImpl = async () => ({
    ok: true,
    ctx: { contactName: "María", contactPhone: "+15550000001", businessName: null },
  });

  assert.equal(await executeRun(makeRun()), "failed");
  assert.equal(lastRunUpdate().error, "missing_business_name");
  assert.equal(
    sendCalls.length,
    0,
    "el nombre interno del workspace no puede terminar en un WhatsApp",
  );
  assert.equal(dispatchRpcCalls().length, 0);
});

test("19. loadVariableContext caído se reintenta: base caída ≠ configuración incompleta", async () => {
  reset();
  ruleRow = { ...TEMPLATE_RULE };
  withLiveConversation();
  loadVariableContextImpl = async () => ({
    ok: false,
    error: "no pude leer los datos del negocio",
  });

  assert.equal(await executeRun(makeRun()), "retry");
  assert.equal(lastRunUpdate().status, "pending");
  assert.equal(sendCalls.length, 0);
});

test("20. prepareTemplateDispatch retryable deja retry, sin marcar y sin enviar", async () => {
  reset();
  ruleRow = { ...TEMPLATE_RULE };
  withLiveConversation();
  prepareResult = {
    ok: false,
    error: "connection refused",
    errorCode: "DB_ERROR",
    retryable: true,
  };

  assert.equal(await executeRun(makeRun()), "retry");
  assert.equal(dispatchRpcCalls().length, 0, "marcar acá perdía mensajes legítimos");
  assert.equal(sendCalls.length, 0);
  assert.equal(lastRunUpdate().status, "pending");
});

test("21. prepareTemplateDispatch no reintentable queda failed/invalid_config, sin envío", async () => {
  reset();
  ruleRow = { ...TEMPLATE_RULE };
  withLiveConversation();
  prepareResult = {
    ok: false,
    error: "missing_kapso_credentials",
    errorCode: "CONFIG_ERROR",
    retryable: false,
  };

  assert.equal(await executeRun(makeRun()), "failed");
  assert.equal(lastRunUpdate().error, "invalid_config");
  assert.equal(sendCalls.length, 0);
  assert.equal(dispatchRpcCalls().length, 0);
});

test("22. prepareTemplateDispatch con OPT_OUT queda skipped/opted_out", async () => {
  reset();
  ruleRow = { ...TEMPLATE_RULE };
  withLiveConversation();
  prepareResult = {
    ok: false,
    error: "el contacto pidió no recibir mensajes",
    errorCode: "OPT_OUT",
    retryable: false,
  };

  assert.equal(await executeRun(makeRun()), "skipped");
  assert.equal(lastRunUpdate().error, "opted_out");
  assert.equal(sendCalls.length, 0);
});

test("23. la RPC de despacho con 'not_found' deja el run lost y cero envíos", async () => {
  reset();
  ruleRow = { ...TEMPLATE_RULE };
  withLiveConversation();
  dispatchClaim = "not_found";
  // Rama (a) de la RPC: la fila ya NO está en `processing` (otro worker la
  // cerró, o no existe). `runRow = null` es exactamente eso.

  assert.equal(await executeRun(makeRun()), "lost");
  assert.equal(sendCalls.length, 0);
  assert.equal(
    runUpdates().length,
    0,
    "la fila ya no está en processing: no se le escribe encima",
  );
  assert.equal(inserts.length, 0);
});

test("23b. 'not_found' con la fila AÚN en processing la cierra skipped/conversation_gone", async () => {
  // Rama (b) de `mark_automation_run_dispatched`: el `IF NOT v_has_conv` final.
  // El run sigue reclamado y con `dispatched_at IS NULL`, pero el JOIN no
  // encuentra conversación ni contacto — el caso REAL cuando el UPDATE de
  // `persistResolvedConversation` falló y la columna quedó en NULL.
  //
  // Devolver "lost" acá dejaba la fila sin estado terminal y sin evento: el
  // lease la recuperaba tres veces y moría como `max_attempts` por un run que
  // demostrablemente nunca despachó.
  reset();
  ruleRow = { ...TEMPLATE_RULE };
  withLiveConversation();
  dispatchClaim = "not_found";
  runRow = { id: "run_1", workspace_id: "ws_1", status: "processing" };

  assert.equal(await executeRun(makeRun()), "skipped");
  assert.equal(sendCalls.length, 0, "no hubo POST a Kapso");
  assert.equal(lastRunUpdate().status, "skipped");
  assert.equal(lastRunUpdate().error, "conversation_gone");
  assert.ok(
    lastRunUpdate().finished_at,
    "y queda cerrada: nada de colgarse en processing hasta quemar los intentos",
  );
  assert.deepEqual(eventTypes(), ["automation_skipped"]);
});

test("24. la RPC de despacho con error de base se reintenta y no envía", async () => {
  reset();
  ruleRow = { ...TEMPLATE_RULE };
  withLiveConversation();
  dispatchRpcError = "connection refused";

  assert.equal(await executeRun(makeRun()), "retry");
  assert.equal(sendCalls.length, 0);
  assert.equal(lastRunUpdate().status, "pending");
});

test("25. un envío que falla con retryable true queda failed, NUNCA retry", async () => {
  reset();
  ruleRow = { ...TEMPLATE_RULE };
  withLiveConversation();
  // Lo que devuelve sendPreparedTemplate cuando el AbortSignal de kapsoFetch
  // cortó la llamada a los 20 s: SEND_FAILED con retryable true.
  sendResult = {
    ok: false,
    error: "La operación tardó demasiado",
    errorCode: "SEND_FAILED",
    retryable: true,
  };

  assert.equal(
    await executeRun(makeRun()),
    "failed",
    "el mensaje pudo haber salido: reintentar es arriesgar un duplicado",
  );
  assert.equal(lastRunUpdate().error, "outcome_unknown");
});

test("26. el orden es preparar → marcar → enviar, y marcar va inmediatamente antes del POST", async () => {
  reset();
  ruleRow = { ...TEMPLATE_RULE };
  withLiveConversation();

  assert.equal(await executeRun(makeRun()), "done");
  assert.deepEqual(callLog, ["prepare", "markDispatched", "send"]);
});

// ── 27-32. add_tag y assign_agent ────────────────────────────────────────────

test("27. add_tag con ConfigError queda failed con su código, sin reintento", async () => {
  reset();
  ruleRow = { ...ADD_TAG_RULE };
  withLiveConversation();
  tagImpl = async () => {
    throw new FakeConfigError("contact_not_found");
  };

  assert.equal(await executeRun(makeRun()), "failed");
  assert.equal(lastRunUpdate().error, "contact_not_found");
  assert.deepEqual(eventTypes(), ["automation_failed"]);
});

test("28. add_tag con un error de red se reintenta", async () => {
  reset();
  ruleRow = { ...ADD_TAG_RULE };
  withLiveConversation();
  tagImpl = async () => {
    throw new Error("connection refused");
  };

  assert.equal(await executeRun(makeRun()), "retry");
  assert.equal(lastRunUpdate().status, "pending");
});

test("29. una etiqueta que YA ESTABA cierra el run done, no lo deja en bucle", async () => {
  reset();
  ruleRow = { ...ADD_TAG_RULE };
  withLiveConversation();
  tagImpl = async () => false;

  assert.equal(await executeRun(makeRun()), "done");
  assert.deepEqual(eventTypes(), ["automation_fired"]);
});

test("30. assign_agent con un usuario que no es miembro activo queda failed/invalid_config", async () => {
  reset();
  ruleRow = { ...ASSIGN_RULE };
  withLiveConversation();
  memberRow = null;

  assert.equal(await executeRun(makeRun()), "failed");
  assert.equal(lastRunUpdate().error, "invalid_config");
  assert.equal(updates.filter((u) => u.table === "conversations").length, 0);
});

test("31. assign_agent con 0 filas y la conversación borrada queda failed/conversation_not_found", async () => {
  reset();
  ruleRow = { ...ASSIGN_RULE };
  withLiveConversation();
  assignUpdateRows = 0;
  deleteConversationOnAssign = true;

  assert.equal(await executeRun(makeRun()), "failed");
  assert.equal(lastRunUpdate().error, "conversation_not_found");
  assert.deepEqual(eventTypes(), ["automation_failed"]);
});

test("32. assign_agent con error de base en memberships se reintenta", async () => {
  reset();
  ruleRow = { ...ASSIGN_RULE };
  withLiveConversation();
  readErrorTables = new Set(["memberships"]);

  assert.equal(await executeRun(makeRun()), "retry");
  assert.equal(lastRunUpdate().status, "pending");
});

// ── 33-36. Transición inválida vs base caída ────────────────────────────

test("33. handoff_human con requestHandoff false queda skipped/transition_not_allowed", async () => {
  reset();
  ruleRow = { ...HANDOFF_RULE };
  withLiveConversation();
  handoffImpl = async () => false;

  assert.equal(await executeRun(makeRun()), "skipped");
  assert.equal(lastRunUpdate().error, "transition_not_allowed");
});

test("34. handoff_human distingue transición inválida (skipped) de base caída (retry)", async () => {
  reset();
  ruleRow = { ...HANDOFF_RULE };
  withLiveConversation();

  handoffImpl = async () => false;
  assert.equal(await executeRun(makeRun()), "skipped");
  assert.equal(lastRunUpdate().error, "transition_not_allowed");

  reset();
  ruleRow = { ...HANDOFF_RULE };
  withLiveConversation();
  handoffImpl = async () => {
    throw new Error("connection refused");
  };
  assert.equal(
    await executeRun(makeRun()),
    "retry",
    "una base caída no es una transición inválida: tragarla perdería el handoff",
  );
});

test("35. close_conversation con TransitionError queda skipped/transition_not_allowed", async () => {
  reset();
  ruleRow = { ...CLOSE_RULE };
  withLiveConversation();
  transitionImpl = async () => {
    throw new FakeTransitionError("Invalid transition: closed → closed");
  };

  assert.equal(await executeRun(makeRun()), "skipped");
  assert.equal(lastRunUpdate().error, "transition_not_allowed");
});

test("36. close_conversation con un error cualquiera se reintenta", async () => {
  reset();
  ruleRow = { ...CLOSE_RULE };
  withLiveConversation();
  transitionImpl = async () => {
    throw new Error("connection refused");
  };

  assert.equal(
    await executeRun(makeRun()),
    "retry",
    "tragarlo como skipped dejaba la conversación abierta para siempre",
  );
  assert.equal(lastRunUpdate().status, "pending");
});

// ── 37-40. Cierre honesto ──────────────────────────────────────────────

test("37. lead_qualified de un contacto sin conversaciones queda skipped/no_conversation", async () => {
  reset();
  ruleRow = { ...TEMPLATE_RULE };
  conversationRow = null;
  contactRow = { id: "contact_1", workspace_id: "ws_1", opt_in: true };

  const outcome = await executeRun(
    makeRun({ trigger_type: "lead_qualified", conversation_id: null }),
  );
  assert.equal(outcome, "skipped");
  assert.equal(lastRunUpdate().error, "no_conversation");
  assert.equal(sendCalls.length, 0);
});

test("38. finish con 0 filas afectadas devuelve lost y NO escribe el evento", async () => {
  reset();
  ruleRow = { ...ADD_TAG_RULE };
  withLiveConversation();
  leaseHeld = false;

  assert.equal(await executeRun(makeRun()), "lost");
  assert.equal(
    inserts.filter((i) => i.table === "events").length,
    0,
    "otro worker ya la cerró: el panel mostraría la automatización dos veces",
  );
});

test("39. si el UPDATE de cierre falla, executeRun devuelve failed y NO deja la fila cerrada", async () => {
  reset();
  ruleRow = { ...ADD_TAG_RULE };
  withLiveConversation();
  runUpdateError = "connection refused";

  const outcome = await executeRun(makeRun());

  assert.equal(outcome, "failed", "el tally cuenta el fallo…");
  const cierres = updates.filter((u) => u.table === "automation_runs");
  assert.equal(
    cierres.length,
    2,
    "…tras UN solo reintento de cierre: el del camino normal y el del catch",
  );
  assert.equal(
    successfulRunUpdates.length,
    0,
    "…y ninguno escribió: la fila sigue 'processing' y el lease la recupera",
  );
  assert.equal(
    inserts.filter((i) => i.table === "events").length,
    0,
    "sin cierre no hay evento: el panel no puede mostrar una automatización que no terminó",
  );
});

test("40. finish mapea el outcome a su evento y un insert fallido no reabre el run", async () => {
  reset();
  ruleRow = { ...ADD_TAG_RULE };
  withLiveConversation();
  insertErrorTables = new Set(["events"]);

  assert.equal(
    await executeRun(makeRun()),
    "done",
    "el run ya está cerrado: el evento es observabilidad",
  );
  assert.equal(
    inserts.filter((i) => i.table === "events").length,
    1,
    "se intentó una sola vez; el error se registra server-side con el run_id",
  );

  // Y el mapeo de los otros dos desenlaces.
  reset();
  ruleRow = { ...ADD_TAG_RULE, enabled: false };
  withLiveConversation();
  await executeRun(makeRun());
  assert.deepEqual(eventTypes(), ["automation_skipped"]);

  reset();
  ruleRow = { ...TEMPLATE_RULE, action_config: {} };
  withLiveConversation();
  await executeRun(makeRun());
  assert.deepEqual(eventTypes(), ["automation_failed"]);
});

// ── 41-46. drainAutomationRuns y fail-closed de add_tag ────────────────

test("41. el drenaje llama claim_next_automation_run() SIN argumentos", async () => {
  reset();
  claimQueue = [makeRun({ id: "run_1" }) as unknown as Record<string, unknown>];
  ruleRow = { ...ADD_TAG_RULE };
  withLiveConversation();

  await drainAutomationRuns(20, Date.now() + 60_000);

  assert.equal(rpcCalls[0].fn, "claim_next_automation_run");
  assert.equal(
    rpcCalls[0].args,
    undefined,
    "el round-robin vive en el ORDER BY de la RPC; un cursor en TS no sobrevive al tick siguiente",
  );
});

test("42. el deadline vencido corta ANTES de reclamar, aunque quede trabajo", async () => {
  reset();
  claimQueue = Array.from(
    { length: 5 },
    (_, i) => makeRun({ id: `run_${i}` }) as unknown as Record<string, unknown>,
  );
  ruleRow = { ...ADD_TAG_RULE };
  withLiveConversation();

  const tally = await drainAutomationRuns(20, Date.now() - 1);

  assert.deepEqual(tally, { done: 0, failed: 0, skipped: 0, retry: 0, lost: 0 });
  assert.equal(
    rpcCalls.length,
    0,
    "reclamar y no ejecutar deja la fila 'processing' esperando el lease",
  );
  assert.equal(claimQueue.length, 5, "y no consume la cola");
});

test("43. el drenaje corta al primer vacío: UNA sola llamada, sin vuelta de rueda", async () => {
  reset();
  ruleRow = { ...ADD_TAG_RULE };
  withLiveConversation();

  const tally = await drainAutomationRuns(20, Date.now() + 60_000);

  assert.deepEqual(tally, { done: 0, failed: 0, skipped: 0, retry: 0, lost: 0 });
  assert.equal(rpcCalls.length, 1, "sin cursor no hay segunda vuelta que dar");
});

test("44. el drenaje respeta max y acumula el tally por outcome", async () => {
  reset();
  claimQueue = Array.from(
    { length: 3 },
    (_, i) => makeRun({ id: `run_${i}` }) as unknown as Record<string, unknown>,
  );
  ruleRow = { ...ADD_TAG_RULE };
  withLiveConversation();

  const tally = await drainAutomationRuns(2, Date.now() + 60_000);

  assert.deepEqual(tally, { done: 2, failed: 0, skipped: 0, retry: 0, lost: 0 });
  assert.equal(rpcCalls.length, 2);
  assert.equal(claimQueue.length, 1, "la tercera fila queda para el tick siguiente");
});

test("45. un error de la RPC corta el drenaje sin lanzar y lo REPORTA como fallo de fase", async () => {
  reset();
  ruleRow = { ...ADD_TAG_RULE };
  withLiveConversation();
  // La fila EN la cola es lo que hace que el test muerda: sin ella el drenaje
  // cortaría igual por `!run` y borrar el `if (error) break` quedaría en verde.
  claimQueue = [makeRun() as unknown as Record<string, unknown>];
  claimRpcError = { message: "connection refused" };

  const tally = await drainAutomationRuns(20, Date.now() + 60_000);

  // Sin el `error`, este tally es idéntico al de una cola vacía
  // (test 43) y el cron firma `200 {ok:true}` mientras la cola crece.
  assert.deepEqual(tally, {
    done: 0,
    failed: 0,
    skipped: 0,
    retry: 0,
    lost: 0,
    error: "claim_failed",
  });
  assert.equal(rpcCalls.length, 1);
  assert.equal(
    updates.length,
    0,
    "un error de la RPC no ejecuta la fila que igual vino en data",
  );
  // El código no puede llevar el texto de PostgREST.
  assert.ok(!JSON.stringify(tally).includes("connection refused"));
});

test("45b. el fallo de fase conserva el tally de los runs que el tick SÍ ejecutó", async () => {
  reset();
  ruleRow = { ...ADD_TAG_RULE };
  withLiveConversation();
  claimQueue = Array.from(
    { length: 3 },
    (_, i) => makeRun({ id: `run_${i}` }) as unknown as Record<string, unknown>,
  );
  // Dos reclamos buenos y al tercero se cae la RPC.
  claimOkBeforeError = 2;
  claimRpcError = { message: "connection refused" };

  const tally = await drainAutomationRuns(20, Date.now() + 60_000);

  // Por esto el fallo viaja como DATO y no como excepción: lanzando, la ruta
  // respondería `drain_threw` con el tally en ceros y se perdería el trabajo
  // que este tick sí hizo.
  assert.deepEqual(tally, {
    done: 2,
    failed: 0,
    skipped: 0,
    retry: 0,
    lost: 0,
    error: "claim_failed",
  });
});

test("46. add_tag con la lectura del contacto caída se reintenta, no se da por rota", async () => {
  reset();
  ruleRow = { ...ADD_TAG_RULE };
  conversationRow = { id: "conv_1", workspace_id: "ws_1", contact_id: "contact_1" };
  readErrorTables = new Set(["contacts"]);

  const outcome = await executeRun(makeRun());

  assert.equal(
    outcome,
    "retry",
    "una base caída no es un contacto inexistente: 'failed contact_not_found' no se reintenta nunca",
  );
  assert.notEqual(lastRunUpdate().error, "contact_not_found");
});

// ── 47-53. Conversación borrada, asignación, opt-out y errores ──────────────

test("47. solo lead_qualified resuelve la conversación tarde", async () => {
  // Camino de error: la conversación de un keyword_match se borró
  // (ON DELETE SET NULL). Resolver "la más reciente del contacto" mandaría la
  // plantilla por una conversación que NADA tiene que ver con el mensaje que
  // disparó la regla.
  reset();
  ruleRow = { ...ADD_TAG_RULE };
  contactRow = { id: "contact_1", workspace_id: "ws_1", opt_in: true };
  conversationRow = { id: "conv_9", workspace_id: "ws_1", contact_id: "contact_1" };

  const outcome = await executeRun(
    makeRun({ trigger_type: "keyword_match", conversation_id: null }),
  );

  assert.equal(outcome, "skipped");
  assert.equal(lastRunUpdate().error, "conversation_gone");
  assert.equal(
    selectFilters.filter((f) => f.table === "conversations").length,
    0,
    "ni siquiera se busca una conversación de reemplazo",
  );

  // Camino correcto: lead_qualified nace SIEMPRE sin conversación, y ahí la
  // resolución tardía es el diseño.
  reset();
  ruleRow = { ...ADD_TAG_RULE };
  contactRow = { id: "contact_1", workspace_id: "ws_1", opt_in: true };
  conversationRow = { id: "conv_9", workspace_id: "ws_1", contact_id: "contact_1" };

  assert.equal(
    await executeRun(makeRun({ trigger_type: "lead_qualified", conversation_id: null })),
    "done",
  );
});

test("48. first_message y handoff_requested sin conversación también son conversation_gone", async () => {
  for (const trigger of ["first_message", "handoff_requested"] as const) {
    reset();
    ruleRow = { ...TEMPLATE_RULE };
    contactRow = { id: "contact_1", workspace_id: "ws_1", opt_in: true };
    conversationRow = { id: "conv_9", workspace_id: "ws_1", contact_id: "contact_1" };

    const outcome = await executeRun(
      makeRun({ trigger_type: trigger, conversation_id: null }),
    );

    assert.equal(outcome, "skipped", `${trigger} no puede resolver otra conversación`);
    assert.equal(lastRunUpdate().error, "conversation_gone");
    assert.equal(sendCalls.length, 0);
  }
});

test("49. reintento con el mismo agente es done; con otro dueño es skipped", async () => {
  // Camino correcto (idempotente): el UPDATE con `assigned_to IS NULL` afecta 0
  // filas porque este mismo run ya asignó en un intento anterior.
  reset();
  ruleRow = { ...ASSIGN_RULE };
  conversationRow = {
    id: "conv_1",
    workspace_id: "ws_1",
    contact_id: "contact_1",
    assigned_to: "user_1",
  };
  contactRow = { id: "contact_1", workspace_id: "ws_1", opt_in: true };
  memberRow = { user_id: "user_1", workspace_id: "ws_1", is_active: true };
  assignUpdateRows = 0;

  assert.equal(await executeRun(makeRun()), "done");

  // Camino de error: entre el primer intento y el reintento, un supervisor
  // reasignó la conversación. El motor NO la vuelve a tomar.
  reset();
  ruleRow = { ...ASSIGN_RULE };
  conversationRow = {
    id: "conv_1",
    workspace_id: "ws_1",
    contact_id: "contact_1",
    assigned_to: "humano_2",
  };
  contactRow = { id: "contact_1", workspace_id: "ws_1", opt_in: true };
  memberRow = { user_id: "user_1", workspace_id: "ws_1", is_active: true };
  assignUpdateRows = 0;

  assert.equal(await executeRun(makeRun()), "skipped");
  assert.equal(lastRunUpdate().error, "already_assigned");
  assert.equal(
    (conversationRow as Record<string, unknown>).assigned_to,
    "humano_2",
    "la reasignación humana queda intacta",
  );
});

test("50. el UPDATE de assign_agent lleva assigned_to IS NULL", async () => {
  reset();
  ruleRow = { ...ASSIGN_RULE };
  withLiveConversation();

  assert.equal(await executeRun(makeRun()), "done");
  const convUpdate = updates.find((u) => u.table === "conversations")!;
  assert.deepEqual(
    convUpdate.isArgs,
    [["assigned_to", null]],
    "sin este filtro el reintento pisa la reasignación de un supervisor",
  );
});

test("51. un opt-out entre el preflight y el envío corta el WhatsApp", async () => {
  // Camino correcto: la RPC devuelve 'ok' y el mensaje sale.
  reset();
  ruleRow = { ...TEMPLATE_RULE };
  withLiveConversation();
  dispatchClaim = "ok";

  assert.equal(await executeRun(makeRun()), "done");
  assert.equal(sendCalls.length, 1);
  assert.equal(dispatchRpcCalls().at(-1)!.fn, "mark_automation_run_dispatched");
  assert.deepEqual(dispatchRpcCalls().at(-1)!.args, { p_run_id: "run_1" });

  // Camino de error: el contacto se dio de baja DESPUÉS del preflight. El guard
  // temprano no lo vio; la RPC sí, porque comprueba y marca en la misma
  // sentencia.
  reset();
  ruleRow = { ...TEMPLATE_RULE };
  withLiveConversation();
  dispatchClaim = "opted_out";

  assert.equal(await executeRun(makeRun()), "skipped");
  assert.equal(lastRunUpdate().error, "opted_out");
  assert.equal(sendCalls.length, 0, "no se manda un WhatsApp a quien se dio de baja");
});

test("52. already_dispatched es failed/outcome_unknown, nunca done ni un segundo envío", async () => {
  reset();
  ruleRow = { ...TEMPLATE_RULE };
  withLiveConversation();
  dispatchClaim = "already_dispatched";

  assert.equal(await executeRun(makeRun()), "failed");
  assert.equal(lastRunUpdate().error, "outcome_unknown");
  assert.equal(sendCalls.length, 0);
});

test("53. automation_runs.error nunca guarda el mensaje crudo de la excepción", async () => {
  reset();
  withLiveConversation();
  // `loadVariableContext` se llama FUERA de todo try/catch de acción, así que su
  // excepción llega al catch externo de executeRun — que es justamente el camino
  // que importa. El mensaje NO puede llegar a la fila: automation_runs.error
  // lo lee cualquier miembro del workspace.
  ruleRow = { ...TEMPLATE_RULE };
  loadVariableContextImpl = async () => {
    throw new TypeError('secreto interno: relation "contacts" column "api_key"');
  };

  const outcome = await executeRun(makeRun());

  assert.equal(outcome, "failed");
  assert.equal(lastRunUpdate().error, "internal_error");
  assert.ok(
    !String(lastRunUpdate().error).includes("secreto interno"),
    "el detalle técnico va SOLO al log del servidor",
  );
});

// ── 54-57. 132015 (plantilla pausada) apaga la regla ────────────────────────

test("54. 132015 cierra failed/template_paused, avisa nivel error y apaga la regla sin gastar los 3 intentos", async () => {
  reset();
  ruleRow = { ...TEMPLATE_RULE };
  withLiveConversation();
  sendResult = {
    ok: false,
    error: "Plantilla no disponible",
    errorCode: "SEND_FAILED",
    retryable: false,
    providerCode: 132015,
  };

  const outcome = await executeRun(makeRun());

  assert.equal(outcome, "failed");
  assert.equal(lastRunUpdate().error, "template_paused");
  assert.equal(
    lastRunUpdate().status,
    "failed",
    "cierra terminal en el primer intento: fail(), no retry() — no gasta los 3 intentos",
  );
  assert.equal(
    runUpdates().length,
    1,
    "un solo UPDATE de automation_runs: no hay vuelta por 'pending' con backoff",
  );

  const evento = inserts.find((i) => i.table === "events")!;
  assert.equal(evento.row.type, "automation_failed");
  assert.equal(evento.row.level, "error");

  const ruleUpdate = updates.find((u) => u.table === "automation_rules")!;
  assert.equal(ruleUpdate.row.enabled, false);
});

test("55. el UPDATE que apaga la regla filtra por workspace_id (aislamiento de tenant)", async () => {
  reset();
  ruleRow = { ...TEMPLATE_RULE };
  withLiveConversation();
  sendResult = {
    ok: false,
    error: "Plantilla no disponible",
    errorCode: "SEND_FAILED",
    retryable: false,
    providerCode: 132015,
  };

  await executeRun(makeRun());

  const ruleUpdate = updates.find((u) => u.table === "automation_rules")!;
  assert.deepEqual(ruleUpdate.filters.find(([c]) => c === "id"), ["id", "rule_1"]);
  assert.deepEqual(ruleUpdate.filters.find(([c]) => c === "workspace_id"), [
    "workspace_id",
    "ws_1",
  ]);
});

test("56. 132001 cierra failed/outcome_unknown y NO apaga la regla", async () => {
  reset();
  ruleRow = { ...TEMPLATE_RULE };
  withLiveConversation();
  sendResult = {
    ok: false,
    error: "Parámetro de plantilla inválido",
    errorCode: "SEND_FAILED",
    retryable: false,
    providerCode: 132001,
  };

  const outcome = await executeRun(makeRun());

  assert.equal(outcome, "failed");
  assert.equal(lastRunUpdate().error, "outcome_unknown");
  assert.equal(
    updates.some((u) => u.table === "automation_rules"),
    false,
    "no ampliar la lista de códigos que apagan: solo 132015",
  );
});

test("57. un fallo de envío SIN providerCode se comporta como antes (no rompe el camino existente)", async () => {
  reset();
  ruleRow = { ...TEMPLATE_RULE };
  withLiveConversation();
  sendResult = {
    ok: false,
    error: "La operación tardó demasiado",
    errorCode: "SEND_FAILED",
    retryable: true,
  };

  const outcome = await executeRun(makeRun());

  assert.equal(outcome, "failed");
  assert.equal(lastRunUpdate().error, "outcome_unknown");
  assert.equal(
    updates.some((u) => u.table === "automation_rules"),
    false,
  );
});

test("58. el UPDATE que apaga la regla afectando 0 filas no se reporta como apagado exitoso, y el run igual cierra", async () => {
  reset();
  ruleRow = { ...TEMPLATE_RULE };
  withLiveConversation();
  sendResult = {
    ok: false,
    error: "Plantilla no disponible",
    errorCode: "SEND_FAILED",
    retryable: false,
    providerCode: 132015,
  };
  disableRuleUpdateRows = 0;
  const warnMock = mock.method(console, "warn", () => {});

  try {
    const outcome = await executeRun(makeRun());

    assert.equal(
      outcome,
      "failed",
      "el apagado es best-effort: su fallo no bloquea el cierre del run",
    );
    assert.equal(lastRunUpdate().error, "template_paused");
    assert.ok(
      warnMock.mock.calls.some((c) =>
        String(c.arguments[0]).includes("0 filas"),
      ),
      "0 filas afectadas se loguea como advertencia, nunca como éxito silencioso",
    );
  } finally {
    warnMock.mock.restore();
  }
});

// ── 59-66. appointment.date/time y recheck de la cita ───────────────────────

test("59. appointment_upcoming resuelve subject_id vía automation_events y pasa el appointmentId a loadVariableContext", async () => {
  reset();
  ruleRow = { ...APPOINTMENT_RULE };
  withLiveConversation();
  eventRow = {
    id: 42,
    workspace_id: "ws_1",
    event_type: "appointment_upcoming",
    subject_id: "appt_1",
  };
  loadVariableContextImpl = async () => ({
    ok: true,
    ctx: {
      contactName: "María",
      contactPhone: "+15550000001",
      businessName: "Vet Demo",
      appointment: { status: "confirmed", date: "martes 8 de septiembre", time: "20:00" },
    },
  });

  const outcome = await executeRun(makeRun({ trigger_type: "appointment_upcoming" }));
  assert.equal(outcome, "done");
  assert.equal(sendCalls.length, 1);

  const eventFilters = firstFiltersFor("automation_events");
  assert.deepEqual(eventFilters.find(([c]) => c === "id"), ["id", 42]);
  assert.deepEqual(eventFilters.find(([c]) => c === "workspace_id"), ["workspace_id", "ws_1"]);
  assert.deepEqual(eventFilters.find(([c]) => c === "event_type"), [
    "event_type",
    "appointment_upcoming",
  ]);
  assert.equal(
    (loadVariableContextCalls.at(-1) as Record<string, unknown>).appointmentId,
    "appt_1",
  );
});

test("60. appointment_upcoming sin evento resoluble queda failed/missing_appointment, sin despacho", async () => {
  reset();
  ruleRow = { ...APPOINTMENT_RULE };
  withLiveConversation();
  eventRow = null;

  const outcome = await executeRun(makeRun({ trigger_type: "appointment_upcoming" }));
  assert.equal(outcome, "failed");
  assert.equal(lastRunUpdate().error, "missing_appointment");
  assert.equal(prepareCalls.length, 0);
  assert.equal(sendCalls.length, 0);
});

test("61. un error de base leyendo automation_events se reintenta, sin despacho", async () => {
  reset();
  ruleRow = { ...APPOINTMENT_RULE };
  withLiveConversation();
  readErrorTables = new Set(["automation_events"]);

  const outcome = await executeRun(makeRun({ trigger_type: "appointment_upcoming" }));
  assert.equal(outcome, "retry");
  assert.equal(lastRunUpdate().status, "pending");
  assert.equal(prepareCalls.length, 0);
});

test("62. cita ilegible o ausente NO manda el mensaje, cierra failed/missing_appointment", async () => {
  reset();
  ruleRow = { ...APPOINTMENT_RULE };
  withLiveConversation();
  eventRow = {
    id: 42,
    workspace_id: "ws_1",
    event_type: "appointment_upcoming",
    subject_id: "appt_1",
  };
  loadVariableContextImpl = async () => ({
    ok: true,
    ctx: {
      contactName: "María",
      contactPhone: "+15550000001",
      businessName: "Vet Demo",
      appointment: null,
    },
  });

  const outcome = await executeRun(makeRun({ trigger_type: "appointment_upcoming" }));
  assert.equal(outcome, "failed");
  assert.equal(lastRunUpdate().error, "missing_appointment");
  assert.equal(sendCalls.length, 0);
  assert.equal(dispatchRpcCalls().length, 0);
});

test("63. la cita cancelada justo antes de enviar queda skipped/appointment_not_active", async () => {
  reset();
  ruleRow = { ...APPOINTMENT_RULE };
  withLiveConversation();
  eventRow = {
    id: 42,
    workspace_id: "ws_1",
    event_type: "appointment_upcoming",
    subject_id: "appt_1",
  };
  loadVariableContextImpl = async () => ({
    ok: true,
    ctx: {
      contactName: "María",
      contactPhone: "+15550000001",
      businessName: "Vet Demo",
      appointment: { status: "cancelled", date: "martes 8 de septiembre", time: "20:00" },
    },
  });

  const outcome = await executeRun(makeRun({ trigger_type: "appointment_upcoming" }));
  assert.equal(outcome, "skipped");
  assert.equal(lastRunUpdate().error, "appointment_not_active");
  assert.equal(sendCalls.length, 0);
  assert.equal(
    dispatchRpcCalls().length,
    0,
    "no se marca dispatched_at para una cita que ya no está booked/confirmed",
  );
});

test("64. booked y confirmed SÍ envían", async () => {
  for (const status of ["booked", "confirmed"]) {
    reset();
    ruleRow = { ...APPOINTMENT_RULE };
    withLiveConversation();
    eventRow = {
      id: 42,
      workspace_id: "ws_1",
      event_type: "appointment_upcoming",
      subject_id: "appt_1",
    };
    loadVariableContextImpl = async () => ({
      ok: true,
      ctx: {
        contactName: "María",
        contactPhone: "+15550000001",
        businessName: "Vet Demo",
        appointment: { status, date: "martes 8 de septiembre", time: "20:00" },
      },
    });

    assert.equal(
      await executeRun(makeRun({ trigger_type: "appointment_upcoming" })),
      "done",
      status,
    );
    assert.equal(sendCalls.length, 1, status);
  }
});

test("65. un fallo de LECTURA de la cita se reintenta, nunca se cierra como configuración", async () => {
  reset();
  ruleRow = { ...APPOINTMENT_RULE };
  withLiveConversation();
  eventRow = {
    id: 42,
    workspace_id: "ws_1",
    event_type: "appointment_upcoming",
    subject_id: "appt_1",
  };
  loadVariableContextImpl = async () => ({ ok: false, error: "no pude leer la cita" });

  const outcome = await executeRun(makeRun({ trigger_type: "appointment_upcoming" }));
  assert.equal(
    outcome,
    "retry",
    "un hipo transitorio de la base no puede cancelar un recordatorio legítimo",
  );
  assert.equal(sendCalls.length, 0);
  assert.equal(dispatchRpcCalls().length, 0);
});

test("66. un trigger que no es appointment_upcoming no consulta automation_events (sin queries de más)", async () => {
  reset();
  ruleRow = { ...TEMPLATE_RULE };
  withLiveConversation();

  assert.equal(await executeRun(makeRun()), "done");
  assert.equal(
    selectFilters.some((f) => f.table === "automation_events"),
    false,
  );
  assert.equal(
    (loadVariableContextCalls.at(-1) as Record<string, unknown>).appointmentId,
    null,
  );
});
