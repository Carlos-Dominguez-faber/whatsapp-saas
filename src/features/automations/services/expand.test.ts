import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

// ── Fake de PostgREST, por operación ─────────────────────────────────────────
// Cada clave tiene su propia cola de respuestas; lo que no se encoló devuelve
// `{ data: [], error: null }`.
type Res = { data?: unknown; error?: unknown };

let responses: Record<string, Res[]> = {};
let calls: Array<{ key: string; arg?: unknown }> = [];

function take(key: string): Res {
  const queue = responses[key];
  return queue && queue.length ? queue.shift()! : { data: [], error: null };
}

function push(key: string, arg?: unknown) {
  calls.push({ key, arg });
}

const fakeClient = {
  from(table: string) {
    if (table === "automation_events") {
      return {
        // Dos consultas distintas caen acá: el descubrimiento del siguiente
        // workspace (lleva .gt("workspace_id", …) y NO lleva .eq) y la lectura
        // del lote de un workspace (lleva .eq("workspace_id", …)). Se
        // distinguen por los filtros acumulados, no por el orden de llamada.
        select: () => {
          const filters: Record<string, unknown> = {};
          const chain: Record<string, unknown> = {};
          Object.assign(chain, {
            is: () => chain,
            lt: (col: string, val: unknown) => {
              filters[`lt:${col}`] = val;
              return chain;
            },
            gt: (col: string, val: unknown) => {
              filters[`gt:${col}`] = val;
              return chain;
            },
            eq: (col: string, val: unknown) => {
              filters[`eq:${col}`] = val;
              return chain;
            },
            order: () => chain,
            limit: (n: number) => {
              const isScan = filters["eq:workspace_id"] === undefined;
              const key = isScan ? "events.scan" : "events.select";
              // attemptsLt viaja en las dos: es lo que prueba que un evento
              // en cuarentena (expand_attempts ===
              // MAX_EXPAND_ATTEMPTS) queda afuera de las dos lecturas de
              // pendientes SOLO por este filtro, sin depender de expanded_at.
              push(
                key,
                isScan
                  ? { after: filters["gt:workspace_id"], attemptsLt: filters["lt:expand_attempts"] }
                  : { ws: filters["eq:workspace_id"], n, attemptsLt: filters["lt:expand_attempts"] },
              );
              return Promise.resolve(take(key));
            },
          });
          return chain;
        },
        update: (row: unknown) => ({
          in: (_col: string, ids: unknown[]) => {
            push("events.update", { row, ids });
            return Promise.resolve(take("events.update"));
          },
        }),
      };
    }
    if (table === "messages") {
      return {
        select: () => {
          const filters: Record<string, unknown> = {};
          const chain: Record<string, unknown> = {};
          Object.assign(chain, {
            eq: (col: string, val: unknown) => {
              filters[`eq:${col}`] = val;
              return chain;
            },
            in: (_col: string, ids: unknown[]) => {
              push("messages.select", { ids, ...filters });
              return Promise.resolve(take("messages.select"));
            },
          });
          return chain;
        },
      };
    }
    if (table === "automation_rules") {
      return {
        select: () => {
          // Registra los .eq() encadenados (columna y valor), igual que el
          // fake de automation_events: sin esto un test no puede distinguir
          // "se filtró por el workspace correcto" de "se sirvió lo que sea".
          const filters: Record<string, unknown> = {};
          const chain: Record<string, unknown> = {};
          Object.assign(chain, {
            eq: (col: string, val: unknown) => {
              filters[`eq:${col}`] = val;
              return chain;
            },
            then: (resolve: (v: Res) => void) => {
              push("rules.select", { ...filters });
              resolve(take("rules.select"));
            },
          });
          return chain;
        },
      };
    }
    if (table === "automation_runs") {
      return {
        upsert: (rows: unknown, opts: unknown) => ({
          select: () => {
            push("runs.upsert", { rows, opts });
            return Promise.resolve(take("runs.upsert"));
          },
        }),
      };
    }
    throw new Error(`tabla inesperada en el fake: ${table}`);
  },
};

mock.module("@supabase/supabase-js", {
  exports: {
    // Como el createClient real: revienta sin url/key. Es lo que deja probar
    // el finding 5 (svc() adentro del try) sin inventar otro mecanismo.
    createClient: (url?: string, key?: string) => {
      if (!url || !key) throw new Error("supabaseUrl is required.");
      return fakeClient;
    },
  },
});

const {
  expandAutomationEvents,
  ruleMatches,
  ruleAppliesTo,
  EVENT_TO_TRIGGER,
  MAX_EXPAND_ATTEMPTS,
  EXPAND_ERROR_CODE,
} = await import("./expand.ts");

const FAR = () => Date.now() + 60_000; // deadline holgado

function reset() {
  responses = {};
  calls = [];
}

const T0 = "2026-09-03T10:00:00.000Z";
const T1 = "2026-09-03T11:00:00.000Z";
const T2 = "2026-09-03T12:00:00.000Z";

const WS1 = "11111111-1111-1111-1111-111111111111";
const WS2 = "22222222-2222-2222-2222-222222222222";

function ev(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    workspace_id: WS1,
    event_type: "first_message",
    subject_id: "conv_1",
    occurrence: "1",
    conversation_id: "conv_1",
    contact_id: "cont_1",
    message_id: "msg_1",
    // Migración 20260908000000: null por default porque los 4
    // triggers por evento que estos fixtures modelan nunca la escriben.
    rule_id: null,
    occurred_at: T1,
    expanded_at: null,
    expand_attempts: 0,
    ...over,
  };
}

/**
 * Encola el descubrimiento de workspaces: una respuesta por cada `workspace_id`
 * de la lista, y una vacía al final para que el bucle termine.
 */
function scan(...workspaceIds: string[]) {
  responses["events.scan"] = [
    ...workspaceIds.map((id) => ({ data: [{ workspace_id: id }], error: null })),
    { data: [], error: null },
  ];
}

function rule(over: Record<string, unknown> = {}) {
  return {
    id: "rule_1",
    trigger_type: "first_message",
    trigger_config: {},
    enabled_since: T0,
    ...over,
  };
}

// ── ruleMatches ──────────────────────────────────────────────────────────────

test("ruleMatches: un disparador que no es keyword_match siempre matchea", () => {
  assert.equal(
    ruleMatches({ trigger_type: "first_message", trigger_config: {} }, null),
    true,
  );
});

test("ruleMatches: keywords vacías nunca matchean", () => {
  // `haystack.includes("")` es true: sin este filtro, una regla heredada con
  // keywords [""] dispararía con CADA mensaje entrante del workspace.
  assert.equal(
    ruleMatches(
      { trigger_type: "keyword_match", trigger_config: { keywords: ["", "   "] } },
      "hola quiero precio",
    ),
    false,
  );
  assert.equal(
    ruleMatches(
      { trigger_type: "keyword_match", trigger_config: { keywords: [] } },
      "hola",
    ),
    false,
  );
  assert.equal(
    ruleMatches({ trigger_type: "keyword_match", trigger_config: {} }, "hola"),
    false,
  );
});

test("ruleMatches: ignora mayúsculas y acentos en los dos lados", () => {
  assert.equal(
    ruleMatches(
      { trigger_type: "keyword_match", trigger_config: { keywords: ["CRÉDITO"] } },
      "quiero un credito hipotecario",
    ),
    true,
  );
});

test("ruleMatches: body null o vacío no matchea", () => {
  const r = {
    trigger_type: "keyword_match" as const,
    trigger_config: { keywords: ["precio"] },
  };
  assert.equal(ruleMatches(r, null), false);
  assert.equal(ruleMatches(r, ""), false);
});

test("ruleMatches: keyword que no aparece devuelve false", () => {
  assert.equal(
    ruleMatches(
      { trigger_type: "keyword_match", trigger_config: { keywords: ["precio"] } },
      "buenas tardes",
    ),
    false,
  );
});

// ── ruleAppliesTo ────────────────────────────────────────────────────────────

test("ruleAppliesTo: sin enabled_since la regla no aplica (fail-closed)", () => {
  assert.equal(
    ruleAppliesTo({ enabled: true, enabled_since: null }, { occurred_at: T1 }),
    false,
  );
});

test("ruleAppliesTo: una regla habilitada DESPUÉS del evento no dispara hacia atrás", () => {
  assert.equal(
    ruleAppliesTo({ enabled: true, enabled_since: T2 }, { occurred_at: T1 }),
    false,
  );
});

test("ruleAppliesTo: una regla habilitada ANTES del evento sí aplica", () => {
  assert.equal(
    ruleAppliesTo({ enabled: true, enabled_since: T0 }, { occurred_at: T1 }),
    true,
  );
});

test("ruleAppliesTo: una fecha ilegible no aplica, no revienta", () => {
  assert.equal(
    ruleAppliesTo({ enabled: true, enabled_since: "no-es-fecha" }, { occurred_at: T1 }),
    false,
  );
});

// ── EVENT_TO_TRIGGER ─────────────────────────────────────────────────────────

test("EVENT_TO_TRIGGER: inbound_message mapea a keyword_match, el resto 1:1", () => {
  assert.deepEqual(EVENT_TO_TRIGGER, {
    first_message: "first_message",
    inbound_message: "keyword_match",
    handoff_requested: "handoff_requested",
    lead_qualified: "lead_qualified",
    appointment_upcoming: "appointment_upcoming",
  });
});

// ── expandAutomationEvents ───────────────────────────────────────────────────

test("sin eventos pendientes no consulta reglas y devuelve ceros", async () => {
  reset();
  scan(); // el descubrimiento no encuentra ningún workspace
  const out = await expandAutomationEvents(FAR());
  assert.deepEqual(out, { events: 0, runs: 0, errors: 0 });
  assert.equal(calls.filter((c) => c.key === "rules.select").length, 0);
  assert.equal(calls.filter((c) => c.key === "events.select").length, 0);
});

test("un evento sin reglas que lo consuman se marca expandido con 0 runs", async () => {
  reset();
  scan(WS1);
  responses["events.select"] = [{ data: [ev({ message_id: null })], error: null }];
  responses["rules.select"] = [{ data: [], error: null }];
  const out = await expandAutomationEvents(FAR());
  assert.deepEqual(out, { events: 1, runs: 0, errors: 0 });
  const mark = calls.find((c) => c.key === "events.update");
  assert.ok(mark, "el evento tiene que quedar marcado igual");
  assert.deepEqual((mark!.arg as { ids: unknown[] }).ids, [1]);
});

test("una regla con enabled_since posterior al evento no crea run, pero el evento se expande", async () => {
  reset();
  scan(WS1);
  responses["events.select"] = [{ data: [ev({ message_id: null })], error: null }];
  responses["rules.select"] = [{ data: [rule({ enabled_since: T2 })], error: null }];
  const out = await expandAutomationEvents(FAR());
  assert.deepEqual(out, { events: 1, runs: 0, errors: 0 });
  assert.equal(calls.filter((c) => c.key === "runs.upsert").length, 0);
});

test("una regla con enabled_since anterior crea el run con el evento adjunto", async () => {
  reset();
  scan(WS1);
  responses["events.select"] = [{ data: [ev({ message_id: null })], error: null }];
  responses["rules.select"] = [{ data: [rule()], error: null }];
  responses["runs.upsert"] = [{ data: [{ id: "run_1" }], error: null }];
  const out = await expandAutomationEvents(FAR());
  assert.deepEqual(out, { events: 1, runs: 1, errors: 0 });

  const upsert = calls.find((c) => c.key === "runs.upsert")!;
  const { rows, opts } = upsert.arg as { rows: unknown[]; opts: unknown };
  assert.deepEqual(rows, [
    {
      workspace_id: WS1,
      rule_id: "rule_1",
      event_id: 1,
      trigger_type: "first_message",
      conversation_id: "conv_1",
      contact_id: "cont_1",
    },
  ]);
  assert.deepEqual(opts, { onConflict: "rule_id,event_id", ignoreDuplicates: true });

  // La query de reglas tiene que llevar el workspace bajo expansión: sin este
  // .eq() cualquier regla de cualquier tenant aplicaría al evento de otro.
  const rulesCall = calls.find((c) => c.key === "rules.select")!;
  assert.deepEqual(rulesCall.arg, { "eq:workspace_id": WS1, "eq:enabled": true });
});

test("first_message con dos reglas crea un run por regla", async () => {
  reset();
  scan(WS1);
  responses["events.select"] = [{ data: [ev({ message_id: null })], error: null }];
  responses["rules.select"] = [
    { data: [rule(), rule({ id: "rule_2" })], error: null },
  ];
  responses["runs.upsert"] = [{ data: [{ id: "r1" }, { id: "r2" }], error: null }];
  const out = await expandAutomationEvents(FAR());
  assert.equal(out.runs, 2);
  const { rows } = calls.find((c) => c.key === "runs.upsert")!.arg as { rows: unknown[] };
  assert.equal(rows.length, 2);
});

test("inbound_message con keyword que NO matchea deja 0 runs", async () => {
  reset();
  scan(WS1);
  responses["events.select"] = [
    { data: [ev({ event_type: "inbound_message", subject_id: "msg_1" })], error: null },
  ];
  responses["messages.select"] = [
    { data: [{ id: "msg_1", body: "buenas tardes" }], error: null },
  ];
  responses["rules.select"] = [
    {
      data: [rule({ trigger_type: "keyword_match", trigger_config: { keywords: ["precio"] } })],
      error: null,
    },
  ];
  const out = await expandAutomationEvents(FAR());
  assert.deepEqual(out, { events: 1, runs: 0, errors: 0 });
  assert.equal(calls.filter((c) => c.key === "runs.upsert").length, 0);
});

test("inbound_message con keyword que matchea crea 1 run", async () => {
  reset();
  scan(WS1);
  responses["events.select"] = [
    { data: [ev({ event_type: "inbound_message", subject_id: "msg_1" })], error: null },
  ];
  responses["messages.select"] = [
    { data: [{ id: "msg_1", body: "hola, cuál es el PRECIO?" }], error: null },
  ];
  responses["rules.select"] = [
    {
      data: [rule({ trigger_type: "keyword_match", trigger_config: { keywords: ["precio"] } })],
      error: null,
    },
  ];
  responses["runs.upsert"] = [{ data: [{ id: "run_1" }], error: null }];
  const out = await expandAutomationEvents(FAR());
  assert.deepEqual(out, { events: 1, runs: 1, errors: 0 });
  // los cuerpos se cargan en UNA sola query por lote de workspace
  assert.equal(calls.filter((c) => c.key === "messages.select").length, 1);
  // y esa query va scopeada al workspace bajo expansión (finding minor: la
  // columna existe e ignorarla filtraría por ids que ya son de este tenant,
  // pero un mock no es excusa para omitir el filtro en producción).
  const messagesCall = calls.find((c) => c.key === "messages.select")!;
  assert.deepEqual(messagesCall.arg, { ids: ["msg_1"], "eq:workspace_id": WS1 });
});

test("lead_qualified crea el run con conversation_id null y el contacto puesto", async () => {
  reset();
  scan(WS1);
  responses["events.select"] = [
    {
      data: [
        ev({
          event_type: "lead_qualified",
          subject_id: "cont_1",
          occurrence: "3",
          conversation_id: null,
          message_id: null,
        }),
      ],
      error: null,
    },
  ];
  responses["rules.select"] = [{ data: [rule({ trigger_type: "lead_qualified" })], error: null }];
  responses["runs.upsert"] = [{ data: [{ id: "run_1" }], error: null }];
  await expandAutomationEvents(FAR());
  const { rows } = calls.find((c) => c.key === "runs.upsert")!.arg as {
    rows: Array<{ conversation_id: unknown; contact_id: unknown }>;
  };
  assert.equal(rows[0].conversation_id, null);
  assert.equal(rows[0].contact_id, "cont_1");
});

// ── Guard condicional de rule_id ───────────────────────────────────────────

test("appointment_upcoming con rule_id crea SOLO el run de la regla que generó el evento, no el de la otra regla activa del mismo trigger_type", async () => {
  // Dos reglas appointment_upcoming del mismo workspace, 24h y 2h. Sin el
  // guard, las dos matchean por trigger_type y salen 2 runs — el bug que este
  // rediseño existe para cerrar (4 mensajes en vez de 2 al cliente).
  reset();
  scan(WS1);
  responses["events.select"] = [
    {
      data: [
        ev({
          event_type: "appointment_upcoming",
          subject_id: "appt_1",
          occurrence: "24h:2026-09-10T09:00:00.000Z",
          rule_id: "rule_24h",
          message_id: null,
        }),
      ],
      error: null,
    },
  ];
  responses["rules.select"] = [
    {
      data: [
        rule({
          id: "rule_24h",
          trigger_type: "appointment_upcoming",
          trigger_config: { hours_before: 24 },
        }),
        rule({
          id: "rule_2h",
          trigger_type: "appointment_upcoming",
          trigger_config: { hours_before: 2 },
        }),
      ],
      error: null,
    },
  ];
  responses["runs.upsert"] = [{ data: [{ id: "run_1" }], error: null }];

  const out = await expandAutomationEvents(FAR());
  assert.deepEqual(out, { events: 1, runs: 1, errors: 0 });

  const { rows } = calls.find((c) => c.key === "runs.upsert")!.arg as {
    rows: Array<{ rule_id: string }>;
  };
  assert.equal(rows.length, 1, "un solo run, no uno por regla");
  assert.equal(rows[0].rule_id, "rule_24h");
});

test("un evento sin rule_id (null) sigue matcheando por trigger_type — el guard es condicional a propósito", async () => {
  // Los 4 triggers por evento (first_message acá) nunca escriben rule_id.
  // Con rule_id null el guard queda inerte y el camino no cambia.
  reset();
  scan(WS1);
  responses["events.select"] = [{ data: [ev({ rule_id: null, message_id: null })], error: null }];
  responses["rules.select"] = [{ data: [rule()], error: null }];
  responses["runs.upsert"] = [{ data: [{ id: "run_1" }], error: null }];

  const out = await expandAutomationEvents(FAR());
  assert.deepEqual(out, { events: 1, runs: 1, errors: 0 });
});

test("si el upsert falla, el evento NO se marca expandido, errors = 1 y sube expand_attempts", async () => {
  reset();
  scan(WS1);
  responses["events.select"] = [{ data: [ev({ message_id: null })], error: null }];
  responses["rules.select"] = [{ data: [rule()], error: null }];
  responses["runs.upsert"] = [{ data: null, error: { message: "boom" } }];
  const out = await expandAutomationEvents(FAR());
  assert.deepEqual(out, { events: 0, runs: 0, errors: 1 });

  // La ÚNICA escritura sobre automation_events es el contador de intentos, y
  // no toca expanded_at: marcarlo con el upsert caído pierde el disparador
  // para siempre.
  const writes = calls.filter((c) => c.key === "events.update");
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].arg, {
    row: { expand_attempts: 1 },
    ids: [1],
  });
});

test("al tercer fallo el evento se cierra con expand_error y deja de leerse", async () => {
  reset();
  scan(WS1);
  // expand_attempts = 2: este fallo es el tercero.
  responses["events.select"] = [
    { data: [ev({ message_id: null, expand_attempts: 2 })], error: null },
  ];
  responses["rules.select"] = [{ data: [rule()], error: null }];
  responses["runs.upsert"] = [{ data: null, error: { message: "boom otra vez" } }];
  const out = await expandAutomationEvents(FAR());
  assert.equal(out.errors, 1);
  assert.equal(out.events, 0, "un evento que se rinde no cuenta como expandido");

  const write = calls.find((c) => c.key === "events.update")!;
  const { row, ids } = write.arg as { row: Record<string, unknown>; ids: unknown[] };
  assert.deepEqual(ids, [1]);
  // Al rendirse NO se toca expanded_at. Lo saca de la cola
  // el contador (expand_attempts >= MAX_EXPAND_ATTEMPTS, ya filtrado por las
  // dos lecturas de pendientes); expanded_at IS NULL + expand_error puesto es
  // el estado de cuarentena. deepEqual (no solo "expand_error" suelto) es lo
  // que pone este test en rojo si alguien vuelve a agregar expanded_at al
  // UPDATE de rendición.
  assert.deepEqual(row, {
    expand_attempts: MAX_EXPAND_ATTEMPTS,
    expand_error: EXPAND_ERROR_CODE,
  });
});

test("las dos lecturas de pendientes filtran por expand_attempts, no por expanded_at solo — así un evento en cuarentena no vuelve a leerse", async () => {
  // Es la otra mitad de la prueba anterior: no basta con que el UPDATE de
  // rendición no escriba expanded_at, hace falta que las lecturas de
  // pendientes de verdad excluyan al evento en cuarentena. Lo hacen con
  // `.lt("expand_attempts", MAX_EXPAND_ATTEMPTS)`: un evento con
  // expand_attempts === MAX_EXPAND_ATTEMPTS (el estado en el que queda al
  // rendirse) no pasa ese filtro en NINGUNA de las dos consultas, sin
  // necesitar expanded_at puesto.
  reset();
  scan(WS1);
  responses["events.select"] = [{ data: [], error: null }];
  await expandAutomationEvents(FAR());

  const scanCall = calls.find((c) => c.key === "events.scan")!;
  const selectCall = calls.find((c) => c.key === "events.select")!;
  assert.equal(
    (scanCall.arg as { attemptsLt: number }).attemptsLt,
    MAX_EXPAND_ATTEMPTS,
    "el descubrimiento de workspaces pendientes filtra expand_attempts < MAX_EXPAND_ATTEMPTS",
  );
  assert.equal(
    (selectCall.arg as { attemptsLt: number }).attemptsLt,
    MAX_EXPAND_ATTEMPTS,
    "la lectura del lote por workspace filtra expand_attempts < MAX_EXPAND_ATTEMPTS",
  );
});

test("un lote con expand_attempts mezclados agrupa por el valor YA leído, no por el siguiente", async () => {
  // Si la agrupación fuera por `next` (o si se escribiera `current` en vez de
  // `current + 1`), el contador nunca avanzaría y el evento venenoso
  // encabezaría la cola de su workspace en cada tick, para siempre.
  // Este es el único caso que ejercita el Map con más de un grupo.
  reset();
  scan(WS1);
  responses["events.select"] = [
    {
      data: [
        ev({ id: 1, message_id: null, expand_attempts: 0 }),
        ev({ id: 2, message_id: null, expand_attempts: 1 }),
        ev({ id: 3, message_id: null, expand_attempts: 2 }),
      ],
      error: null,
    },
  ];
  responses["rules.select"] = [{ data: [rule()], error: null }];
  responses["runs.upsert"] = [{ data: null, error: { message: "boom" } }];
  const out = await expandAutomationEvents(FAR());
  assert.equal(out.errors, 1);
  assert.equal(out.events, 0);

  const writes = calls.filter((c) => c.key === "events.update") as Array<{
    arg: { row: Record<string, unknown>; ids: number[] };
  }>;
  assert.equal(writes.length, 3, "un UPDATE por grupo: rendirse, 0→1 y 1→2");

  const bump0to1 = writes.find((w) => w.arg.ids.includes(1))!;
  assert.deepEqual(bump0to1.arg.ids, [1]);
  assert.deepEqual(bump0to1.arg.row, { expand_attempts: 1 });

  const bump1to2 = writes.find((w) => w.arg.ids.includes(2))!;
  assert.deepEqual(bump1to2.arg.ids, [2]);
  assert.deepEqual(bump1to2.arg.row, { expand_attempts: 2 });

  const giveUp = writes.find((w) => w.arg.ids.includes(3))!;
  assert.deepEqual(giveUp.arg.ids, [3]);
  // El grupo que se rinde tampoco marca expanded_at.
  assert.deepEqual(giveUp.arg.row, {
    expand_attempts: MAX_EXPAND_ATTEMPTS,
    expand_error: EXPAND_ERROR_CODE,
  });
});

test("un workspace que falla al cargar reglas no impide expandir al otro", async () => {
  reset();
  scan(WS1, WS2);
  responses["events.select"] = [
    { data: [ev({ id: 1, workspace_id: WS1, message_id: null })], error: null },
    {
      data: [
        ev({
          id: 2,
          workspace_id: WS2,
          subject_id: "conv_2",
          conversation_id: "conv_2",
          message_id: null,
        }),
      ],
      error: null,
    },
  ];
  responses["rules.select"] = [
    { data: null, error: { message: "ws_1 caído" } },
    { data: [rule({ id: "rule_2" })], error: null },
  ];
  responses["runs.upsert"] = [{ data: [{ id: "run_2" }], error: null }];
  const out = await expandAutomationEvents(FAR());
  assert.deepEqual(out, { events: 1, runs: 1, errors: 1 });

  // Dos escrituras: el contador del WS1 caído y el marcado del WS2 expandido.
  const marks = calls.filter((c) => c.key === "events.update");
  assert.equal(marks.length, 2);
  const expanded = marks.find(
    (m) => (m.arg as { row: Record<string, unknown> }).row.expanded_at !== undefined,
  )!;
  assert.deepEqual((expanded.arg as { ids: unknown[] }).ids, [2]);

  // Las dos consultas de reglas van cada una scopeada a su propio workspace,
  // en el orden en que se procesaron (WS1 primero, WS2 después).
  const rulesCalls = calls.filter((c) => c.key === "rules.select");
  assert.deepEqual(rulesCalls.map((c) => c.arg), [
    { "eq:workspace_id": WS1, "eq:enabled": true },
    { "eq:workspace_id": WS2, "eq:enabled": true },
  ]);
});

test("un tenant con backlog no deja sin expandir al otro", async () => {
  reset();
  scan(WS1, WS2);
  // WS1 tiene 300 pendientes; el cupo por workspace es 50, así que se lleva 50
  // y el descubrimiento pasa igual a WS2 en ESTE mismo tick.
  const backlog = Array.from({ length: 50 }, (_, i) =>
    ev({ id: 1000 + i, workspace_id: WS1, message_id: null }),
  );
  responses["events.select"] = [
    { data: backlog, error: null },
    {
      data: [
        ev({
          id: 7,
          workspace_id: WS2,
          subject_id: "conv_2",
          conversation_id: "conv_2",
          message_id: null,
        }),
      ],
      error: null,
    },
  ];
  responses["rules.select"] = [
    { data: [rule()], error: null },
    { data: [rule({ id: "rule_2" })], error: null },
  ];
  responses["runs.upsert"] = [
    { data: backlog.map((_, i) => ({ id: `r${i}` })), error: null },
    { data: [{ id: "run_ws2" }], error: null },
  ];

  const out = await expandAutomationEvents(FAR());
  assert.equal(out.events, 51, "50 del tenant con backlog + el único del otro");
  assert.equal(out.errors, 0);

  // El evento del WS2 se expandió en este tick, no en el siguiente.
  const marks = calls.filter((c) => c.key === "events.update");
  assert.ok(
    marks.some((m) => ((m.arg as { ids: number[] }).ids ?? []).includes(7)),
    "el workspace chico quedó detrás del backlog del grande",
  );

  // Y el lote del tenant grande se pidió con el cupo, no con toda su cola.
  const firstBatch = calls.find((c) => c.key === "events.select")!;
  assert.equal((firstBatch.arg as { n: number }).n, 50);

  // El corazón del reparto es el cursor: si `.gt("workspace_id", cursor)` se
  // perdiera, el segundo descubrimiento volvería a traer WS1 y el tick entero
  // se lo comería el mismo tenant. El scan sale primero con after=UUID_ZERO
  // (no hay filtro previo), y el SEGUNDO ya tiene que llevar el WS1 recién
  // usado como piso.
  const scans = calls.filter((c) => c.key === "events.scan");
  assert.equal(
    (scans[1].arg as { after: string }).after,
    WS1,
    "el segundo descubrimiento tiene que arrancar después del workspace ya expandido",
  );

  // Y las dos lecturas de lote fueron cada una al workspace correcto, en el
  // orden en que el cursor las entregó.
  const selects = calls.filter((c) => c.key === "events.select");
  assert.deepEqual(
    selects.map((c) => (c.arg as { ws: string }).ws),
    [WS1, WS2],
  );
});

test("con el deadline vencido corta antes del primer workspace y devuelve lo hecho", async () => {
  reset();
  scan(WS1);
  responses["events.select"] = [{ data: [ev({ message_id: null })], error: null }];
  const out = await expandAutomationEvents(Date.now() - 1);
  assert.deepEqual(out, { events: 0, runs: 0, errors: 0 });
  assert.equal(calls.filter((c) => c.key === "rules.select").length, 0);
  assert.equal(
    calls.filter((c) => c.key === "events.select").length,
    0,
    "ni siquiera se lee el lote del primer workspace",
  );
});

test("el deadline corta ENTRE workspaces, nunca a la mitad de uno", async () => {
  reset();
  scan(WS1, WS2);
  responses["events.select"] = [
    {
      data: [
        ev({ id: 1, workspace_id: WS1, message_id: null }),
        ev({ id: 2, workspace_id: WS1, subject_id: "conv_9", conversation_id: "conv_9", message_id: null }),
      ],
      error: null,
    },
  ];
  responses["rules.select"] = [{ data: [rule()], error: null }];
  responses["runs.upsert"] = [{ data: [{ id: "r1" }, { id: "r2" }], error: null }];

  // Reloj controlado, para que el corte sea determinista y no dependa de
  // cuánto tarda el proceso: la primera comprobación del deadline pasa, la
  // segunda ya lo encuentra vencido. `expandAutomationEvents` solo llama a
  // Date.now() en ese guard.
  const realNow = Date.now;
  let ticks = 0;
  Date.now = () => (ticks++ === 0 ? 1_000 : 2_000);

  try {
    const out = await expandAutomationEvents(1_500);

    assert.equal(out.events, 2, "el workspace empezado se terminó completo");
    assert.equal(out.errors, 0);
    const mark = calls.find((c) => c.key === "events.update")!;
    assert.deepEqual((mark.arg as { ids: unknown[] }).ids, [1, 2]);
    assert.equal(
      calls.filter((c) => c.key === "events.select").length,
      1,
      "no se leyó el lote del segundo workspace",
    );
  } finally {
    Date.now = realNow;
  }
});

test("un upsert que choca contra el UNIQUE no es un error ni lanza", async () => {
  reset();
  // El evento sigue pendiente (el marcado de la primera pasada aún no se ve) y
  // el upsert con ignoreDuplicates devuelve 0 filas por el UNIQUE, sin error.
  responses["events.scan"] = [
    { data: [{ workspace_id: WS1 }], error: null },
    { data: [], error: null },
    { data: [{ workspace_id: WS1 }], error: null },
    { data: [], error: null },
  ];
  responses["events.select"] = [
    { data: [ev({ message_id: null })], error: null },
    { data: [ev({ message_id: null })], error: null },
  ];
  responses["rules.select"] = [
    { data: [rule()], error: null },
    { data: [rule()], error: null },
  ];
  responses["runs.upsert"] = [
    { data: [{ id: "run_1" }], error: null },
    { data: [], error: null },
  ];
  const first = await expandAutomationEvents(FAR());
  const second = await expandAutomationEvents(FAR());
  assert.equal(first.runs, 1);
  assert.equal(second.runs, 0, "la unicidad (rule_id, event_id) absorbe la carrera");
  assert.equal(second.errors, 0, "el conflicto ignorado NO cuenta como error");
  assert.equal(second.events, 1, "y el evento igual queda marcado expandido");
});

test("si el descubrimiento de workspaces falla, no lanza y lo marca como fallo de FASE", async () => {
  reset();
  responses["events.scan"] = [{ data: null, error: { message: "sin conexión" } }];
  const out = await expandAutomationEvents(FAR());
  // El scan es la operación que CONSIGUE el trabajo: sin el código, este tally
  // es idéntico al de "no había nada pendiente" y el cron responde 200 {ok:true}.
  assert.deepEqual(out, { events: 0, runs: 0, errors: 1, error: "scan_failed" });
  // El código nunca lleva el texto de PostgREST.
  assert.ok(!JSON.stringify(out).includes("sin conexión"));
});

test("la lectura del lote de UN workspace que falla es por ítem, NO fallo de fase", async () => {
  reset();
  scan(WS1);
  responses["events.select"] = [{ data: null, error: { message: "sin conexión" } }];
  const out = await expandAutomationEvents(FAR());
  // Un tenant caído suma a `errors` y el recorrido sigue con los demás: eso es
  // trabajo normal y el tick sigue siendo sano (200). Marcarlo como fase pondría
  // el monitor rojo por un lote transitorio de un solo tenant.
  assert.deepEqual(out, { events: 0, runs: 0, errors: 1 });
});

test("el lote por workspace se pide con el cupo por defecto de 50", async () => {
  reset();
  scan(WS1);
  responses["events.select"] = [{ data: [], error: null }];
  await expandAutomationEvents(FAR());
  assert.equal((calls.find((c) => c.key === "events.select")!.arg as { n: number }).n, 50);
});

test("si faltan las credenciales de Supabase, no lanza: devuelve errors = 1", async () => {
  // El invariante del módulo es NUNCA lanzar. createClient() revienta sin
  // url/key, y esa llamada vivía fuera de todo try — este test es el que iría
  // rojo si volviera a quedar afuera.
  reset();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const out = await expandAutomationEvents(FAR());
    // Y, como el scan, es un fallo de FASE: sin cliente no se expandió nada.
    assert.deepEqual(out, { events: 0, runs: 0, errors: 1, error: "client_failed" });
  } finally {
    process.env.NEXT_PUBLIC_SUPABASE_URL = url;
    process.env.SUPABASE_SERVICE_ROLE_KEY = key;
  }
});
