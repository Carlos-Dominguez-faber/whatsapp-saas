import assert from "node:assert/strict";
import { mock, test } from "node:test";

type Classify = (p: {
  workspaceId: string;
  topics: Array<{ id: string }>;
  messages: unknown[];
  abortSignal: AbortSignal;
}) => Promise<unknown>;
let classifyImpl: Classify = async () => ({ ok: true, matches: [], usage: { promptTokens: 100, completionTokens: 5 } });
let classifyCalls: Array<{ workspaceId: string; topicIds: string[]; messageIds: string[] }> = [];

/** Techo fijo del fake: la cuenta real se prueba en classifier.test.ts. */
const ESTIMATE = 12_345;

mock.module("./classifier.ts", {
  exports: {
    CLASSIFY_MODEL: "openai/gpt-4o-mini",
    classificationTokenCeiling: () => ESTIMATE,
    classifyConversation: (p: Parameters<Classify>[0]) => {
      classifyCalls.push({
        workspaceId: p.workspaceId,
        topicIds: p.topics.map((t) => t.id),
        messageIds: (p.messages as Array<{ id: string }>).map((m) => m.id),
      });
      return classifyImpl(p);
    },
  },
});

const { runClassificationPhase, runBackfillPhase, CLASSIFY_DAILY_TOKEN_CAP } = await import("./classify-topics.ts");
const { MAX_PROMPT_CHARS } = await import("../lib/classify-prompt.ts");

// ── Reloj virtual ──────────────────────────────────────────
// El deadline se prueba sin esperas reales. `Date.now` y
// `AbortSignal.timeout` leen este reloj, y el fake lo avanza al "tardar".
let clock = 1_000_000;
const timers = new WeakMap<AbortSignal, { at: number; ctl: AbortController }>();
mock.method(Date, "now", () => clock);
mock.method(AbortSignal, "timeout", (ms: number) => {
  const ctl = new AbortController();
  timers.set(ctl.signal, { at: clock + Math.max(0, ms), ctl });
  if (ms <= 0) ctl.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  return ctl.signal;
});

/**
 * Tarda `ms` en el reloj virtual, salvo que el signal venza antes: ahí el reloj
 * queda en el vencimiento, el signal se aborta y devuelve `true`.
 */
function wait(ms: number, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  const t = signal ? timers.get(signal) : undefined;
  if (t && clock + ms >= t.at) {
    clock = t.at;
    t.ctl.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    return true;
  }
  clock += ms;
  return false;
}

// ── Fake de Supabase ───────────────────────────────────────
type DbError = { code: string; message?: string };
type RpcHandler = (args: Record<string, unknown>) => { data: unknown; error: DbError | null };
let rpcHandlers: Record<string, RpcHandler> = {};
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
let tables: Record<string, Array<Record<string, unknown>>> = {};
let insertError: DbError | null = null;
/** Demora por consulta: `rpc:<fn>`, `from:<tabla>` o `insert:<tabla>`. */
let delays: Record<string, number> = {};
let abortSignals = 0;
let queries = 0;

// Lo que devuelve postgrest-js 2.108 al abortar o perder la red: NO lanza, y el
// error viene sin SQLSTATE (`code: ""`, status 0; dist/index.cjs, `res.catch`).
const ABORTED = {
  data: null,
  error: { message: "TimeoutError: The operation was aborted due to timeout", details: "", hint: "", code: "" },
};

// El código real encadena `.abortSignal(...)` al final de TODA consulta.
// El fake lo HONRA: si el signal vence durante la demora, la consulta no
// ocurre y devuelve ABORTED.
function thenable(key: string, run: () => Promise<{ data?: unknown; error: unknown }>) {
  queries++;
  let signal: AbortSignal | undefined;
  const p = {
    abortSignal: (s: AbortSignal) => {
      abortSignals++;
      assert.ok(s instanceof AbortSignal);
      signal = s;
      return p;
    },
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      (async () => (wait(delays[key] ?? 0, signal) ? ABORTED : run()))().then(res, rej),
  };
  return p;
}

function query(table: string) {
  const filters: Array<[string, unknown]> = [];
  const rows = () => (tables[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
  const q = {
    select: () => q,
    eq: (col: string, val: unknown) => {
      filters.push([col, val]);
      return q;
    },
    order: () => q,
    limit: (n: number) => thenable(`from:${table}`, async () => ({ data: rows().slice(0, n), error: null })),
    range: (from: number, to: number) =>
      thenable(`from:${table}`, async () => ({ data: rows().slice(from, to + 1), error: null })),
    insert: (row: Record<string, unknown>) =>
      thenable(`insert:${table}`, async () => {
        inserts.push({ table, row });
        return { error: insertError };
      }),
  };
  return q;
}

const db = {
  rpc: (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    return thenable(`rpc:${fn}`, async () => {
      const h = rpcHandlers[fn];
      return h ? h(args) : { data: null, error: null };
    });
  },
  from: (table: string) => query(table),
} as never;

const WS_A = "ws-a";
const WS_B = "ws-b";
const conv = (id: string, ws = WS_A) => ({ conversation_id: id, workspace_id: ws, contact_id: `c-${id}`, last_message_at: "2026-09-14T20:00:00Z" });
const topic = (id: string, ws: string, name: string) => ({
  id, workspace_id: ws, name, description: "x", status: "active", backfill_status: "pending",
});
const message = (id: string, conversationId: string, ws: string) => ({
  id, conversation_id: conversationId, workspace_id: ws, direction: "in", sender_user_id: null, body: "caro", created_at: "2026-09-14T19:00:00Z",
});

const OK_RESULT = { ok: true, matches: [{ topic_id: "t1", message_id: "m1" }], usage: { promptTokens: 100, completionTokens: 5 } };
/** Lo que le queda al signal del LLM en el reloj virtual. */
const budgetOf = (s: AbortSignal) => (timers.get(s)?.at ?? Infinity) - clock;
/**
 * LLM que tarda `ms(presupuesto)`. Con `honorSignal` corta al vencer, como el
 * cliente real (`timeout`); sin él simula un proveedor que no respeta el abort.
 */
const llmTaking =
  (ms: (budget: number) => number, honorSignal = true, done: unknown = OK_RESULT): Classify =>
  async (p) =>
    wait(ms(budgetOf(p.abortSignal)), honorSignal ? p.abortSignal : undefined)
      ? { ok: false, code: "timeout", usage: null }
      : done;

function reset() {
  classifyImpl = llmTaking(() => 0);
  classifyCalls = [];
  rpcCalls = [];
  inserts = [];
  insertError = null;
  abortSignals = 0;
  queries = 0;
  delays = {};
  clock = 1_000_000;
  // Las filas llevan las columnas por las que filtra el código: el fake de
  // `eq()` filtra de verdad.
  tables = {
    insight_topics: [topic("t1", WS_A, "Precio")],
    messages: [
      ["d1", WS_A], ["d2", WS_A], ["d3", WS_A], ["dB", WS_A], ["d2", WS_B], ["dC", "ws-c"],
    ].map(([c, ws]) => message(c === "d1" && ws === WS_A ? "m1" : `m-${c}-${ws}`, c, ws)),
  };
  let served = false;
  rpcHandlers = {
    select_conversations_to_classify: () => {
      if (served) return { data: [], error: null };
      served = true;
      return { data: [conv("d1")], error: null };
    },
    // Como la RPC real con saldo: devuelve el id de la fila reservada.
    reserve_classification_tokens: () => ({ data: "res-1", error: null }),
    settle_classification_tokens: () => ({ data: true, error: null }),
    save_conversation_topics: () => ({ data: 1, error: null }),
    record_classification_failure: () => ({ data: 1, error: null }),
  };
}

const later = () => Date.now() + 50_000;
const callsTo = (fn: string) => rpcCalls.filter((c) => c.fn === fn);

test("fase 1: reserva, clasifica, liquida con el consumo real y guarda con classified_until", async () => {
  reset();
  const r = await runClassificationPhase(later(), db);
  assert.deepEqual(r, { classified: 1, failed: 0, skipped_workspaces: 0, halt: false });
  assert.deepEqual(callsTo("save_conversation_topics")[0].args, {
    p_workspace_id: WS_A,
    p_conversation_id: "d1",
    p_matches: [{ topic_id: "t1", message_id: "m1" }],
    p_classified_until: "2026-09-14T20:00:00Z",
    p_window_from: "2026-09-14T19:00:00Z",
    p_truncated_at: [],
  });
  // La reserva lleva el techo y el tope; el consumo no se inserta
  // aparte (la fila la crea la reserva, sin contact_id), se liquida.
  assert.deepEqual(callsTo("reserve_classification_tokens").map((c) => c.args), [
    { p_workspace_id: WS_A, p_conversation_id: "d1", p_estimate: ESTIMATE, p_cap: CLASSIFY_DAILY_TOKEN_CAP },
  ]);
  assert.deepEqual(callsTo("settle_classification_tokens").map((c) => c.args), [
    { p_reservation_id: "res-1", p_workspace_id: WS_A, p_model: "openai/gpt-4o-mini", p_prompt_tokens: 100, p_completion_tokens: 5 },
  ]);
  assert.equal(inserts.length, 0, "el consumo se insertó por fuera de la reserva");
  const fns = rpcCalls.map((c) => c.fn);
  assert.ok(fns.indexOf("reserve_classification_tokens") < fns.indexOf("settle_classification_tokens"));
  assert.ok(fns.indexOf("settle_classification_tokens") < fns.indexOf("save_conversation_topics"));
  // TODA consulta lleva el deadline común, no solo alguna.
  assert.ok(queries > 0);
  assert.equal(abortSignals, queries, "alguna consulta salió sin abortSignal");
  // Reclama con lease.
  assert.equal(callsTo("select_conversations_to_classify")[0].args.p_lease_seconds, 120);
});

test("el guardado declara la ventana que vio el LLM y los cuerpos recortados", async () => {
  reset();
  const long = (id: string, at: string, body: string) => ({ ...message(id, "d1", WS_A), created_at: at, body });
  // Como los entrega la consulta real (created_at DESC); el fake no ordena.
  tables.messages = [
    long("m-new", "2026-09-14T19:00:00Z", "y".repeat(MAX_PROMPT_CHARS + 5)),
    long("m1", "2026-09-14T18:00:00Z", "caro"),
    long("m-old", "2026-09-14T17:00:00Z", "x".repeat(MAX_PROMPT_CHARS + 1)),
  ];
  const r = await runClassificationPhase(later(), db);
  assert.equal(r.classified, 1);
  const args = callsTo("save_conversation_topics")[0].args;
  assert.equal(args.p_window_from, "2026-09-14T17:00:00Z");
  assert.deepEqual(args.p_truncated_at, ["2026-09-14T17:00:00Z", "2026-09-14T19:00:00Z"]);
});

test("sin mensajes no hay ventana ni recortes (y el guardado igual avanza)", async () => {
  reset();
  tables.messages = [];
  const r = await runClassificationPhase(later(), db);
  assert.equal(r.classified, 1);
  assert.equal(callsTo("reserve_classification_tokens").length, 0);
  const args = callsTo("save_conversation_topics")[0].args;
  assert.equal(args.p_window_from, null);
  assert.deepEqual(args.p_truncated_at, []);
});

test("una reserva ANTES DE CADA llamada, no una vez por lote", async () => {
  reset();
  let round = 0;
  rpcHandlers.select_conversations_to_classify = () => {
    round++;
    return round === 1 ? { data: [conv("d1"), conv("d2"), conv("d3")], error: null } : { data: [], error: null };
  };
  const r = await runClassificationPhase(later(), db);
  assert.equal(r.classified, 3);
  assert.equal(callsTo("reserve_classification_tokens").length, 3);
  // Y en secuencia: cada llamada al LLM después de su propia reserva.
  const fns = rpcCalls.map((c) => c.fn).filter((f) => f === "reserve_classification_tokens" || f === "save_conversation_topics");
  assert.deepEqual(fns, [
    "reserve_classification_tokens", "save_conversation_topics",
    "reserve_classification_tokens", "save_conversation_topics",
    "reserve_classification_tokens", "save_conversation_topics",
  ]);
});

test("si la reserva se niega a mitad del lote, las siguientes NO se llaman", async () => {
  reset();
  let round = 0;
  rpcHandlers.select_conversations_to_classify = () => {
    round++;
    return round === 1 ? { data: [conv("d1"), conv("d2"), conv("d3")], error: null } : { data: [], error: null };
  };
  let n = 0;
  rpcHandlers.reserve_classification_tokens = () => ({ data: ++n > 1 ? null : "res-1", error: null });
  const r = await runClassificationPhase(later(), db);
  assert.equal(r.classified, 1);
  assert.equal(r.skipped_workspaces, 1);
  assert.equal(classifyCalls.length, 1, "se gastó más de una llamada después de pasar el tope");
});

test("reserva caída por infraestructura → halt, SIN llamar al LLM y sin gastar intento", async () => {
  // Con cualquier código, incluido uno de datos: sin reserva no hay llamada, y
  // la contabilidad rota nunca es culpa de la conversación.
  for (const code of ["22023", "42501", "57014", "PGRST000", ""]) {
    reset();
    rpcHandlers.reserve_classification_tokens = () => ({ data: null, error: { code } });
    const r = await runClassificationPhase(later(), db);
    assert.deepEqual(
      r,
      { classified: 0, failed: 0, skipped_workspaces: 0, halt: true, error: "budget_reserve_failed" },
      `code ${code}`,
    );
    assert.equal(classifyCalls.length, 0, `code ${code}: llamó al LLM sin reserva`);
    assert.equal(callsTo("record_classification_failure").length, 0, `code ${code}: quemó un intento`);
    assert.equal(callsTo("save_conversation_topics").length, 0);
  }
});

test("llamada cortada por el proveedor lento → la reserva NO se liquida (queda la estimación), halt sin intento", async () => {
  reset();
  // Presupuesto completo de 20 s (later()) y el LLM igual se corta: el
  // proveedor no respondió. OpenRouter factura igual, así que liquidar en 0
  // subcontaría el día.
  classifyImpl = llmTaking((budget) => budget + 1);
  const r = await runClassificationPhase(later(), db);
  assert.deepEqual(r, { classified: 0, failed: 0, skipped_workspaces: 0, halt: true, error: "timeout" });
  assert.equal(callsTo("reserve_classification_tokens").length, 1);
  assert.equal(callsTo("settle_classification_tokens").length, 0, "liquidó una llamada sin consumo conocido");
  assert.equal(callsTo("record_classification_failure").length, 0);
});

test("sin tiempo para los 20 s completos del LLM → ni reserva ni llama (fase 1: piso 35 s)", async () => {
  // Antes salía con el presupuesto recortado (15 s acá): se cortaba, se pagaba
  // y la reserva quedaba en el techo.
  for (const ms of [25_000, 34_999]) {
    reset();
    const r = await runClassificationPhase(clock + ms, db);
    assert.deepEqual(r, { classified: 0, failed: 0, skipped_workspaces: 0, halt: false }, `${ms}`);
    assert.equal(callsTo("reserve_classification_tokens").length, 0, `${ms}: reservó sin tiempo para la llamada`);
    assert.equal(classifyCalls.length, 0, `${ms}: llamó sin tiempo para la llamada`);
    assert.equal(callsTo("record_classification_failure").length, 0);
  }
  // Con el piso justo, la llamada sale con los 20 s enteros.
  reset();
  let budget = 0;
  classifyImpl = async (p) => ((budget = budgetOf(p.abortSignal)), OK_RESULT);
  const r = await runClassificationPhase(clock + 35_000, db);
  assert.equal(r.classified, 1);
  assert.equal(budget, 20_000);
});

test("fase 2 (backfill) usa el mismo piso, con tres escrituras: 40 s", async () => {
  resetBackfill([[conv("d1")]]);
  const r = await runBackfillPhase(clock + 39_999, db);
  assert.deepEqual(r, { processed: 0, failed: 0, topics_done: 0, topics_expired: 0, halt: false });
  assert.equal(callsTo("reserve_classification_tokens").length, 0);
  assert.equal(classifyCalls.length, 0);
  assert.equal(callsTo("advance_topic_backfill").length, 0);
  assert.equal(callsTo("record_backfill_failure").length, 0);

  resetBackfill([[conv("d1")]]);
  const r2 = await runBackfillPhase(clock + 40_000, db);
  assert.equal(r2.processed, 1);
  assert.equal(classifyCalls.length, 1);
});

test("si falla la liquidación, la estimación ya cuenta: se guarda el resultado y la fase sigue", async () => {
  for (const code of ["", "57014", "42501"]) {
    reset();
    rpcHandlers.settle_classification_tokens = () => ({ data: null, error: { code } });
    const r = await runClassificationPhase(later(), db);
    assert.deepEqual(r, { classified: 1, failed: 0, skipped_workspaces: 0, halt: false }, `code ${code}`);
    assert.equal(callsTo("save_conversation_topics").length, 1);
  }
});

test("proveedor caído → halt, CERO intentos registrados y una sola llamada", async () => {
  reset();
  // Si el fallo se registrara, el lease se soltaría y la
  // misma conversación volvería en la vuelta siguiente, hasta la cuarentena.
  let round = 0;
  rpcHandlers.select_conversations_to_classify = () => ({ data: ++round <= 3 ? [conv("d1")] : [], error: null });
  classifyImpl = async () => ({ ok: false, code: "provider_unavailable", usage: null });
  const r = await runClassificationPhase(later(), db);
  assert.deepEqual(r, { classified: 0, failed: 0, skipped_workspaces: 0, halt: true, error: "provider_unavailable" });
  assert.equal(callsTo("record_classification_failure").length, 0, "una caída del proveedor quemó un intento");
  assert.equal(classifyCalls.length, 1);
});

test("un fallo sin consumo perdido no marca halt, aunque tampoco se pueda registrar", async () => {
  reset();
  rpcHandlers.save_conversation_topics = () => ({ data: null, error: { code: "P0001" } });
  rpcHandlers.record_classification_failure = () => ({ data: null, error: { code: "57014" } });
  const r = await runClassificationPhase(later(), db);
  assert.equal(r.error, "record_failure_failed");
  assert.equal(r.halt, false);
});

test("tope: reserva negada → salta el workspace SIN llamar al LLM ni gastar intento", async () => {
  // El borde (consumo + techo vs. tope) lo decide la RPC: caso r de
  // scripts/verify-classify-topics.sql.
  reset();
  rpcHandlers.reserve_classification_tokens = () => ({ data: null, error: null });
  const r = await runClassificationPhase(later(), db);
  assert.deepEqual(r, { classified: 0, failed: 0, skipped_workspaces: 1, halt: false });
  assert.equal(classifyCalls.length, 0);
  assert.equal(callsTo("save_conversation_topics").length, 0);
  assert.equal(callsTo("settle_classification_tokens").length, 0);
  assert.equal(callsTo("record_classification_failure").length, 0);
});

test("tope: el workspace saltado va en p_skip_workspaces y otro workspace bajo el tope sigue", async () => {
  reset();
  let round = 0;
  rpcHandlers.select_conversations_to_classify = (args) => {
    round++;
    if (round === 1) return { data: [conv("d1", WS_A)], error: null };
    if (round === 2) {
      assert.deepEqual(args.p_skip_workspaces, [WS_A]);
      return { data: [conv("d2", WS_B)], error: null };
    }
    return { data: [], error: null };
  };
  rpcHandlers.reserve_classification_tokens = (args) => ({ data: args.p_workspace_id === WS_A ? null : "res-b", error: null });
  tables.insight_topics = [topic("t1", WS_A, "Precio"), topic("t1", WS_B, "Precio")];
  const r = await runClassificationPhase(later(), db);
  assert.deepEqual(r, { classified: 1, failed: 0, skipped_workspaces: 1, halt: false });
  assert.deepEqual(classifyCalls.map((c) => c.workspaceId), [WS_B]);
});


test("si no se puede registrar el fallo de una conversación, la fase falla", async () => {
  reset();
  classifyImpl = async () => ({ ok: false, code: "provider_error", usage: null });
  rpcHandlers.record_classification_failure = () => ({ data: null, error: { code: "57014" } });
  const r = await runClassificationPhase(later(), db);
  assert.equal(r.error, "record_failure_failed");
});

test("fallo de clasificación → record_classification_failure con el código; no avanza", async () => {
  reset();
  classifyImpl = async () => ({ ok: false, code: "invalid_output", usage: { promptTokens: 50, completionTokens: 1 } });
  const r = await runClassificationPhase(later(), db);
  assert.deepEqual(r, { classified: 0, failed: 1, skipped_workspaces: 0, halt: false });
  assert.deepEqual(callsTo("record_classification_failure")[0].args, {
    p_workspace_id: WS_A,
    p_conversation_id: "d1",
    p_code: "invalid_output",
  });
  assert.equal(callsTo("save_conversation_topics").length, 0);
  // Los tokens gastados se liquidan igual.
  assert.equal(callsTo("settle_classification_tokens")[0].args.p_prompt_tokens, 50);
});

test("la RPC rechaza los DATOS del save → cuenta como fallo save_failed, sin halt", async () => {
  for (const code of ["P0001", "23503", "22P02"]) {
    reset();
    rpcHandlers.save_conversation_topics = () => ({ data: null, error: { code } });
    const r = await runClassificationPhase(later(), db);
    assert.equal(r.failed, 1, `code ${code}`);
    assert.equal(r.halt, false);
    assert.equal(r.error, undefined);
    assert.equal(callsTo("record_classification_failure")[0].args.p_code, "save_failed");
  }
});

test("save caído por infraestructura → halt, sin gastar intento y sin seguir con el lote", async () => {
  // "" = abort/red de postgrest-js; el resto, SQLSTATE o PGRST que no son de la fila.
  for (const code of ["", "PGRST000", "57014", "08006", "40001", "42501", "XX000"]) {
    reset();
    let round = 0;
    rpcHandlers.select_conversations_to_classify = () =>
      ++round === 1 ? { data: [conv("d1"), conv("d2")], error: null } : { data: [], error: null };
    rpcHandlers.save_conversation_topics = () => ({ data: null, error: { code } });
    const r = await runClassificationPhase(later(), db);
    assert.deepEqual(
      r,
      { classified: 0, failed: 0, skipped_workspaces: 0, halt: true, error: "save_infra_failed" },
      `code ${code}`,
    );
    assert.equal(callsTo("record_classification_failure").length, 0, `code ${code}: quemó un intento`);
    assert.equal(classifyCalls.length, 1, `code ${code}: pagó otra llamada con la base caída`);
  }
});

test("no poder leer mensajes o temas es infraestructura, no un intento", async () => {
  reset();
  delays["from:messages"] = 6_000; // vence el techo de 5 s, no el deadline
  const r1 = await runClassificationPhase(later(), db);
  assert.deepEqual(r1, { classified: 0, failed: 0, skipped_workspaces: 0, halt: false, error: "load_messages_failed" });
  assert.equal(callsTo("record_classification_failure").length, 0);
  assert.equal(classifyCalls.length, 0);

  reset();
  delays["from:insight_topics"] = 6_000;
  const r2 = await runClassificationPhase(later(), db);
  assert.deepEqual(r2, { classified: 0, failed: 0, skipped_workspaces: 0, halt: false, error: "load_topics_failed" });
  assert.equal(callsTo("record_classification_failure").length, 0);
});

test("excepción inesperada en una conversación → código unexpected, la fase no lanza", async () => {
  reset();
  classifyImpl = async () => {
    throw new Error("boom");
  };
  const r = await runClassificationPhase(later(), db);
  assert.equal(r.failed, 1);
  assert.equal(callsTo("record_classification_failure")[0].args.p_code, "unexpected");
});

test("error en la selección → la fase devuelve error select_failed", async () => {
  reset();
  rpcHandlers.select_conversations_to_classify = () => ({ data: null, error: { code: "42P01" } });
  const r = await runClassificationPhase(later(), db);
  assert.equal(r.error, "select_failed");
  assert.equal(r.halt, false, "select_failed no deja gasto sin contar: la fase 2 puede correr");
});

test("sin tiempo suficiente no selecciona nada", async () => {
  reset();
  const r = await runClassificationPhase(Date.now() + 5_000, db);
  assert.deepEqual(r, { classified: 0, failed: 0, skipped_workspaces: 0, halt: false });
  assert.equal(rpcCalls.length, 0);
});

// ── Deadline, con el reloj virtual ───────────────
const idle = { classified: 0, failed: 0, skipped_workspaces: 0, halt: false };

test("sin margen para la reserva, el LLM y sus dos escrituras → no_time: ni reserva ni llama", async () => {
  reset();
  delays["from:insight_topics"] = 3_000;
  delays["from:messages"] = 3_000;
  const r = await runClassificationPhase(clock + 21_000, db); // tras leer quedan 15 s = 3 × 5 s
  assert.deepEqual(r, idle);
  assert.equal(classifyCalls.length, 0, "arrancó una llamada sin margen para registrarla");
  assert.equal(callsTo("reserve_classification_tokens").length, 0, "reservó sin margen para llamar");
  assert.equal(callsTo("record_classification_failure").length, 0);
});

test("LLM que usa casi todo su presupuesto + liquidación lenta → el save igual se completa", async () => {
  reset();
  classifyImpl = llmTaking((budget) => budget - 100);
  const saved: unknown[] = [];
  rpcHandlers.save_conversation_topics = (args) => (saved.push(args), { data: 1, error: null });
  delays["rpc:settle_classification_tokens"] = 4_900;
  delays["rpc:save_conversation_topics"] = 4_900;
  const r = await runClassificationPhase(clock + 35_000, db); // justo el piso de la fase 1
  assert.deepEqual(r, { ...idle, classified: 1 });
  assert.equal(saved.length, 1);
  assert.equal(callsTo("record_classification_failure").length, 0);
});

test("si el LLM se pasa y el save aborta por el deadline, es no_time: no gasta intento ni da 500", async () => {
  reset();
  classifyImpl = llmTaking((budget) => budget + 9_000, false); // el proveedor no respetó el abort
  delays["rpc:settle_classification_tokens"] = 4_000; // de 35 s quedan 2
  delays["rpc:save_conversation_topics"] = 3_000;
  const r = await runClassificationPhase(clock + 35_000, db);
  assert.deepEqual(r, idle);
  assert.equal(callsTo("settle_classification_tokens").length, 1, "el consumo sí se liquidó");
  assert.equal(callsTo("record_classification_failure").length, 0);
});

test("el tiempo se revisa a mitad del lote: la segunda conversación no arranca", async () => {
  reset();
  let round = 0;
  rpcHandlers.select_conversations_to_classify = () =>
    ++round === 1 ? { data: [conv("d1"), conv("d2"), conv("d3")], error: null } : { data: [], error: null };
  classifyImpl = llmTaking(() => 36_000, false); // de 50 s quedan 14, bajo el mínimo de 15
  const r = await runClassificationPhase(clock + 50_000, db);
  assert.deepEqual(r, { ...idle, classified: 1 });
  assert.equal(classifyCalls.length, 1);
  assert.equal(callsTo("reserve_classification_tokens").length, 1);
  assert.equal(callsTo("record_classification_failure").length, 0);
});

test("registrar el fallo cortado por el deadline es sin tiempo; por su propio techo, infraestructura", async () => {
  reset();
  const failing = { ok: false, code: "provider_error", usage: null };
  classifyImpl = llmTaking((budget) => budget + 11_000, false, failing); // de 35 s quedan 4
  delays["rpc:record_classification_failure"] = 5_000;
  const r1 = await runClassificationPhase(clock + 35_000, db);
  assert.deepEqual(r1, { ...idle, failed: 1 });

  reset();
  classifyImpl = llmTaking(() => 0, true, failing);
  delays["rpc:record_classification_failure"] = 6_000; // vence el techo de 5 s con tiempo de sobra
  const r2 = await runClassificationPhase(later(), db);
  assert.equal(r2.error, "record_failure_failed");
});

test("loadMessages y loadTopics filtran por workspace (y los temas por estado)", async () => {
  reset();
  tables.insight_topics.push(topic("t-ajeno", WS_B, "Ajeno"), { ...topic("t-viejo", WS_A, "Viejo"), status: "archived" });
  tables.messages.push(message("m-ajeno", "d1", WS_B));
  const r = await runClassificationPhase(later(), db);
  assert.equal(r.classified, 1);
  assert.deepEqual(classifyCalls[0].topicIds, ["t1"], "entraron temas de otro workspace o archivados");
  assert.deepEqual(classifyCalls[0].messageIds, ["m1"], "entraron mensajes de otro workspace");
});

// ── Fase 2 ─────────────────────────────────────────────────
function resetBackfill(batches: Array<Array<ReturnType<typeof conv>>>) {
  reset();
  tables.insight_topics = [topic("t-new", WS_A, "Nuevo")];
  let i = 0;
  rpcHandlers.next_backfill_batch = () => ({ data: batches[i++] ?? [], error: null });
  // Como la RPC real: devuelve el backfill_status con que quedó el tema.
  rpcHandlers.advance_topic_backfill = (args) => ({ data: args.p_done ? "done" : "pending", error: null });
  rpcHandlers.record_backfill_failure = () => ({ data: 1, error: null });
  // Como la RPC real sin otra corrida encima: el reclamo se concede.
  rpcHandlers.claim_topic_backfill = () => ({ data: true, error: null });
  rpcHandlers.release_topic_backfill = () => ({ data: null, error: null });
}

test("fase 2: prompt solo con el tema, sin classified_until, avanza el cursor y cierra", async () => {
  resetBackfill([[conv("d1"), conv("d2")]]);
  const r = await runBackfillPhase(later(), db);
  assert.deepEqual(r, { processed: 2, failed: 0, topics_done: 1, topics_expired: 0, halt: false });
  assert.ok(classifyCalls.every((c) => c.topicIds.length === 1 && c.topicIds[0] === "t-new"));
  assert.ok(callsTo("save_conversation_topics").every((c) => c.args.p_classified_until === null));
  const advances = callsTo("advance_topic_backfill").map((c) => c.args);
  assert.deepEqual(advances[0], { p_topic_id: "t-new", p_cursor_at: "2026-09-14T20:00:00Z", p_cursor_id: "d2", p_done: false });
  assert.deepEqual(advances[1], { p_topic_id: "t-new", p_cursor_at: null, p_cursor_id: null, p_done: true });
});

test("fase 2: falla la segunda del lote → avanza hasta la primera, registra fallo y corta el tema", async () => {
  resetBackfill([[conv("d1"), conv("d2"), conv("d3")]]);
  classifyImpl = async () => {
    const n = classifyCalls.length;
    return n === 2 ? { ok: false, code: "provider_error", usage: null } : { ok: true, matches: [], usage: null };
  };
  const r = await runBackfillPhase(later(), db);
  assert.equal(r.failed, 1);
  assert.equal(r.topics_done, 0);
  const order = rpcCalls.filter((c) => c.fn === "advance_topic_backfill" || c.fn === "record_backfill_failure").map((c) => c.fn);
  assert.deepEqual(order, ["advance_topic_backfill", "record_backfill_failure"]);
  assert.equal(callsTo("advance_topic_backfill")[0].args.p_cursor_id, "d1");
});

test("fase 2: tercer fallo seguido → salta la conversación y sigue con el tema", async () => {
  resetBackfill([[conv("d1")], [conv("d2")], []]);
  rpcHandlers.record_backfill_failure = () => ({ data: 3, error: null });
  classifyImpl = async () => (classifyCalls.length === 1 ? { ok: false, code: "invalid_output", usage: null } : { ok: true, matches: [], usage: null });
  const r = await runBackfillPhase(later(), db);
  const advances = callsTo("advance_topic_backfill").map((c) => c.args);
  assert.equal(advances[0].p_cursor_id, "d1"); // salto
  assert.equal(advances[1].p_cursor_id, "d2");
  assert.equal(advances[2].p_done, true);
  assert.equal(r.topics_done, 1);
});

test("fase 2: reserva negada → no reprocesa, no avanza, no cuenta fallo y suelta el tema", async () => {
  resetBackfill([[conv("d1")]]);
  rpcHandlers.reserve_classification_tokens = () => ({ data: null, error: null });
  const r = await runBackfillPhase(later(), db);
  assert.deepEqual(r, { processed: 0, failed: 0, topics_done: 0, topics_expired: 0, halt: false });
  assert.equal(classifyCalls.length, 0);
  assert.equal(callsTo("advance_topic_backfill").length, 0);
  assert.equal(callsTo("record_backfill_failure").length, 0);
  assert.deepEqual(callsTo("release_topic_backfill").map((c) => c.args.p_topic_id), ["t-new"]);
});

test("40 s, LLM que agota su presupuesto, dos escrituras de 4,9 s y avance de 1 s → el cursor avanza", async () => {
  resetBackfill([[conv("d1")]]);
  const advanced: unknown[] = [];
  rpcHandlers.advance_topic_backfill = (args) => {
    advanced.push(args.p_cursor_id);
    return { data: args.p_done ? "done" : "pending", error: null };
  };
  // Con la reserva de dos escrituras, el avance de 1 s vencería tras la
  // liquidación y el save. 40 s es justo el piso de la fase 2.
  classifyImpl = llmTaking((budget) => budget - 100);
  delays["rpc:settle_classification_tokens"] = 4_900;
  delays["rpc:save_conversation_topics"] = 4_900;
  delays["rpc:advance_topic_backfill"] = 1_000;
  const r = await runBackfillPhase(clock + 40_000, db);
  assert.equal(callsTo("save_conversation_topics").length, 1);
  assert.deepEqual(advanced, ["d1"], "el resultado quedó pagado y guardado, pero el cursor no avanzó");
  assert.equal(r.processed, 1);
  assert.equal(r.error, undefined);
});

test("lote vacío con la ventana vencida cuenta como expired, no como done", async () => {
  resetBackfill([[]]);
  rpcHandlers.advance_topic_backfill = () => ({ data: "expired", error: null });
  const r = await runBackfillPhase(later(), db);
  assert.deepEqual(r, { processed: 0, failed: 0, topics_done: 0, topics_expired: 1, halt: false });
  assert.equal(callsTo("advance_topic_backfill")[0].args.p_done, true);
});

test("20 temas de workspaces sin saldo no bloquean al 21º con saldo", async () => {
  resetBackfill([]);
  tables.insight_topics = [
    ...Array.from({ length: 20 }, (_, i) => topic(`t-a${i}`, WS_A, `A${i}`)),
    topic("t-c", "ws-c", "C"),
  ];
  // Como la RPC real: el lote es del workspace del tema, una vez por tema.
  const served = new Set<string>();
  rpcHandlers.next_backfill_batch = (args) => {
    const id = String(args.p_topic_id);
    if (served.has(id)) return { data: [], error: null };
    served.add(id);
    return { data: [id === "t-c" ? conv("dC", "ws-c") : conv("d1", WS_A)], error: null };
  };
  rpcHandlers.reserve_classification_tokens = (args) => ({
    data: args.p_workspace_id === "ws-c" ? "res-c" : null,
    error: null,
  });
  const r = await runBackfillPhase(later(), db);
  // Antes, `.limit(20)` se comía la página entera con los temas de A y el de C
  // nunca era consultado; si A agota el tope cada noche, quedaba bloqueado.
  assert.equal(r.processed, 1, "el tema del tercer tenant nunca se procesó");
  assert.deepEqual(classifyCalls.map((c) => c.workspaceId), ["ws-c"]);
  // A se intenta reservar UNA vez, no 20 (memo por workspace): sus otros 19
  // temas ni se reclaman.
  assert.equal(callsTo("reserve_classification_tokens").filter((c) => c.args.p_workspace_id === WS_A).length, 1);
  assert.equal(callsTo("claim_topic_backfill").filter((c) => String(c.args.p_topic_id).startsWith("t-a")).length, 1);
});

test("fase 2: error al pedir el lote → la fase devuelve error", async () => {
  resetBackfill([]);
  rpcHandlers.next_backfill_batch = () => ({ data: null, error: { code: "XX000" } });
  const r = await runBackfillPhase(later(), db);
  assert.equal(r.error, "backfill_batch_failed");
  assert.equal(r.halt, false);
});

test("tema reclamado por otra corrida → se salta sin pedir lote y sigue con el siguiente", async () => {
  resetBackfill([[conv("dB")], []]);
  tables.insight_topics = [
    topic("t-ocupado", WS_A, "Ocupado"),
    topic("t-libre", WS_A, "Libre"),
  ];
  rpcHandlers.claim_topic_backfill = (args) => ({ data: args.p_topic_id === "t-libre", error: null });
  const r = await runBackfillPhase(later(), db);
  assert.equal(r.processed, 1);
  assert.deepEqual(
    callsTo("claim_topic_backfill").map((c) => c.args),
    [
      { p_topic_id: "t-ocupado", p_lease_seconds: 120 },
      { p_topic_id: "t-libre", p_lease_seconds: 120 },
    ],
  );
  assert.ok(
    callsTo("next_backfill_batch").every((c) => c.args.p_topic_id === "t-libre"),
    "pidió el lote de un tema que no pudo reclamar",
  );
  assert.deepEqual(classifyCalls.map((c) => c.topicIds), [["t-libre"]]);
  // Solo suelta el lease que tomó.
  assert.deepEqual(callsTo("release_topic_backfill").map((c) => c.args.p_topic_id), ["t-libre"]);
});

test("el lease se suelta también cuando el tema se corta por un fallo reintentable", async () => {
  resetBackfill([[conv("d1")]]);
  classifyImpl = async () => ({ ok: false, code: "provider_error", usage: null });
  await runBackfillPhase(later(), db);
  assert.deepEqual(callsTo("release_topic_backfill").map((c) => c.args.p_topic_id), ["t-new"]);
});

test("error al reclamar → la fase falla sin pedir lote", async () => {
  resetBackfill([[conv("d1")]]);
  rpcHandlers.claim_topic_backfill = () => ({ data: null, error: { code: "57014" } });
  const r = await runBackfillPhase(later(), db);
  assert.equal(r.error, "backfill_claim_failed");
  assert.equal(callsTo("next_backfill_batch").length, 0);
  assert.equal(classifyCalls.length, 0);
});

test("fase 2 con la reserva caída → halt, sin llamar ni sumar fallos al tema", async () => {
  resetBackfill([[conv("d1")]]);
  rpcHandlers.reserve_classification_tokens = () => ({ data: null, error: { code: "57014" } });
  const r = await runBackfillPhase(later(), db);
  assert.deepEqual(r, { processed: 0, failed: 0, topics_done: 0, topics_expired: 0, halt: true, error: "budget_reserve_failed" });
  assert.equal(classifyCalls.length, 0);
  assert.equal(callsTo("record_backfill_failure").length, 0);
});

test("fase 2 con el proveedor caído → halt, sin sumar fallos al tema ni saltar la conversación", async () => {
  resetBackfill([[conv("d1")], [conv("d1")], [conv("d1")]]);
  rpcHandlers.record_backfill_failure = () => ({ data: 3, error: null });
  classifyImpl = async () => ({ ok: false, code: "provider_unavailable", usage: null });
  const r = await runBackfillPhase(later(), db);
  assert.deepEqual(r, { processed: 0, failed: 0, topics_done: 0, topics_expired: 0, halt: true, error: "provider_unavailable" });
  assert.equal(callsTo("record_backfill_failure").length, 0, "una caída del proveedor sumó un fallo al tema");
  assert.equal(callsTo("advance_topic_backfill").length, 0, "una caída del proveedor saltó la conversación");
  assert.equal(classifyCalls.length, 1);
});

test("fase 2 con el save caído por infraestructura → halt, sin sumar fallos al tema", async () => {
  resetBackfill([[conv("d1"), conv("d2")]]);
  rpcHandlers.save_conversation_topics = () => ({ data: null, error: { code: "" } });
  const r = await runBackfillPhase(later(), db);
  assert.deepEqual(r, { processed: 0, failed: 0, topics_done: 0, topics_expired: 0, halt: true, error: "save_infra_failed" });
  // Al tercer fallo, el tema saltaba esta conversación para siempre.
  assert.equal(callsTo("record_backfill_failure").length, 0);
  assert.equal(classifyCalls.length, 1);
});

test("fase 2 cortada por el deadline al registrar el fallo o al avanzar → sin tiempo, no error", async () => {
  resetBackfill([[conv("d1")]]);
  // Fase 2: 40 s es el piso (5 + 20 + 3 × 5); el LLM tiene sus 20 s.
  classifyImpl = llmTaking((budget) => budget + 16_000, false, { ok: false, code: "provider_error", usage: null });
  delays["rpc:record_backfill_failure"] = 5_000; // quedan 4 s
  const r1 = await runBackfillPhase(clock + 40_000, db);
  assert.deepEqual(r1, { processed: 0, failed: 1, topics_done: 0, topics_expired: 0, halt: false });
  assert.equal(callsTo("record_backfill_failure").length, 1);

  resetBackfill([[conv("d1")]]);
  classifyImpl = llmTaking((budget) => budget + 17_000, false); // quedan 3 s
  delays["rpc:advance_topic_backfill"] = 4_000;
  const r2 = await runBackfillPhase(clock + 40_000, db);
  assert.deepEqual(r2, { processed: 1, failed: 0, topics_done: 0, topics_expired: 0, halt: false });
  assert.equal(callsTo("advance_topic_backfill").length, 1);
});
