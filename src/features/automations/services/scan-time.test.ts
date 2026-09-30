import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

// ── Fake de PostgREST, por tabla ────────────────────────────────────────────
// Mismo patrón que expand.test.ts: colas de respuesta por clave, y `calls`
// para poder afirmar QUÉ filtros mandó el código (status, scheduled_at, los
// dos NOT NULL), que es lo único que prueba que la fase 0 le pidió a
// Postgres el filtro correcto — la fila filtrada de verdad la descarta la
// base, no este fake.
type Res = { data?: unknown; error?: unknown };

let responses: Record<string, Res[]> = {};
let calls: Array<{ key: string; arg?: unknown }> = [];

function take(key: string): Res {
  const q = responses[key];
  return q && q.length ? q.shift()! : { data: [], error: null };
}
function push(key: string, arg?: unknown) {
  calls.push({ key, arg });
}

const fakeClient = {
  // automation_reminder_candidates: the database picks the appointments; the
  // fake answers per rule and records what it was asked.
  rpc(fn: string, args: { p_rule_id: string; p_now: string; p_limit: number }) {
    push("candidates.rpc", { fn, ...args });
    return Promise.resolve(take(`candidates:${args.p_rule_id}`));
  },
  from(table: string) {
    if (table === "automation_rules") {
      return {
        select: () => {
          const filters: Record<string, unknown> = {};
          const chain: Record<string, unknown> = {
            eq: (col: string, val: unknown) => {
              filters[`eq:${col}`] = val;
              return chain;
            },
            then: (resolve: (v: Res) => void) => {
              push("rules.select", filters);
              resolve(take("rules.select"));
            },
          };
          return chain;
        },
      };
    }
    if (table === "integrations") {
      return {
        select: () => {
          const filters: Record<string, unknown> = {};
          const chain: Record<string, unknown> = {
            eq: (col: string, val: unknown) => {
              filters[`eq:${col}`] = val;
              return chain;
            },
            in: (col: string, vals: unknown[]) => {
              filters[`in:${col}`] = vals;
              return chain;
            },
            then: (resolve: (v: Res) => void) => {
              const ws = filters["eq:workspace_id"] as string;
              push("integrations.select", filters);
              resolve(take(`integrations.select:${ws}`));
            },
          };
          return chain;
        },
      };
    }
    if (table === "automation_events") {
      return {
        upsert: (rows: unknown, opts: unknown) => ({
          select: () => {
            push("events.upsert", { rows, opts });
            return Promise.resolve(take("events.upsert"));
          },
        }),
      };
    }
    throw new Error(`tabla inesperada en el fake: ${table}`);
  },
};

mock.module("@supabase/supabase-js", {
  exports: {
    createClient: (url?: string, key?: string) => {
      if (!url || !key) throw new Error("supabaseUrl is required.");
      return fakeClient;
    },
  },
});

// The zone comes from the shared resolver (business zone → HighLevel's →
// DEFAULT_TIMEZONE; null when the settings can't be read). Its own rules are
// tested in workspace-timezone.test.ts; here each workspace just has one.
let zones: Record<string, string | null> = {};
mock.module("@/features/automations/lib/workspace-timezone.ts", {
  exports: {
    resolveWorkspaceTimezone: async (_db: unknown, ws: string) =>
      ws in zones ? zones[ws] : "UTC",
  },
});

const { scanTimeTriggers } = await import("./scan-time.ts");

const FAR = () => Date.now() + 60_000; // deadline holgado

function resetFakes() {
  responses = {};
  calls = [];
  zones = {};
}

const WS1 = "11111111-1111-1111-1111-111111111111";
const WS2 = "22222222-2222-2222-2222-222222222222";

function rule(over: Record<string, unknown> = {}) {
  return {
    id: "rule_1",
    workspace_id: WS1,
    trigger_config: { hours_before: 24 },
    ...over,
  };
}

function candidate(over: Record<string, unknown> = {}) {
  return {
    subject_id: "appt_1",
    occurrence: "rule_1:24h:2026-09-09T22:00:00.000Z",
    scheduled_at: "2026-09-09T22:00:00.000Z", // now + 10h
    contact_id: "cont_1",
    conversation_id: "conv_1",
    ...over,
  };
}

/** The workspace's scheduling zone is UTC (the fixtures' times are in UTC). */
function noIntegrations(ws: string) {
  zones[ws] = "UTC";
}

function integrationsTimezone(ws: string, timezone: string | null) {
  zones[ws] = timezone;
}

const NOW = "2026-09-09T12:00:00.000Z"; // hora 12 UTC — dentro de [8,22)

// `fn` es async: si el reset corriera en un `finally` síncrono, se dispararía
// apenas `fn()` devuelve la promesa pendiente (antes del primer `await`
// interno de scanTimeTriggers), y `new Date()` adentro leería el reloj real
// en vez del mockeado. Por eso `withClock` también es async y espera `fn()`.
async function withClock<T>(nowIso: string, fn: () => T | Promise<T>): Promise<T> {
  mock.timers.enable({ apis: ["Date"], now: new Date(nowIso).getTime() });
  try {
    return await fn();
  } finally {
    mock.timers.reset();
  }
}

// ── camino feliz ─────────────────────────────────────────────────────────────

test("cita dentro de la ventana → inserta el evento con el occurrence esperado, copiando contact_id/conversation_id", async () => {
  resetFakes();
  responses["rules.select"] = [{ data: [rule()], error: null }];
  noIntegrations(WS1);
  responses["candidates:rule_1"] = [{ data: [candidate()], error: null }];
  responses["events.upsert"] = [{ data: [{ id: 1 }], error: null }];

  const tally = await withClock(NOW, () => scanTimeTriggers(FAR()));

  assert.deepEqual(tally, { events: 1, errors: 0 });
  const upsertCall = calls.find((c) => c.key === "events.upsert");
  assert.ok(upsertCall);
  const { rows, opts } = upsertCall!.arg as { rows: unknown[]; opts: unknown };
  assert.deepEqual(rows, [
    {
      workspace_id: WS1,
      event_type: "appointment_upcoming",
      subject_id: "appt_1",
      // The rule id leads the occurrence: two reminder rules with the same lead
      // time get one event each.
      occurrence: "rule_1:24h:2026-09-09T22:00:00.000Z",
      contact_id: "cont_1",
      conversation_id: "conv_1",
      rule_id: "rule_1",
    },
  ]);
  assert.deepEqual(opts, {
    onConflict: "event_type,subject_id,occurrence",
    ignoreDuplicates: true,
  });
});

test("segundo tick sobre la misma cita → el upsert corre pero el conflicto devuelve 0 filas (dedup)", async () => {
  resetFakes();
  responses["rules.select"] = [{ data: [rule()], error: null }];
  noIntegrations(WS1);
  responses["candidates:rule_1"] = [{ data: [candidate()], error: null }];
  // El UNIQUE ya chocó: PostgREST con ignoreDuplicates devuelve 0 filas, sin error.
  responses["events.upsert"] = [{ data: [], error: null }];

  const tally = await withClock(NOW, () => scanTimeTriggers(FAR()));

  assert.deepEqual(tally, { events: 0, errors: 0 });
  assert.equal(calls.filter((c) => c.key === "events.upsert").length, 1);
});

test("the occurrence is the one the database built (the key it checks against)", async () => {
  resetFakes();
  responses["rules.select"] = [{ data: [rule()], error: null }];
  noIntegrations(WS1);
  responses["candidates:rule_1"] = [
    { data: [candidate({ occurrence: "rule_1:24h:2026-09-10T09:00:00.000Z" })], error: null },
  ];
  responses["events.upsert"] = [{ data: [{ id: 2 }], error: null }];

  await withClock(NOW, () => scanTimeTriggers(FAR()));

  const { rows } = calls.find((c) => c.key === "events.upsert")!.arg as {
    rows: Array<{ occurrence: string }>;
  };
  assert.equal(rows[0].occurrence, "rule_1:24h:2026-09-10T09:00:00.000Z");
});

test("asks the database for this rule's due, not-yet-emitted appointments, with the tick's clock and a batch of 50", async () => {
  resetFakes();
  responses["rules.select"] = [{ data: [rule()], error: null }];
  noIntegrations(WS1);
  responses["candidates:rule_1"] = [{ data: [], error: null }];

  await withClock(NOW, () => scanTimeTriggers(FAR()));

  const { arg } = calls.find((c) => c.key === "candidates.rpc")!;
  assert.deepEqual(arg, {
    fn: "automation_reminder_candidates",
    p_rule_id: "rule_1",
    p_now: NOW,
    p_limit: 50,
  });
});

test("a full batch is emitted whole and only warns: the next tick continues", async () => {
  resetFakes();
  responses["rules.select"] = [{ data: [rule()], error: null }];
  noIntegrations(WS1);
  const fifty = Array.from({ length: 50 }, (_, i) =>
    candidate({ subject_id: `appt_${i}`, occurrence: `rule_1:24h:2026-09-09T${String(12 + (i % 10)).padStart(2, "0")}:${String(i).padStart(2, "0")}:00.000Z` }),
  );
  responses["candidates:rule_1"] = [{ data: fifty, error: null }];
  responses["events.upsert"] = [{ data: fifty.map((_, i) => ({ id: i })), error: null }];
  const warn = mock.method(console, "warn", () => {});
  try {
    const tally = await withClock(NOW, () => scanTimeTriggers(FAR()));
    assert.equal(tally.events, 50);
    assert.equal(warn.mock.calls.length, 1);
  } finally {
    warn.mock.restore();
  }
});

// ── Sin contacto o sin conversación, no se consume la clave de dedup ──────

test("contact_id null → no inserta", async () => {
  resetFakes();
  responses["rules.select"] = [{ data: [rule()], error: null }];
  noIntegrations(WS1);
  responses["candidates:rule_1"] = [{ data: [candidate({ contact_id: null })], error: null }];

  const tally = await withClock(NOW, () => scanTimeTriggers(FAR()));

  assert.deepEqual(tally, { events: 0, errors: 0 });
  assert.equal(calls.some((c) => c.key === "events.upsert"), false);
});

test("conversation_id null → no inserta", async () => {
  resetFakes();
  responses["rules.select"] = [{ data: [rule()], error: null }];
  noIntegrations(WS1);
  responses["candidates:rule_1"] = [{ data: [candidate({ conversation_id: null })], error: null }];

  const tally = await withClock(NOW, () => scanTimeTriggers(FAR()));

  assert.deepEqual(tally, { events: 0, errors: 0 });
  assert.equal(calls.some((c) => c.key === "events.upsert"), false);
});

// ── Ventana horaria, en la zona del workspace ─

test("fuera de la ventana horaria (default 8-22, zona UTC) → no inserta", async () => {
  resetFakes();
  responses["rules.select"] = [{ data: [rule()], error: null }];
  noIntegrations(WS1); // timezone null → UTC

  const tally = await withClock("2026-09-09T23:30:00.000Z", () => scanTimeTriggers(FAR()));

  assert.deepEqual(tally, { events: 0, errors: 0 });
  assert.equal(calls.some((c) => c.key === "candidates.rpc"), false);
});

test("dentro de la ventana (zona UTC) → sí evalúa", async () => {
  resetFakes();
  responses["rules.select"] = [{ data: [rule()], error: null }];
  noIntegrations(WS1);
  responses["candidates:rule_1"] = [{ data: [], error: null }];

  await withClock(NOW, () => scanTimeTriggers(FAR())); // NOW = 12:00 UTC

  assert.equal(calls.some((c) => c.key === "candidates.rpc"), true);
});

test("America/Santiago corrida respecto de UTC — la misma hora que excluye en UTC incluye en la zona configurada", async () => {
  resetFakes();
  responses["rules.select"] = [{ data: [rule()], error: null }];
  integrationsTimezone(WS1, "America/Santiago");
  responses["candidates:rule_1"] = [{ data: [], error: null }];

  // 23:30 UTC excluye bajo el default UTC (test anterior); en Santiago
  // (UTC-3 o UTC-4 según DST) son las 19:30 u 20:30 — dentro de [8,22)
  // cualquiera sea el horario de verano vigente.
  await withClock("2026-09-09T23:30:00.000Z", () => scanTimeTriggers(FAR()));

  assert.equal(calls.some((c) => c.key === "candidates.rpc"), true);
});



test("sin zona confiable (el resolvedor devuelve null) NO evalúa este tick", async () => {
  resetFakes();
  responses["rules.select"] = [{ data: [rule()], error: null }];
  // "Santiago" en vez de "America/Santiago": Intl lanza RangeError dentro de
  // resolveWorkspaceTimezone, que ahora devuelve null en vez de degradar a
  // UTC. Un recordatorio con la hora corrida es peor que ningún recordatorio
  // así que la regla se salta este tick, no inserta nada.
  integrationsTimezone(WS1, null);
  const errSpy = mock.method(console, "error", () => {});

  try {
    const tally = await withClock(NOW, () => scanTimeTriggers(FAR())); // 12:00 UTC

    assert.equal(
      calls.some((c) => c.key === "candidates.rpc"),
      false,
      "sin zona confiable, la regla no puede evaluar la ventana horaria: no llega a pedir citas",
    );
    assert.deepEqual(tally, { events: 0, errors: 1 });
    assert.ok(
      errSpy.mock.calls.some((c) =>
        String(c.arguments[0]).includes(WS1) && String(c.arguments[0]).includes("rule_1"),
      ),
      "el console.error tiene que nombrar workspace y regla",
    );
  } finally {
    errSpy.mock.restore();
  }
});



// ── trigger_config inválido: se descarta la regla, nunca revienta ─────────

test("hours_before no numérico → se descarta la regla, cuenta como error, no revienta", async () => {
  resetFakes();
  responses["rules.select"] = [
    { data: [rule({ trigger_config: { hours_before: "abc" } })], error: null },
  ];

  const tally = await withClock(NOW, () => scanTimeTriggers(FAR()));

  assert.deepEqual(tally, { events: 0, errors: 1 });
  assert.equal(calls.some((c) => c.key === "candidates.rpc"), false);
});

test("hours_before fuera de rango (0 o > 168) → se descarta la regla, cuenta como error", async () => {
  resetFakes();
  responses["rules.select"] = [
    { data: [rule({ id: "r1", trigger_config: { hours_before: 0 } })], error: null },
  ];

  const tally = await withClock(NOW, () => scanTimeTriggers(FAR()));

  assert.deepEqual(tally, { events: 0, errors: 1 });
});

// ── fallos: por ítem no tumba el tick; de fase sí se declara ───────────────

test("una regla cuya consulta revienta no tumba a las demás (falla por ítem)", async () => {
  resetFakes();
  responses["rules.select"] = [
    {
      data: [
        rule({ id: "r1", workspace_id: WS1 }),
        rule({ id: "r2", workspace_id: WS2 }),
      ],
      error: null,
    },
  ];
  noIntegrations(WS1);
  noIntegrations(WS2);
  responses["candidates:r1"] = [{ data: null, error: { message: "boom" } }];
  responses["candidates:r2"] = [{ data: [candidate()], error: null }];
  responses["events.upsert"] = [{ data: [{ id: 1 }], error: null }];

  const tally = await withClock(NOW, () => scanTimeTriggers(FAR()));

  assert.deepEqual(tally, { events: 1, errors: 1 });
});

test("falla al listar las reglas activas → error de FASE (scan_time_failed), no lanza", async () => {
  resetFakes();
  responses["rules.select"] = [{ data: null, error: { message: "db down" } }];

  const tally = await withClock(NOW, () => scanTimeTriggers(FAR()));

  assert.deepEqual(tally, { events: 0, errors: 1, error: "scan_time_failed" });
});

test("deadline alcanzado entre reglas → corta y deja el resto para el próximo tick", async () => {
  resetFakes();
  responses["rules.select"] = [
    {
      data: [
        rule({ id: "r1", workspace_id: WS1 }),
        rule({ id: "r2", workspace_id: WS2 }),
      ],
      error: null,
    },
  ];
  noIntegrations(WS1);
  responses["candidates:rule_1"] = [{ data: [], error: null }];

  // Deadline ya vencido antes de arrancar: ni la primera regla se evalúa.
  const tally = await withClock(NOW, () => scanTimeTriggers(Date.now() - 1));

  assert.deepEqual(tally, { events: 0, errors: 0 });
  assert.equal(calls.some((c) => c.key === "candidates.rpc"), false);
});

test("dos reglas con la misma anticipación generan un evento cada una", async () => {
  resetFakes();
  responses["rules.select"] = [
    { data: [rule({ id: "rule_a" }), rule({ id: "rule_b" })], error: null },
  ];
  noIntegrations(WS1);
  responses["candidates:rule_a"] = [{ data: [candidate({ occurrence: "rule_a:24h:2026-09-09T22:00:00.000Z" })], error: null }];
  responses["candidates:rule_b"] = [{ data: [candidate({ occurrence: "rule_b:24h:2026-09-09T22:00:00.000Z" })], error: null }];
  responses["events.upsert"] = [
    { data: [{ id: 1 }], error: null },
    { data: [{ id: 2 }], error: null },
  ];

  const tally = await withClock(NOW, () => scanTimeTriggers(FAR()));

  const occurrences = calls
    .filter((c) => c.key === "events.upsert")
    .map((c) => (c.arg as { rows: Array<{ occurrence: string }> }).rows[0].occurrence);
  assert.equal(tally.events, 2);
  assert.notEqual(occurrences[0], occurrences[1], "cada regla tiene su propia ocurrencia");
});
