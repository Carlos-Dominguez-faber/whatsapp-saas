import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

interface QueueEntry {
  data?: unknown;
  error?: unknown;
}

let responseQueue: QueueEntry[] = [];
let updates: Array<{ table: string; row: unknown; eqArgs?: unknown[][] }> = [];
let inserts: Array<{ table: string; row: unknown }> = [];
// Un select() por invocación (lookup inicial de applyTransition, o su
// relectura tras perder el CAS). Sin esto el fake tragaba los args de .eq()
// y borrar el scope de workspace en el re-read del CAS seguía en verde.
let selects: Array<{ eqArgs: unknown[][] }> = [];
const rpcCalls: Array<{ fn: string; args: unknown }> = [];
let rpcResponse: { data: unknown; error: unknown } = { data: true, error: null };
let rpcShouldThrow = false;
/** Orden de los efectos secundarios de applyTransition (rpc + notificación). */
const sideEffectOrder: string[] = [];

function nextResponse(): QueueEntry {
  return responseQueue.shift() ?? { data: null, error: null };
}

function makeSelectChain() {
  const eqArgs: unknown[][] = [];
  const chain: any = {
    eq(column: string, value: unknown) {
      eqArgs.push([column, value]);
      return chain;
    },
    single() {
      selects.push({ eqArgs: [...eqArgs] });
      return Promise.resolve(nextResponse());
    },
    // La relectura de estado del CAS usa maybeSingle: 0 filas no es un error.
    maybeSingle() {
      selects.push({ eqArgs: [...eqArgs] });
      return Promise.resolve(nextResponse());
    },
  };
  return chain;
}

const fakeClient = {
  from(table: string) {
    return {
      select() {
        return makeSelectChain();
      },
      update(row: unknown) {
        const eqArgs: unknown[][] = [];
        const chain: any = {
          eq(column: string, value: unknown) {
            eqArgs.push([column, value]);
            return chain;
          },
          select() {
            return chain;
          },
          maybeSingle() {
            updates.push({ table, row, eqArgs: [...eqArgs] });
            return Promise.resolve(nextResponse());
          },
        };
        return chain;
      },
      insert(row: unknown) {
        inserts.push({ table, row });
        return Promise.resolve(nextResponse());
      },
    };
  },
  rpc(fn: string, args: unknown) {
    rpcCalls.push({ fn, args });
    sideEffectOrder.push(fn);
    if (rpcShouldThrow) throw new Error("rpc boom");
    return Promise.resolve(rpcResponse);
  },
};

mock.module("@supabase/supabase-js", {
  exports: { createClient: () => fakeClient },
});

let rateLimitResult: { allowed: boolean; reason?: string; reservationId?: string } = {
  allowed: true,
};
mock.module("./cost-tracker.ts", {
  exports: {
    reserveLlmTurn: async () => rateLimitResult,
  },
});

let enabledTools: unknown[] = [];
mock.module("@/features/tools/services/tool-configs.ts", {
  exports: {
    getEnabledTools: async () => enabledTools,
  },
});

const notifyCalls: unknown[] = [];
let notifyShouldReject = false;
mock.module("./handoff-notifier.ts", {
  exports: {
    notifyHandoffPending: async (params: unknown) => {
      notifyCalls.push(params);
      sideEffectOrder.push("notifyHandoffPending");
      if (notifyShouldReject) throw new Error("notify boom");
    },
  },
});

const { decide, applyTransition } = await import("./decision-engine.ts");

function reset() {
  responseQueue = [];
  updates = [];
  inserts = [];
  selects = [];
  notifyCalls.length = 0;
  notifyShouldReject = false;
  rateLimitResult = { allowed: true };
  enabledTools = [];
  rpcCalls.length = 0;
  rpcResponse = { data: true, error: null };
  rpcShouldThrow = false;
  sideEffectOrder.length = 0;
}

// ── decide() ────────────────────────────────────────────────────────────

test("decide abstains when the conversation lookup fails", async () => {
  reset();
  responseQueue = [{ data: null, error: { message: "not found" } }];
  const result = await decide({
    workspaceId: "ws_1",
    conversationId: "conv_missing",
    mergedText: "hola",
    contactId: "contact_1",
  });
  assert.deepEqual(result, { decision: "abstain", reason: "conversation_not_found" });
});

test("decide abstains when the conversation is not in ai_active state", async () => {
  reset();
  responseQueue = [{ data: { state: "paused" }, error: null }];
  const result = await decide({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    mergedText: "hola",
    contactId: "contact_1",
  });
  assert.deepEqual(result, { decision: "abstain", reason: "state:paused" });
});

test("decide transitions to handoff_pending and returns 'handoff' when the message contains a handoff phrase", async () => {
  reset();
  responseQueue = [
    { data: { state: "ai_active" }, error: null },
    { data: { state: "ai_active", workspace_id: "ws_1", state_version: 4 }, error: null },
    { data: { id: "conv_1" }, error: null }, // UPDATE: ganó el CAS
    { error: null },
  ];
  const result = await decide({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    mergedText: "quiero hablar con un humano",
    contactId: "contact_1",
  });
  assert.deepEqual(result, { decision: "handoff", reason: "handoff_trigger" });
  assert.equal(updates.length, 1);
  assert.equal((updates[0].row as { state: string }).state, "handoff_pending");
  assert.equal(notifyCalls.length, 1);
  assert.deepEqual(notifyCalls[0], {
    workspaceId: "ws_1",
    conversationId: "conv_1",
    trigger: "keyword",
  });
});

test("decide rejects when applying the transition itself fails, instead of reporting a successful handoff", async () => {
  reset();
  responseQueue = [
    { data: { state: "ai_active" }, error: null },
    { data: null, error: { message: "boom" } },
  ];
  await assert.rejects(
    () =>
      decide({
        workspaceId: "ws_1",
        conversationId: "conv_1",
        mergedText: "necesito hablar con alguien",
        contactId: "contact_1",
      }),
    /conversation not found: boom/,
  );
});

test("decide still returns 'handoff' when only the notification fails — the transition itself succeeded", async () => {
  reset();
  notifyShouldReject = true;
  responseQueue = [
    { data: { state: "ai_active" }, error: null },
    { data: { state: "ai_active", workspace_id: "ws_1", state_version: 4 }, error: null },
    { data: { id: "conv_1" }, error: null }, // UPDATE: ganó el CAS
    { error: null },
  ];
  const result = await decide({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    mergedText: "quiero hablar con un humano",
    contactId: "contact_1",
  });
  assert.deepEqual(result, { decision: "handoff", reason: "handoff_trigger" });
  assert.equal(notifyCalls.length, 1);
});

test("decide returns 'rate_limited' when reserveLlmTurn denies", async () => {
  reset();
  responseQueue = [{ data: { state: "ai_active" }, error: null }];
  rateLimitResult = { allowed: false, reason: "rate_limit_contact_hour" };
  const result = await decide({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    mergedText: "hola, tengo una consulta",
    contactId: "contact_1",
  });
  assert.deepEqual(result, {
    decision: "rate_limited",
    reason: "rate_limit_contact_hour",
  });
});

test("decide returns 'respond' with the enabled tools and reservationId when all checks pass", async () => {
  reset();
  responseQueue = [{ data: { state: "ai_active" }, error: null }];
  const fakeTool = { name: "schedule_calcom" } as never;
  enabledTools = [fakeTool];
  rateLimitResult = { allowed: true, reservationId: "res_1" };
  const result = await decide({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    mergedText: "hola, tengo una consulta",
    contactId: "contact_1",
  });
  assert.deepEqual(result, {
    decision: "respond",
    reason: "normal",
    availableTools: [fakeTool],
    reservationId: "res_1",
  });
});

// ── applyTransition() ──────────────────────────────────────────────────

test("applyTransition throws when the conversation is not found", async () => {
  reset();
  responseQueue = [{ data: null, error: { message: "no rows" } }];
  await assert.rejects(
    () => applyTransition("conv_missing", "human_active"),
    /conversation not found/,
  );
});

test("applyTransition throws TransitionError on an invalid transition", async () => {
  reset();
  responseQueue = [{ data: { state: "closed", workspace_id: "ws_1" }, error: null }];
  await assert.rejects(
    () => applyTransition("conv_1", "ai_active"),
    /Invalid transition: closed → ai_active/,
  );
});

test("applyTransition sets assigned_to when transitioning to human_active with a userId", async () => {
  reset();
  responseQueue = [
    { data: { state: "ai_active", workspace_id: "ws_1", state_version: 4 }, error: null },
    { data: { id: "conv_1" }, error: null }, // UPDATE: ganó el CAS
    { error: null },
  ];
  await applyTransition("conv_1", "human_active", { userId: "user_1", trigger: "manual" });
  assert.equal(updates.length, 1);
  const row = updates[0].row as Record<string, unknown>;
  assert.equal(row.state, "human_active");
  assert.equal(row.ai_enabled, false);
  assert.equal(row.assigned_to, "user_1");
});

test("applyTransition does not set assigned_to when no userId is given", async () => {
  reset();
  responseQueue = [
    { data: { state: "ai_active", workspace_id: "ws_1", state_version: 4 }, error: null },
    { data: { id: "conv_1" }, error: null }, // UPDATE: ganó el CAS
    { error: null },
  ];
  await applyTransition("conv_1", "paused");
  const row = updates[0].row as Record<string, unknown>;
  assert.equal(row.ai_enabled, false);
  assert.equal("assigned_to" in row, false);
});

test("applyTransition logs a state_change event with from, to, actor, and trigger", async () => {
  reset();
  responseQueue = [
    { data: { state: "ai_active", workspace_id: "ws_1", state_version: 4 }, error: null },
    { data: { id: "conv_1" }, error: null }, // UPDATE: ganó el CAS
    { error: null },
  ];
  await applyTransition("conv_1", "human_active", { userId: "user_1", trigger: "manual" });
  assert.equal(inserts.length, 1);
  assert.deepEqual(inserts[0].row, {
    type: "state_change",
    level: "info",
    workspace_id: "ws_1",
    conversation_id: "conv_1",
    payload: { from: "ai_active", to: "human_active", actor: "user_1", trigger: "manual" },
  });
});

test("applyTransition logs actor 'system' when no userId is given", async () => {
  reset();
  responseQueue = [
    { data: { state: "ai_active", workspace_id: "ws_1", state_version: 4 }, error: null },
    { data: { id: "conv_1" }, error: null }, // UPDATE: ganó el CAS
    { error: null },
  ];
  await applyTransition("conv_1", "paused");
  const payload = (inserts[0].row as { payload: { actor: string } }).payload;
  assert.equal(payload.actor, "system");
});

test("applyTransition notifies the contact when transitioning into handoff_pending", async () => {
  reset();
  responseQueue = [
    { data: { state: "ai_active", workspace_id: "ws_1", state_version: 4 }, error: null },
    { data: { id: "conv_1" }, error: null }, // UPDATE: ganó el CAS
    { error: null },
  ];
  await applyTransition("conv_1", "handoff_pending", { trigger: "keyword" });
  assert.equal(notifyCalls.length, 1);
  assert.deepEqual(notifyCalls[0], {
    workspaceId: "ws_1",
    conversationId: "conv_1",
    trigger: "keyword",
  });
});

test("applyTransition does not throw when notifyHandoffPending rejects — the transition already committed", async () => {
  reset();
  notifyShouldReject = true;
  responseQueue = [
    { data: { state: "ai_active", workspace_id: "ws_1", state_version: 4 }, error: null },
    { data: { id: "conv_1" }, error: null }, // UPDATE: ganó el CAS
    { error: null },
  ];
  await applyTransition("conv_1", "handoff_pending", { trigger: "keyword" });
  assert.equal(updates.length, 1);
  assert.equal((updates[0].row as { state: string }).state, "handoff_pending");
  assert.equal(notifyCalls.length, 1);
});

test("applyTransition does not notify anyone for a transition other than handoff_pending", async () => {
  reset();
  responseQueue = [
    { data: { state: "ai_active", workspace_id: "ws_1", state_version: 4 }, error: null },
    { data: { id: "conv_1" }, error: null }, // UPDATE: ganó el CAS
    { error: null },
  ];
  await applyTransition("conv_1", "paused");
  assert.equal(notifyCalls.length, 0);
});

test("applyTransition throws when the DB update fails", async () => {
  reset();
  responseQueue = [
    { data: { state: "ai_active", workspace_id: "ws_1", state_version: 4 }, error: null },
    { error: { message: "db down" } },
  ];
  await assert.rejects(
    () => applyTransition("conv_1", "paused"),
    /failed to apply transition: db down/,
  );
});

test("applyTransition scopes both the lookup and the update to workspaceId when it is given", async () => {
  responseQueue = [
    { data: { state: "ai_active", workspace_id: "ws_1", state_version: 3 }, error: null }, // lookup
    { data: { id: "conv_1" }, error: null }, // update: ganó el CAS
    { error: null }, // events insert
  ];
  updates = [];
  selects = [];
  await applyTransition("conv_1", "human_active", {
    userId: "user_1",
    workspaceId: "ws_1",
  });
  // La mitad del "lookup" que el nombre de este test promete: sin el
  // `.eq("workspace_id", …)` en el paso 1 de applyTransition, esto sigue en
  // verde aunque el nombre diga "both".
  assert.equal(selects.length, 1);
  assert.deepEqual(selects[0].eqArgs, [
    ["id", "conv_1"],
    ["workspace_id", "ws_1"],
  ]);
  const update = updates.find((u) => u.table === "conversations");
  assert.ok(update, "conversations update must run");
  // El filtro por workspace_id es la garantía multi-tenant, y .eq("state", …) +
  // .eq("state_version", …) el CAS: los tres viajan en el MISMO
  // update y los tres se afirman acá.
  assert.deepEqual(update!.eqArgs, [
    ["id", "conv_1"],
    ["state", "ai_active"],
    ["state_version", 3],
    ["workspace_id", "ws_1"],
  ]);
});

test("applyTransition treats a conversation from another workspace as not found", async () => {
  // A scoped lookup returns no row → same failure as a missing conversation.
  responseQueue = [{ data: null, error: { message: "0 rows" } }];
  updates = [];
  await assert.rejects(
    () =>
      applyTransition("conv_other_ws", "human_active", {
        workspaceId: "ws_1",
      }),
    /conversation not found/,
  );
  assert.equal(updates.length, 0);
});

test("el UPDATE lleva el CAS sobre el estado leído, no solo el id", async () => {
  reset();
  responseQueue = [
    { data: { state: "ai_active", workspace_id: "ws_1", state_version: 3 }, error: null },
    { data: { id: "conv_1" }, error: null },
    { error: null }, // events insert
  ];
  await applyTransition("conv_1", "handoff_pending", { trigger: "keyword" });
  // Sin el .eq("state", …), dos callers que leyeron `ai_active` escriben los
  // dos `handoff_pending`: el trigger de emisión emite DOS automation_events
  // con state_version distinto y la misma regla se ejecuta dos veces.
  assert.deepEqual(updates[0].eqArgs, [
    ["id", "conv_1"],
    ["state", "ai_active"],
    ["state_version", 3],
  ]);
});

test("el UPDATE también lleva state_version en el WHERE, no solo state", async () => {
  reset();
  // Mismo caso feliz que el test anterior, con otra versión leída (5 en vez de
  // 3): afirma la MISMA composición del WHERE, no ejercita ninguna carrera.
  // No es el test de ABA — ese está más abajo, y es el que sí monta la
  // secuencia A→B→A con un UPDATE que pierde el CAS.
  responseQueue = [
    { data: { state: "ai_active", workspace_id: "ws_1", state_version: 5 }, error: null },
    { data: { id: "conv_1" }, error: null }, // update: gana el CAS
    { error: null }, // events insert
  ];
  await applyTransition("conv_1", "handoff_pending", { trigger: "keyword" });
  assert.deepEqual(updates[0].eqArgs, [
    ["id", "conv_1"],
    ["state", "ai_active"],
    ["state_version", 5],
  ]);
});

test("el UPDATE distingue una ABA real: mismo state, otra época por state_version", async () => {
  reset();
  // La secuencia: B lee `ai_active` en state_version=7.
  // Mientras tanto A mueve la conversación a `handoff_pending` y C la vuelve a
  // `ai_active` — la fila real queda en `ai_active`/state_version=9. El mismo
  // `state` a los dos lados es justo lo que un CAS de solo `.eq("state", …)`
  // NO distingue: matchearía la fila real como si B no estuviera stale.
  // `state_version` sí, porque pide la versión exacta que B leyó (7), no la 9
  // real, así que el UPDATE no afecta ninguna fila.
  responseQueue = [
    { data: { state: "ai_active", workspace_id: "ws_1", state_version: 7 }, error: null },
    { data: null, error: null }, // UPDATE: 0 filas — la versión real es 9, no 7
    { data: { state: "ai_active" }, error: null }, // relectura: sigue en ai_active (la dejó C)
  ];
  await assert.rejects(
    () => applyTransition("conv_1", "handoff_pending", { trigger: "keyword" }),
    (err: unknown) =>
      (err as { name: string }).name === "TransitionError" &&
      (err as { code: string }).code === "state_mismatch" &&
      (err as Error).message.startsWith("Invalid transition:"),
    "perder el CAS por ABA tiene que comportarse como perder el CAS por cualquier otra causa: TransitionError, nunca un éxito silencioso",
  );
  // Lo que prueba que esto no pasó "por casualidad" del state: el WHERE pidió
  // la versión que B efectivamente leyó (7). Si el código dejara de pedir
  // `state_version`, un `.eq("state", "ai_active")` solo SÍ habría matcheado
  // la fila real (que también es `ai_active`) y esta transición habría "ganado"
  // el CAS que en verdad perdió.
  assert.ok(
    updates[0].eqArgs!.some(([col, val]) => col === "state_version" && val === 7),
    "el WHERE del UPDATE debe pedir state_version=7 (la versión leída por B), no la real (9)",
  );
  assert.equal(inserts.filter((i) => i.table === "events").length, 0);
  assert.equal(notifyCalls.length, 0);
});

test("perder la carrera hacia el MISMO estado es idempotente: sin evento y sin notificar", async () => {
  reset();
  responseQueue = [
    { data: { state: "ai_active", workspace_id: "ws_1", state_version: 4 }, error: null },
    { data: null, error: null }, // UPDATE: 0 filas, otro caller ganó
    { data: { state: "handoff_pending" }, error: null }, // relectura
  ];
  await applyTransition("conv_1", "handoff_pending", { trigger: "keyword" });
  assert.equal(
    inserts.filter((i) => i.table === "events").length,
    0,
    "anunciar dos veces el mismo hecho es el bug que el CAS evita",
  );
  assert.equal(notifyCalls.length, 0);
});

test("perder la carrera hacia OTRO estado lanza TransitionError con code state_mismatch", async () => {
  reset();
  responseQueue = [
    { data: { state: "ai_active", workspace_id: "ws_1", state_version: 4 }, error: null },
    { data: null, error: null }, // UPDATE: 0 filas
    { data: { state: "closed" }, error: null }, // el ganador cerró la conversación
  ];
  await assert.rejects(
    () => applyTransition("conv_1", "handoff_pending", { trigger: "keyword" }),
    (err: unknown) =>
      (err as { name: string }).name === "TransitionError" &&
      (err as { code: string }).code === "state_mismatch" &&
      // El prefijo es contrato con las tres rutas que responden 422.
      (err as Error).message.startsWith("Invalid transition:"),
  );
  assert.equal(inserts.filter((i) => i.table === "events").length, 0);
});

test("si la relectura del estado falla, la transición NO se da por buena", async () => {
  reset();
  responseQueue = [
    { data: { state: "ai_active", workspace_id: "ws_1", state_version: 4 }, error: null },
    { data: null, error: null }, // UPDATE: 0 filas
    { data: null, error: { message: "connection reset" } }, // relectura caída
  ];
  // No saber en qué estado quedó la fila no es "quedó como pediste": el route
  // handler respondería {ok:true, state:"handoff_pending"} sobre una fila que
  // nadie miró.
  await assert.rejects(
    () => applyTransition("conv_1", "handoff_pending", { trigger: "keyword" }),
    /state re-read failed/,
  );
});

test("perder la carrera de un `take` NO es éxito, aunque el estado coincida", async () => {
  reset();
  // Dos operadores hacen `take` a la vez sobre la misma conversación. Los dos
  // leen `ai_active`, los dos piden `human_active` con SU userId. El que pierde
  // el CAS no escribió `assigned_to`: si esto retornara en silencio, la ruta le
  // respondería 200 y la UI le mostraría la conversación como propia cuando en
  // realidad quedó asignada al otro.
  responseQueue = [
    { data: { state: "ai_active", workspace_id: "ws_1", state_version: 4 }, error: null },
    { data: null, error: null }, // UPDATE: 0 filas, ganó el otro operador
    { data: { state: "human_active" }, error: null }, // el estado SÍ coincide
  ];
  await assert.rejects(
    () =>
      applyTransition("conv_1", "human_active", {
        userId: "user_2",
        trigger: "manual",
      }),
    (err: unknown) =>
      (err as { name: string }).name === "TransitionError" &&
      (err as { code: string }).code === "state_mismatch" &&
      (err as Error).message.startsWith("Invalid transition:"),
  );
  assert.equal(
    inserts.filter((i) => i.table === "events").length,
    0,
    "tampoco se anuncia el hecho: no lo produjo este caller",
  );
});

test("sin assigned_to en el payload, perder la carrera hacia el mismo estado sigue siendo idempotente", async () => {
  reset();
  // Camino correcto del mismo código: es la MISMA carrera, pero el payload no
  // llevaba `assigned_to` (no hay userId), así que el éxito silencioso vale.
  // Sin este test, el caso anterior podría implementarse lanzando siempre y
  // rompería la idempotencia de las transiciones puras.
  responseQueue = [
    { data: { state: "ai_active", workspace_id: "ws_1", state_version: 4 }, error: null },
    { data: null, error: null }, // UPDATE: 0 filas
    { data: { state: "human_active" }, error: null },
  ];
  await applyTransition("conv_1", "human_active", { trigger: "manual" });
  assert.equal(inserts.filter((i) => i.table === "events").length, 0);
  assert.equal(notifyCalls.length, 0);
});

test("perder la carrera relee el estado con el mismo scope de workspaceId que el lookup inicial", async () => {
  reset();
  // Mismo caso que "perder la carrera hacia el MISMO estado", pero con
  // workspaceId — el fake de select() antes tragaba los args de .eq(), así
  // que borrar `recheck.eq("workspace_id", …)` en decision-engine.ts seguía
  // en verde con los 25 tests existentes.
  responseQueue = [
    { data: { state: "ai_active", workspace_id: "ws_1", state_version: 4 }, error: null }, // lookup
    { data: null, error: null }, // UPDATE: 0 filas, otro caller ganó
    { data: { state: "handoff_pending" }, error: null }, // relectura
  ];
  await applyTransition("conv_1", "handoff_pending", {
    trigger: "keyword",
    workspaceId: "ws_1",
  });
  assert.equal(selects.length, 2);
  assert.deepEqual(selects[0].eqArgs, [
    ["id", "conv_1"],
    ["workspace_id", "ws_1"],
  ]);
  // El re-read tiene que llevar el mismo filtro de workspace que el lookup:
  // sin él, este caller podría dar por buena la transición de OTRO tenant.
  assert.deepEqual(selects[1].eqArgs, [
    ["id", "conv_1"],
    ["workspace_id", "ws_1"],
  ]);
});

// ── El traspaso y el cierre se ENCOLAN para HubSpot; nunca se espera a HubSpot acá ──

function winTransitionQueue() {
  responseQueue = [
    { data: { state: "ai_active", workspace_id: "ws_1", state_version: 4 }, error: null },
    { data: { id: "conv_1" }, error: null }, // UPDATE: ganó el CAS
    { error: null }, // evento state_change
  ];
}

test("handoff_pending encola con la identidad de la transición (versión leída)", async () => {
  reset();
  winTransitionQueue();
  await applyTransition("conv_1", "handoff_pending", { trigger: "manual" });
  assert.deepEqual(rpcCalls, [
    {
      fn: "enqueue_hubspot_conversation_log",
      args: { p_workspace_id: "ws_1", p_conversation_id: "conv_1", p_from_state_version: 4, p_reason: "handoff" },
    },
  ]);
});

test("handoff_pending encola ANTES de notificar al equipo (un Resend colgado no pierde el encolado)", async () => {
  reset();
  winTransitionQueue();
  await applyTransition("conv_1", "handoff_pending", { trigger: "manual" });
  assert.deepEqual(sideEffectOrder, ["enqueue_hubspot_conversation_log", "notifyHandoffPending"]);
});

test("closed encola con reason closed", async () => {
  reset();
  winTransitionQueue();
  await applyTransition("conv_1", "closed");
  assert.equal((rpcCalls[0].args as { p_reason: string }).p_reason, "closed");
});

test("otras transiciones no encolan nada", async () => {
  reset();
  winTransitionQueue();
  await applyTransition("conv_1", "human_active", { userId: "user_1" });
  assert.equal(rpcCalls.length, 0);
});

test("perder la carrera contra la misma transición no encola (sin duplicados)", async () => {
  reset();
  responseQueue = [
    { data: { state: "ai_active", workspace_id: "ws_1", state_version: 4 }, error: null },
    { data: null, error: null }, // UPDATE: perdió el CAS
    { data: { state: "closed" }, error: null }, // relectura: el ganador ya escribió "closed"
  ];
  await applyTransition("conv_1", "closed");
  assert.equal(rpcCalls.length, 0);
});

test("un error o una excepción al encolar no rompen ni revierten la transición", async () => {
  for (const mode of ["error", "throw"] as const) {
    reset();
    winTransitionQueue();
    const rawMessage = mode === "error" ? "boom" : "rpc boom";
    if (mode === "error") rpcResponse = { data: null, error: { message: rawMessage } };
    else rpcShouldThrow = true;
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => logged.push(a);
    try {
      await applyTransition("conv_1", "closed");
    } finally {
      console.error = original;
    }
    assert.equal(updates.length, 1, "la transición quedó escrita");
    // Se registra el código, no el texto crudo del error.
    assert.ok(
      logged.some((a) => String(a[0]).includes("hubspot_log_enqueue_failed")),
      `modo ${mode}: falta el código hubspot_log_enqueue_failed`,
    );
    assert.ok(
      logged.every((a) => !JSON.stringify(a).includes(rawMessage)),
      `modo ${mode}: se filtró el texto crudo del error`,
    );
  }
});
