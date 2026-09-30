import assert from "node:assert/strict";
import { mock, test } from "node:test";

process.env.OPENROUTER_API_KEY = "sk-platform-test";

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

const { runClassificationPhase, runBackfillPhase, CLASSIFY_DAILY_TOKEN_CAP, BACKFILL_SHARE_MS, newRunGuards } = await import("./classify-topics.ts");
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

/** Filters the code adds besides eq/lte, as the query string sees them. */
let extraFilters: string[] = [];

function query(table: string) {
  const filters: Array<[string, unknown]> = [];
  const upTo: Array<[string, string]> = [];
  const notContains: Array<[string, Record<string, unknown>]> = [];
  const anyOf: Array<Array<(r: Record<string, unknown>) => boolean>> = [];
  const rows = () =>
    (tables[table] ?? []).filter(
      (r) =>
        filters.every(([k, v]) => r[k] === v) &&
        upTo.every(([k, v]) => String(r[k]) <= v) &&
        notContains.every(([k, v]) => {
          const cell = (r[k] ?? {}) as Record<string, unknown>;
          return !Object.entries(v).every(([kk, vv]) => cell[kk] === vv);
        }) &&
        anyOf.every((alts) => alts.some((f) => f(r))),
    );
  const q = {
    not: (col: string, op: string, val: string) => {
      extraFilters.push(`${table}:not.${col}.${op}.${val}`);
      assert.equal(op, "cs");
      notContains.push([col, JSON.parse(val)]);
      return q;
    },
    or: (expr: string) => {
      extraFilters.push(`${table}:or.${expr}`);
      // Only `col.is.null` and `col.neq.value` alternatives are used here.
      anyOf.push(
        expr.split(",").map((alt) => {
          const [col, op, ...rest] = alt.split(".");
          const val = rest.join(".");
          if (op === "is" && val === "null") return (r: Record<string, unknown>) => r[col] == null;
          if (op === "neq") return (r: Record<string, unknown>) => r[col] !== val;
          throw new Error(`unsupported or() alternative ${alt}`);
        }),
      );
      return q;
    },
    select: () => q,
    eq: (col: string, val: unknown) => {
      filters.push([col, val]);
      return q;
    },
    lte: (col: string, val: string) => {
      upTo.push([col, val]);
      return q;
    },
    order: () => q,
    limit: (n: number) => thenable(`from:${table}`, async () => ({ data: rows().slice(0, n), error: null })),
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
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
const conv = (id: string, ws = WS_A) => ({ conversation_id: id, workspace_id: ws, contact_id: `c-${id}`, last_inbound_at: "2026-09-14T20:00:00Z" });
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
  extraFilters = [];
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
  assert.deepEqual(r, { classified: 1, failed: 0, deferred: 0, skipped_workspaces: 0, unavailable_workspaces: 0, halt: false });
  assert.deepEqual(callsTo("save_conversation_topics")[0].args, {
    p_workspace_id: WS_A,
    p_conversation_id: "d1",
    p_matches: [{ topic_id: "t1", message_id: "m1" }],
    p_classified_until: "2026-09-14T20:00:00Z",
    p_window_from: "2026-09-14T19:00:00Z",
    p_truncated_at: [],
    p_catalog: ["t1"],
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
  assert.equal(callsTo("select_conversations_to_classify")[0].args.p_lease_seconds, 180);
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
      { classified: 0, failed: 0, deferred: 0, skipped_workspaces: 0, unavailable_workspaces: 0, halt: true, error: "budget_reserve_failed" },
      `code ${code}`,
    );
    assert.equal(classifyCalls.length, 0, `code ${code}: llamó al LLM sin reserva`);
    assert.equal(callsTo("record_classification_failure").length, 0, `code ${code}: quemó un intento`);
    assert.equal(callsTo("save_conversation_topics").length, 0);
  }
});

test("TRANSIENT: timeout → the reservation keeps its estimate, the conversation waits an hour, no attempt", async () => {
  reset();
  // Full 20 s budget (later()) and the LLM still times out: the provider.
  // OpenRouter bills anyway, so settling at 0 would undercount the day.
  classifyImpl = llmTaking((budget) => budget + 1);
  const r = await runClassificationPhase(later(), db);
  assert.deepEqual(r, { classified: 0, failed: 0, deferred: 1, skipped_workspaces: 0, unavailable_workspaces: 0, halt: false });
  assert.equal(callsTo("reserve_classification_tokens").length, 1);
  assert.equal(callsTo("settle_classification_tokens").length, 0, "settled a call with unknown usage");
  assert.equal(callsTo("record_classification_failure").length, 0);
  assert.deepEqual(callsTo("defer_classification").map((c) => c.args), [
    { p_workspace_id: WS_A, p_conversation_id: "d1", p_code: "timeout", p_seconds: 3600 },
  ]);
});

test("sin tiempo para los 20 s completos del LLM → ni reserva ni llama (fase 1: piso 35 s)", async () => {
  // Antes salía con el presupuesto recortado (15 s acá): se cortaba, se pagaba
  // y la reserva quedaba en el techo.
  for (const ms of [25_000, 34_999]) {
    reset();
    const r = await runClassificationPhase(clock + ms, db);
    assert.deepEqual(r, { classified: 0, failed: 0, deferred: 0, skipped_workspaces: 0, unavailable_workspaces: 0, halt: false }, `${ms}`);
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
  assert.deepEqual(r, { processed: 0, failed: 0, deferred: 0, topics_done: 0, topics_expired: 0, skipped_workspaces: 0, unavailable_workspaces: 0, halt: false });
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
    assert.deepEqual(r, { classified: 1, failed: 0, deferred: 0, skipped_workspaces: 0, unavailable_workspaces: 0, halt: false }, `code ${code}`);
    assert.equal(callsTo("save_conversation_topics").length, 1);
  }
});

test("TRANSIENT: a 5xx defers that conversation only; the run goes on with the next of the SAME workspace", async () => {
  reset();
  let round = 0;
  rpcHandlers.select_conversations_to_classify = () => ({
    data: round++ === 0 ? [conv("d1"), conv("d2")] : [],
    error: null,
  });
  classifyImpl = async () =>
    classifyCalls.length === 1
      ? { ok: false, code: "provider_unavailable", usage: { promptTokens: 0, completionTokens: 0 }, keyScope: "platform" }
      : { ok: true, matches: [], usage: { promptTokens: 100, completionTokens: 5 }, keyScope: "platform" };
  const r = await runClassificationPhase(later(), db);
  assert.deepEqual(r, { classified: 1, failed: 0, deferred: 1, skipped_workspaces: 0, unavailable_workspaces: 0, halt: false });
  assert.equal(callsTo("record_classification_failure").length, 0, "a transient failure spent an attempt");
  assert.deepEqual(callsTo("defer_classification").map((c) => c.args.p_conversation_id), ["d1"]);
  // An HTTP 5xx answer is settled at 0: nothing was generated.
  assert.equal(callsTo("settle_classification_tokens")[0].args.p_prompt_tokens, 0);
});
test("BREAKER: 3 transient failures in a row on different conversations stop the run", async () => {
  for (const code of ["provider_unavailable", "timeout"]) {
    reset();
    tables.insight_topics.push(topic("t2", WS_B, "Precio"));
    let round = 0;
    rpcHandlers.select_conversations_to_classify = () => ({
      data: [[conv("d1", WS_A)], [conv("d2", WS_B)], [conv("d3", WS_A)], [conv("d4", WS_B)]][round++] ?? [],
      error: null,
    });
    classifyImpl = async () => ({ ok: false, code, usage: null, keyScope: "platform" });
    const r = await runClassificationPhase(later(), db);
    assert.deepEqual(r, { classified: 0, failed: 0, deferred: 3, skipped_workspaces: 0, unavailable_workspaces: 0, halt: true, error: code }, code);
    assert.equal(classifyCalls.length, 3, `${code}: kept calling after the breaker`);
  }
});

test("BREAKER: any answer from the provider resets the count", async () => {
  reset();
  let round = 0;
  const rows = ["d1", "d2", "d3", "d4", "d5"].map((id) => [conv(id)]);
  for (const id of ["d4", "d5"]) tables.messages.push(message(`m-${id}`, id, WS_A));
  rpcHandlers.select_conversations_to_classify = () => ({ data: rows[round++] ?? [], error: null });
  // transient, transient, a content rejection, transient, transient: never 3 in a row.
  const codes = ["provider_unavailable", "timeout", "content_rejected", "timeout", "provider_unavailable"];
  classifyImpl = async () => ({ ok: false, code: codes[classifyCalls.length - 1], usage: null, keyScope: "platform" });
  const r = await runClassificationPhase(later(), db);
  assert.equal(r.halt, false);
  assert.equal(r.deferred, 4);
  assert.equal(r.failed, 1);
});

test("KEY: a dead own key never counts toward a halt, however many workspaces have one", async () => {
  reset();
  for (const [ws, t] of [[WS_B, "t2"], ["ws-c", "t3"], ["ws-d", "t4"]] as const) tables.insight_topics.push(topic(t, ws, "Precio"));
  for (const [id, ws] of [["a1", WS_A], ["b1", WS_B], ["c1", "ws-c"], ["d1", "ws-d"]]) tables.messages.push(message(`m-${id}-x`, id, ws));
  tables.integrations = [WS_A, WS_B, "ws-c"].map((ws) => ({
    workspace_id: ws, provider: "openrouter", credentials: { openrouter_api_key: `sk-${ws}` },
  }));
  rpcHandlers.select_conversations_to_classify = (args) => {
    const skip = args.p_skip_workspaces as string[];
    return {
      data: [conv("a1", WS_A), conv("b1", WS_B), conv("c1", "ws-c"), conv("d1", "ws-d")].filter((r) => !skip.includes(r.workspace_id)),
      error: null,
    };
  };
  let dCalls = 0;
  classifyImpl = async (p) => {
    if (p.workspaceId === "ws-d") {
      dCalls++;
      return { ok: true, matches: [], usage: { promptTokens: 100, completionTokens: 5 }, keyScope: "platform" };
    }
    return { ok: false, code: "key_rejected", usage: { promptTokens: 0, completionTokens: 0 }, keyScope: "own" };
  };
  let n = 0;
  const base = rpcHandlers.select_conversations_to_classify;
  rpcHandlers.select_conversations_to_classify = (args) => (n++ < 6 ? base(args) : { data: [], error: null });
  const r = await runClassificationPhase(later(), db);
  assert.equal(r.halt, false);
  assert.equal(r.unavailable_workspaces, 3);
  assert.ok(dCalls >= 1, "the workspace on the platform key was not classified");
  assert.deepEqual(
    callsTo("note_classification_blocked").map((c) => c.args.p_workspace_id).sort(),
    [WS_A, WS_B, "ws-c"].sort(),
  );
});

test("KEY: when the platform key dies, every workspace on it is skipped WITHOUT a call; own keys go on", async () => {
  reset();
  tables.insight_topics.push(topic("t2", WS_B, "Precio"), topic("t3", "ws-c", "Precio"));
  // Only ws-c has its own key.
  tables.integrations = [{ workspace_id: "ws-c", provider: "openrouter", credentials: { openrouter_api_key: "sk-c" } }];
  for (const [id, ws] of [["a1", WS_A], ["b1", WS_B], ["c1", "ws-c"], ["a2", WS_A]]) tables.messages.push(message(`m-${id}-x`, id, ws));
  let round = 0;
  rpcHandlers.select_conversations_to_classify = () => ({
    data: round++ === 0 ? [conv("a1", WS_A), conv("b1", WS_B), conv("c1", "ws-c"), conv("a2", WS_A)] : [],
    error: null,
  });
  classifyImpl = async (p) =>
    p.workspaceId === "ws-c"
      ? { ok: true, matches: [], usage: { promptTokens: 100, completionTokens: 5 }, keyScope: "own" }
      : { ok: false, code: "key_rejected", usage: { promptTokens: 0, completionTokens: 0 }, keyScope: "platform" };
  const r = await runClassificationPhase(later(), db);
  assert.equal(r.halt, false);
  assert.equal(r.classified, 1, "the workspace with its own healthy key was not classified");
  // One call found the platform key dead; B was never called.
  assert.deepEqual(classifyCalls.map((c) => c.workspaceId), [WS_A, "ws-c"]);
  assert.deepEqual(callsTo("reserve_classification_tokens").map((c) => c.args.p_workspace_id), [WS_A, "ws-c"]);
});

test("KEY: an own key that can't be decrypted is that key's error — never charged to the platform key", async () => {
  reset();
  tables.integrations = [{ workspace_id: WS_A, provider: "openrouter", credentials: { openrouter_api_key: "enc:broken" } }];
  const r = await runClassificationPhase(later(), db);
  assert.equal(classifyCalls.length, 0, "it called with some other key");
  assert.equal(callsTo("reserve_classification_tokens").length, 0);
  assert.equal(r.unavailable_workspaces, 1);
  assert.equal(r.halt, false);
});
test("REVIEW H1: one workspace out of OpenRouter credit does not stop the others", async () => {
  reset();
  tables.insight_topics.push(topic("t2", WS_B, "Precio"));
  tables.integrations = [{ workspace_id: WS_A, provider: "openrouter", credentials: { openrouter_api_key: "sk-a" } }];
  let round = 0;
  rpcHandlers.select_conversations_to_classify = (args) => {
    const skip = args.p_skip_workspaces as string[];
    round++;
    if (round > 4) return { data: [], error: null };
    return { data: skip.includes(WS_A) ? [conv("d2", WS_B)] : [conv("d1", WS_A), conv("d2", WS_B)], error: null };
  };
  classifyImpl = async (p) =>
    p.workspaceId === WS_A
      ? { ok: false, code: "key_rejected", usage: { promptTokens: 0, completionTokens: 0 }, keyScope: "own" }
      : { ok: true, matches: [], usage: { promptTokens: 100, completionTokens: 5 }, keyScope: "platform" };
  const r = await runClassificationPhase(later(), db);
  assert.equal(r.halt, false);
  assert.equal(r.unavailable_workspaces, 1);
  assert.ok(r.classified >= 1, "B was not classified");
  // A's refused call is settled at 0: it can't use up the day's cap.
  assert.ok(
    callsTo("settle_classification_tokens").some((c) => c.args.p_workspace_id === WS_A && c.args.p_prompt_tokens === 0),
  );
  assert.equal(callsTo("record_classification_failure").length, 0);
});
test("INFRA: no poder registrar un fallo es nuestra base caída → la corrida se detiene", async () => {
  reset();
  rpcHandlers.save_conversation_topics = () => ({ data: null, error: { code: "P0001" } });
  rpcHandlers.record_classification_failure = () => ({ data: null, error: { code: "57014" } });
  const r = await runClassificationPhase(later(), db);
  assert.equal(r.error, "record_failure_failed");
  assert.equal(r.halt, true);
});

test("tope: reserva negada → salta el workspace SIN llamar al LLM ni gastar intento", async () => {
  // El borde (consumo + techo vs. tope) lo decide la RPC: caso r de
  // scripts/verify-classify-topics.sql.
  reset();
  rpcHandlers.reserve_classification_tokens = () => ({ data: null, error: null });
  const r = await runClassificationPhase(later(), db);
  assert.deepEqual(r, { classified: 0, failed: 0, deferred: 0, skipped_workspaces: 1, unavailable_workspaces: 0, halt: false });
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
  assert.deepEqual(r, { classified: 1, failed: 0, deferred: 0, skipped_workspaces: 1, unavailable_workspaces: 0, halt: false });
  assert.deepEqual(classifyCalls.map((c) => c.workspaceId), [WS_B]);
});


test("si no se puede registrar el fallo de una conversación, la fase falla", async () => {
  reset();
  classifyImpl = async () => ({ ok: false, code: "content_rejected", usage: null });
  rpcHandlers.record_classification_failure = () => ({ data: null, error: { code: "57014" } });
  const r = await runClassificationPhase(later(), db);
  assert.equal(r.error, "record_failure_failed");
});

test("fallo de clasificación → record_classification_failure con el código; no avanza", async () => {
  reset();
  classifyImpl = async () => ({ ok: false, code: "invalid_output", usage: { promptTokens: 50, completionTokens: 1 } });
  const r = await runClassificationPhase(later(), db);
  assert.deepEqual(r, { classified: 0, failed: 1, deferred: 0, skipped_workspaces: 0, unavailable_workspaces: 0, halt: false });
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
      { classified: 0, failed: 0, deferred: 0, skipped_workspaces: 0, unavailable_workspaces: 0, halt: true, error: "save_infra_failed" },
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
  assert.deepEqual(r1, { classified: 0, failed: 0, deferred: 0, skipped_workspaces: 0, unavailable_workspaces: 0, halt: true, error: "load_messages_failed" });
  assert.equal(callsTo("record_classification_failure").length, 0);
  assert.equal(classifyCalls.length, 0);

  reset();
  delays["from:insight_topics"] = 6_000;
  const r2 = await runClassificationPhase(later(), db);
  assert.deepEqual(r2, { classified: 0, failed: 0, deferred: 0, skipped_workspaces: 0, unavailable_workspaces: 0, halt: true, error: "load_topics_failed" });
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
  assert.deepEqual(r, { classified: 0, failed: 0, deferred: 0, skipped_workspaces: 0, unavailable_workspaces: 0, halt: false });
  assert.equal(rpcCalls.length, 0);
});

// ── Deadline, con el reloj virtual ───────────────
const idle = { classified: 0, failed: 0, deferred: 0, skipped_workspaces: 0, unavailable_workspaces: 0, halt: false };

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
  const failing = { ok: false, code: "content_rejected", usage: null };
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
  assert.deepEqual(r, { processed: 2, failed: 0, deferred: 0, topics_done: 1, topics_expired: 0, skipped_workspaces: 0, unavailable_workspaces: 0, halt: false });
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
    return n === 2 ? { ok: false, code: "content_rejected", usage: null } : { ok: true, matches: [], usage: null };
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
  assert.deepEqual(r, { processed: 0, failed: 0, deferred: 0, topics_done: 0, topics_expired: 0, skipped_workspaces: 1, unavailable_workspaces: 0, halt: false });
  assert.deepEqual(callsTo("note_classification_blocked").map((c) => c.args), [{ p_workspace_id: WS_A, p_reason: "cap" }]);
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
  assert.deepEqual(r, { processed: 0, failed: 0, deferred: 0, topics_done: 0, topics_expired: 1, skipped_workspaces: 0, unavailable_workspaces: 0, halt: false });
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
  assert.equal(r.halt, true, "INFRA stops the run");
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
      { p_topic_id: "t-ocupado", p_lease_seconds: 180 },
      { p_topic_id: "t-libre", p_lease_seconds: 180 },
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
  classifyImpl = async () => ({ ok: false, code: "content_rejected", usage: null });
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
  assert.deepEqual(r, { processed: 0, failed: 0, deferred: 0, topics_done: 0, topics_expired: 0, skipped_workspaces: 0, unavailable_workspaces: 0, halt: true, error: "budget_reserve_failed" });
  assert.equal(classifyCalls.length, 0);
  assert.equal(callsTo("record_backfill_failure").length, 0);
});

test("fase 2: TRANSIENT counts on the topic (a cursor can't step around it), no halt alone", async () => {
  resetBackfill([[conv("d1")], [conv("d1")], [conv("d1")]]);
  rpcHandlers.record_backfill_failure = () => ({ data: 1, error: null });
  classifyImpl = async () => ({ ok: false, code: "provider_unavailable", usage: null, keyScope: "platform" });
  const r = await runBackfillPhase(later(), db);
  assert.deepEqual(r, { processed: 0, failed: 0, deferred: 1, topics_done: 0, topics_expired: 0, skipped_workspaces: 0, unavailable_workspaces: 0, halt: false });
  assert.equal(callsTo("record_backfill_failure").length, 1);
  assert.equal(callsTo("advance_topic_backfill").length, 0, "skipped the conversation on the first failure");
  assert.equal(classifyCalls.length, 1);
});
test("fase 2 con el save caído por infraestructura → halt, sin sumar fallos al tema", async () => {
  resetBackfill([[conv("d1"), conv("d2")]]);
  rpcHandlers.save_conversation_topics = () => ({ data: null, error: { code: "" } });
  const r = await runBackfillPhase(later(), db);
  assert.deepEqual(r, { processed: 0, failed: 0, deferred: 0, topics_done: 0, topics_expired: 0, skipped_workspaces: 0, unavailable_workspaces: 0, halt: true, error: "save_infra_failed" });
  // Al tercer fallo, el tema saltaba esta conversación para siempre.
  assert.equal(callsTo("record_backfill_failure").length, 0);
  assert.equal(classifyCalls.length, 1);
});

test("fase 2 cortada por el deadline al registrar el fallo o al avanzar → sin tiempo, no error", async () => {
  resetBackfill([[conv("d1")]]);
  // Fase 2: 40 s es el piso (5 + 20 + 3 × 5); el LLM tiene sus 20 s.
  classifyImpl = llmTaking((budget) => budget + 16_000, false, { ok: false, code: "content_rejected", usage: null });
  delays["rpc:record_backfill_failure"] = 5_000; // quedan 4 s
  const r1 = await runBackfillPhase(clock + 40_000, db);
  assert.deepEqual(r1, { processed: 0, failed: 1, deferred: 0, topics_done: 0, topics_expired: 0, skipped_workspaces: 0, unavailable_workspaces: 0, halt: false });
  assert.equal(callsTo("record_backfill_failure").length, 1);

  resetBackfill([[conv("d1")]]);
  classifyImpl = llmTaking((budget) => budget + 17_000, false); // quedan 3 s
  delays["rpc:advance_topic_backfill"] = 4_000;
  const r2 = await runBackfillPhase(clock + 40_000, db);
  assert.deepEqual(r2, { processed: 1, failed: 0, deferred: 0, topics_done: 0, topics_expired: 0, skipped_workspaces: 0, unavailable_workspaces: 0, halt: false });
  assert.equal(callsTo("advance_topic_backfill").length, 1);
});

test("the prompt ends at the customer's newest message the run picked", async () => {
  reset();
  const at = (id: string, when: string, direction: "in" | "out") => ({ ...message(id, "d1", WS_A), created_at: when, direction });
  // Newest first, as the real query returns them. The reply after the pick
  // and a message the customer sent after it stay out of this run.
  tables.messages = [
    at("m-late-in", "2026-09-14T21:00:00Z", "in"),
    at("m-reply", "2026-09-14T20:30:00Z", "out"),
    at("m-picked", "2026-09-14T20:00:00Z", "in"),
    at("m-before", "2026-09-14T19:00:00Z", "out"),
  ];
  const r = await runClassificationPhase(later(), db);
  assert.equal(r.classified, 1);
  assert.deepEqual(classifyCalls[0].messageIds, ["m-before", "m-picked"]);
  assert.equal(callsTo("save_conversation_topics")[0].args.p_classified_until, "2026-09-14T20:00:00Z");
});

test("with no customer message in view there is no LLM call, and the row is saved", async () => {
  reset();
  tables.messages = [{ ...message("m-out", "d1", WS_A), direction: "out" }];
  const r = await runClassificationPhase(later(), db);
  assert.equal(r.classified, 1);
  assert.equal(classifyCalls.length, 0);
  assert.equal(callsTo("reserve_classification_tokens").length, 0);
  assert.deepEqual(callsTo("save_conversation_topics")[0].args.p_matches, []);
});

test("only the customer's cut bodies make the analysis partial", async () => {
  reset();
  const long = (id: string, when: string, direction: "in" | "out") => ({
    ...message(id, "d1", WS_A), created_at: when, direction, body: "z".repeat(MAX_PROMPT_CHARS + 1),
  });
  tables.messages = [long("m-in", "2026-09-14T19:30:00Z", "in"), long("m-out", "2026-09-14T19:00:00Z", "out")];
  await runClassificationPhase(later(), db);
  assert.deepEqual(callsTo("save_conversation_topics")[0].args.p_truncated_at, ["2026-09-14T19:30:00Z"]);
});

test("REVIEW M1: the team's internal notes and failed sends never reach the LLM", async () => {
  reset();
  const at = (id: string, when: string, over: Record<string, unknown>) => ({
    ...message(id, "d1", WS_A), created_at: when, meta: {}, status: null, ...over,
  });
  tables.messages = [
    at("m-in", "2026-09-14T19:50:00Z", { direction: "in" }),
    at("m-note", "2026-09-14T19:40:00Z", { direction: "out", sender_user_id: "u1", body: "cliente moroso, no darle descuento", meta: { internal: true } }),
    at("m-failed", "2026-09-14T19:30:00Z", { direction: "out", body: "promo", status: "failed" }),
    at("m-sent", "2026-09-14T19:20:00Z", { direction: "out", body: "hola", status: "delivered" }),
  ];
  await runClassificationPhase(later(), db);
  assert.deepEqual(classifyCalls[0].messageIds.sort(), ["m-in", "m-sent"]);
  // In the query, before the limit of 60, not after it.
  assert.ok(extraFilters.includes('messages:not.meta.cs.{"internal":true}'));
  assert.ok(extraFilters.includes("messages:or.status.is.null,status.neq.failed"));
});

test("REVIEW M3: the backfill saves without a catalog, the nightly run with its own", async () => {
  resetBackfill([[conv("d1")], []]);
  await runBackfillPhase(later(), db);
  const save = callsTo("save_conversation_topics")[0].args;
  assert.equal(save.p_classified_until, null);
  assert.equal("p_catalog" in save, false, "a backfill must not claim the whole catalog read the conversation");
});


// ── Round 2: the failure and turn model, run after run ──────────────────────
const convAt = (id: string, ws: string, at: string) => ({ conversation_id: id, workspace_id: ws, contact_id: `c-${id}`, last_inbound_at: at });

/** The route's order: backfill first with its cut, then phase 1, shared guards. */
async function routeRun(budgetMs = 100_000) {
  const start = Date.now();
  const guards = newRunGuards();
  const backfill = await runBackfillPhase(Math.min(start + budgetMs, start + BACKFILL_SHARE_MS), db, guards);
  const classified = backfill.halt ? null : await runClassificationPhase(start + budgetMs, db, guards);
  return { backfill, classified, idleAtEnd_s: Math.round((start + budgetMs - Date.now()) / 1000) };
}

test("RV H1: two tenants with dead own keys don't stop the healthy one, in any of 3 runs", async () => {
  const perRun: number[] = [];
  for (let run = 0; run < 3; run++) {
    reset();
    tables.insight_topics.push(topic("t2", WS_B, "Precio"), topic("t3", "ws-c", "Precio"));
    tables.integrations = [WS_A, WS_B].map((ws) => ({ workspace_id: ws, provider: "openrouter", credentials: { openrouter_api_key: `sk-${ws}` } }));
    tables.messages.push(message("m-c1", "c1", "ws-c"), message("m-a9", "d1b", WS_B));
    let calls = 0;
    rpcHandlers.select_conversations_to_classify = (args) => {
      const skip = args.p_skip_workspaces as string[];
      if (calls++ > 10) return { data: [], error: null };
      return {
        data: [convAt("d1", WS_A, "2026-09-14T20:00:00Z"), convAt("d1b", WS_B, "2026-09-14T20:00:00Z"), convAt("c1", "ws-c", "2026-09-14T20:00:00Z")]
          .filter((r) => !skip.includes(r.workspace_id)),
        error: null,
      };
    };
    let cCalls = 0;
    classifyImpl = async (p) => {
      if (p.workspaceId === "ws-c") {
        cCalls++;
        return { ok: true, matches: [], usage: { promptTokens: 100, completionTokens: 5 }, keyScope: "platform" };
      }
      return { ok: false, code: "key_rejected", usage: { promptTokens: 0, completionTokens: 0 }, keyScope: "own" };
    };
    const r = await runClassificationPhase(later(), db);
    assert.equal(r.halt, false, `run ${run}`);
    perRun.push(cCalls);
  }
  assert.ok(perRun.every((n) => n >= 1), `the healthy tenant per run: ${perRun}`);
});

test("RV H1b: a conversation that always times out waits; its workspace's others are read", async () => {
  reset();
  tables.insight_topics.push(topic("t3", "ws-c", "Precio"));
  for (const id of ["a0", "a1", "a2", "a3"]) tables.messages.push(message(`m-${id}`, id, WS_A));
  tables.messages.push(message("m-c1", "c1", "ws-c"));
  const deferred = new Set<string>();
  const classifiedA: string[] = [];
  let served = 0;
  rpcHandlers.defer_classification = (args) => {
    deferred.add(args.p_conversation_id as string);
    return { data: null, error: null };
  };
  rpcHandlers.select_conversations_to_classify = () => {
    if (served++ > 0) return { data: [], error: null };
    return {
      data: ["a0", "c1", "a1", "a2", "a3"]
        .filter((id) => !deferred.has(id))
        .map((id) => convAt(id, id === "c1" ? "ws-c" : WS_A, "2026-09-14T20:00:00Z")),
      error: null,
    };
  };
  classifyImpl = async (p) => {
    const first = (p.messages as Array<{ id: string }>)[0].id;
    if (first === "m-a0") return { ok: false, code: "timeout", usage: null, keyScope: "platform" };
    if (p.workspaceId === WS_A) classifiedA.push(first);
    return { ok: true, matches: [], usage: { promptTokens: 100, completionTokens: 5 }, keyScope: "platform" };
  };
  const r = await runClassificationPhase(later(), db);
  assert.equal(r.halt, false);
  assert.deepEqual([...deferred], ["a0"]);
  assert.deepEqual(classifiedA.sort(), ["m-a1", "m-a2", "m-a3"]);
});

test("RV H2: a backfill that can't advance (over the cap) gives the whole run back to phase 1", async () => {
  reset();
  tables.insight_topics = [{ ...topic("tC", WS_A, "Precio"), backfill_status: "done" }, topic("tX", "ws-x", "Envío")];
  let n = 0;
  tables.messages = [message("m-x1", "x1", "ws-x")];
  rpcHandlers.select_conversations_to_classify = () => {
    const rows = Array.from({ length: 5 }, () => convAt(`c${++n}`, WS_A, "2026-09-14T20:00:00Z"));
    for (const r of rows) tables.messages.push(message(`m-${r.conversation_id}`, r.conversation_id, WS_A));
    return { data: rows, error: null };
  };
  rpcHandlers.claim_topic_backfill = () => ({ data: true, error: null });
  rpcHandlers.release_topic_backfill = () => ({ data: null, error: null });
  rpcHandlers.next_backfill_batch = () => ({ data: [convAt("x1", "ws-x", "2026-09-14T20:00:00Z")], error: null });
  rpcHandlers.reserve_classification_tokens = (args) => ({ data: args.p_workspace_id === "ws-x" ? null : "res", error: null });
  classifyImpl = llmTaking(() => 4_000);
  const run = await routeRun();
  assert.equal(run.backfill.skipped_workspaces, 1);
  // 100 s, 4 s a call, starts while 35 s remain: 17 calls. No share lost to the backfill.
  assert.ok(run.classified!.classified >= 16, `phase 1 classified ${run.classified!.classified}`);
  assert.ok(run.idleAtEnd_s <= 35, `idle at the end: ${run.idleAtEnd_s} s`);
});

test("TURNS: a backfill with work takes its share first; phase 1 gets the rest", async () => {
  resetBackfill(Array.from({ length: 20 }, (_, i) => [conv(`b${i}`)]));
  tables.insight_topics.push(topic("t1", WS_A, "Precio"));
  tables.messages = [
    ...Array.from({ length: 20 }, (_, i) => message(`mb${i}`, `b${i}`, WS_A)),
    ...Array.from({ length: 40 }, (_, i) => message(`mq${i}`, `q${i}`, WS_A)),
  ];
  let round = 0;
  rpcHandlers.select_conversations_to_classify = () => ({ data: round < 40 ? [conv(`q${round++}`)] : [], error: null });
  classifyImpl = llmTaking(() => 4_000);
  const run = await routeRun();
  // The backfill: 55 s, starts while 40 s remain → 4 calls; phase 1: the rest.
  assert.ok(run.backfill.processed >= 3, `backfill ${run.backfill.processed}`);
  assert.ok(run.classified!.classified >= 3, `phase 1 ${run.classified!.classified}`);
  assert.ok(run.idleAtEnd_s <= 35);
});
