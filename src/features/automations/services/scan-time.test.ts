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
    if (table === "appointments") {
      return {
        select: () => {
          const filters: Record<string, unknown> = {};
          const chain: Record<string, unknown> = {
            eq: (col: string, val: unknown) => {
              filters[`eq:${col}`] = val;
              return chain;
            },
            in: (col: string, val: unknown) => {
              filters[`in:${col}`] = val;
              return chain;
            },
            gt: (col: string, val: unknown) => {
              filters[`gt:${col}`] = val;
              return chain;
            },
            lte: (col: string, val: unknown) => {
              filters[`lte:${col}`] = val;
              return chain;
            },
            not: (col: string, _op: string, val: unknown) => {
              filters[`not:${col}`] = val;
              return chain;
            },
            order: () => chain,
            limit: (n: number) => {
              const ws = filters["eq:workspace_id"] as string;
              push("appointments.select", { ws, filters, n });
              return Promise.resolve(take(`appointments.select:${ws}`));
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

const { scanTimeTriggers } = await import("./scan-time.ts");

const FAR = () => Date.now() + 60_000; // deadline holgado

function resetFakes() {
  responses = {};
  calls = [];
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

function appt(over: Record<string, unknown> = {}) {
  return {
    id: "appt_1",
    scheduled_at: "2026-09-09T22:00:00.000Z", // now + 10h
    created_at: "2026-09-06T12:00:00.000Z", // now - 3d, holgado para la anticipación mínima
    contact_id: "cont_1",
    conversation_id: "conv_1",
    ...over,
  };
}

/** No hay fila en `integrations` para el workspace: default UTC. */
function noIntegrations(ws: string) {
  responses[`integrations.select:${ws}`] = [{ data: [], error: null }];
}

function integrationsTimezone(
  ws: string,
  timezone: string | null,
  provider = "highlevel",
) {
  responses[`integrations.select:${ws}`] = [
    { data: [{ provider, config: { timezone } }], error: null },
  ];
}

/** Las dos integraciones configuradas, cada una en su zona. */
function integrationsBothTimezones(ws: string, highlevel: string, caldotcom: string) {
  responses[`integrations.select:${ws}`] = [
    {
      // A propósito con Cal.com PRIMERO en la respuesta: el desempate no puede
      // depender del orden en que PostgREST devuelva las filas.
      data: [
        { provider: "caldotcom", config: { timezone: caldotcom } },
        { provider: "highlevel", config: { timezone: highlevel } },
      ],
      error: null,
    },
  ];
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
  responses[`appointments.select:${WS1}`] = [{ data: [appt()], error: null }];
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
      occurrence: "24h:2026-09-09T22:00:00.000Z",
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
  responses[`appointments.select:${WS1}`] = [{ data: [appt()], error: null }];
  // El UNIQUE ya chocó: PostgREST con ignoreDuplicates devuelve 0 filas, sin error.
  responses["events.upsert"] = [{ data: [], error: null }];

  const tally = await withClock(NOW, () => scanTimeTriggers(FAR()));

  assert.deepEqual(tally, { events: 0, errors: 0 });
  assert.equal(calls.filter((c) => c.key === "events.upsert").length, 1);
});

test("cita reagendada → el occurrence lleva el scheduled_at nuevo, no el viejo", async () => {
  resetFakes();
  responses["rules.select"] = [{ data: [rule()], error: null }];
  noIntegrations(WS1);
  responses[`appointments.select:${WS1}`] = [
    { data: [appt({ scheduled_at: "2026-09-10T09:00:00.000Z" })], error: null },
  ];
  responses["events.upsert"] = [{ data: [{ id: 2 }], error: null }];

  await withClock(NOW, () => scanTimeTriggers(FAR()));

  const { rows } = calls.find((c) => c.key === "events.upsert")!.arg as {
    rows: Array<{ occurrence: string }>;
  };
  assert.equal(rows[0].occurrence, "24h:2026-09-10T09:00:00.000Z");
});

// ── filtros que decide Postgres (se prueba el filtro que se manda) ──

test("solo pide citas booked/confirmed — una cancelada nunca llega al select", async () => {
  resetFakes();
  responses["rules.select"] = [{ data: [rule()], error: null }];
  noIntegrations(WS1);
  responses[`appointments.select:${WS1}`] = [{ data: [], error: null }];

  await withClock(NOW, () => scanTimeTriggers(FAR()));

  const { arg } = calls.find((c) => c.key === "appointments.select")!;
  const filters = (arg as { filters: Record<string, unknown> }).filters;
  assert.deepEqual(filters["in:status"], ["booked", "confirmed"]);
});

test("cita ya pasada → el filtro scheduled_at > now() se manda con el reloj del tick", async () => {
  resetFakes();
  responses["rules.select"] = [{ data: [rule()], error: null }];
  noIntegrations(WS1);
  responses[`appointments.select:${WS1}`] = [{ data: [], error: null }];

  await withClock(NOW, () => scanTimeTriggers(FAR()));

  const { arg } = calls.find((c) => c.key === "appointments.select")!;
  const filters = (arg as { filters: Record<string, unknown> }).filters;
  assert.equal(filters["gt:scheduled_at"], NOW);
});

// ── La cita tiene que haber existido ANTES de entrar en la ventana ─────────

test("cita agendada con menos anticipación que la regla → no inserta", async () => {
  resetFakes();
  responses["rules.select"] = [{ data: [rule({ trigger_config: { hours_before: 24 } })], error: null }];
  noIntegrations(WS1);
  // Agendada 1h antes de "ahora", para una cita que es en 2h: nunca existió
  // 24h antes de scheduled_at.
  responses[`appointments.select:${WS1}`] = [
    {
      data: [
        appt({
          scheduled_at: "2026-09-09T14:00:00.000Z", // now + 2h
          created_at: "2026-09-09T11:00:00.000Z", // now - 1h
        }),
      ],
      error: null,
    },
  ];

  const tally = await withClock(NOW, () => scanTimeTriggers(FAR()));

  assert.deepEqual(tally, { events: 0, errors: 0 });
  assert.equal(calls.some((c) => c.key === "events.upsert"), false);
});

// ── Sin contacto o sin conversación, no se consume la clave de dedup ──────

test("contact_id null → no inserta", async () => {
  resetFakes();
  responses["rules.select"] = [{ data: [rule()], error: null }];
  noIntegrations(WS1);
  responses[`appointments.select:${WS1}`] = [
    { data: [appt({ contact_id: null })], error: null },
  ];

  const tally = await withClock(NOW, () => scanTimeTriggers(FAR()));

  assert.deepEqual(tally, { events: 0, errors: 0 });
  assert.equal(calls.some((c) => c.key === "events.upsert"), false);
});

test("conversation_id null → no inserta", async () => {
  resetFakes();
  responses["rules.select"] = [{ data: [rule()], error: null }];
  noIntegrations(WS1);
  responses[`appointments.select:${WS1}`] = [
    { data: [appt({ conversation_id: null })], error: null },
  ];

  const tally = await withClock(NOW, () => scanTimeTriggers(FAR()));

  assert.deepEqual(tally, { events: 0, errors: 0 });
  assert.equal(calls.some((c) => c.key === "events.upsert"), false);
});

// ── Ventana horaria, y default UTC cuando integrations.config es null ─

test("fuera de la ventana horaria (default 8-22, timezone null = UTC) → no inserta", async () => {
  resetFakes();
  responses["rules.select"] = [{ data: [rule()], error: null }];
  noIntegrations(WS1); // timezone null → UTC

  const tally = await withClock("2026-09-09T23:30:00.000Z", () => scanTimeTriggers(FAR()));

  assert.deepEqual(tally, { events: 0, errors: 0 });
  assert.equal(calls.some((c) => c.key === "appointments.select"), false);
});

test("dentro de la ventana (timezone null = UTC) → sí evalúa", async () => {
  resetFakes();
  responses["rules.select"] = [{ data: [rule()], error: null }];
  noIntegrations(WS1);
  responses[`appointments.select:${WS1}`] = [{ data: [], error: null }];

  await withClock(NOW, () => scanTimeTriggers(FAR())); // NOW = 12:00 UTC

  assert.equal(calls.some((c) => c.key === "appointments.select"), true);
});

test("America/Santiago corrida respecto de UTC — la misma hora que excluye en UTC incluye en la zona configurada", async () => {
  resetFakes();
  responses["rules.select"] = [{ data: [rule()], error: null }];
  integrationsTimezone(WS1, "America/Santiago");
  responses[`appointments.select:${WS1}`] = [{ data: [], error: null }];

  // 23:30 UTC excluye bajo el default UTC (test anterior); en Santiago
  // (UTC-3 o UTC-4 según DST) son las 19:30 u 20:30 — dentro de [8,22)
  // cualquiera sea el horario de verano vigente.
  await withClock("2026-09-09T23:30:00.000Z", () => scanTimeTriggers(FAR()));

  assert.equal(calls.some((c) => c.key === "appointments.select"), true);
});

test("con las dos integraciones en zonas distintas, gana highlevel — y no el orden de las filas", async () => {
  resetFakes();
  responses["rules.select"] = [{ data: [rule()], error: null }];
  // HighLevel en Santiago (19:30 u 20:30 a las 23:30 UTC → DENTRO de [8,22));
  // Cal.com en UTC (23:30 → FUERA). El resultado dice cuál se usó.
  integrationsBothTimezones(WS1, "America/Santiago", "UTC");
  responses[`appointments.select:${WS1}`] = [{ data: [], error: null }];

  await withClock("2026-09-09T23:30:00.000Z", () => scanTimeTriggers(FAR()));

  assert.equal(
    calls.some((c) => c.key === "appointments.select"),
    true,
    "el desempate tiene que ser fijo: si gana Cal.com, la ventana se evalúa en UTC y no evalúa nada",
  );
});

test("sin timezone en highlevel, cae a la de caldotcom antes que a UTC", async () => {
  resetFakes();
  responses["rules.select"] = [{ data: [rule()], error: null }];
  responses[`integrations.select:${WS1}`] = [
    {
      data: [
        { provider: "highlevel", config: { timezone: null } },
        { provider: "caldotcom", config: { timezone: "America/Santiago" } },
      ],
      error: null,
    },
  ];
  responses[`appointments.select:${WS1}`] = [{ data: [], error: null }];

  await withClock("2026-09-09T23:30:00.000Z", () => scanTimeTriggers(FAR()));

  assert.equal(calls.some((c) => c.key === "appointments.select"), true);
});

test("una zona horaria inválida NO evalúa este tick (no degrada a UTC)", async () => {
  resetFakes();
  responses["rules.select"] = [{ data: [rule()], error: null }];
  // "Santiago" en vez de "America/Santiago": Intl lanza RangeError dentro de
  // resolveWorkspaceTimezone, que ahora devuelve null en vez de degradar a
  // UTC. Un recordatorio con la hora corrida es peor que ningún recordatorio
  // así que la regla se salta este tick, no inserta nada.
  integrationsTimezone(WS1, "Santiago");
  const errSpy = mock.method(console, "error", () => {});

  try {
    const tally = await withClock(NOW, () => scanTimeTriggers(FAR())); // 12:00 UTC

    assert.equal(
      calls.some((c) => c.key === "appointments.select"),
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

test("highlevel con zona inválida y caldotcom válida → usa la de caldotcom, y avisa igual del typo", async () => {
  resetFakes();
  responses["rules.select"] = [{ data: [rule()], error: null }];
  // Un negocio tiene UNA zona horaria: si el proveedor prioritario la tiene mal
  // escrita y el otro bien, la bien escrita ES la del negocio. El orden de
  // TIMEZONE_PROVIDER_ORDER desempata entre zonas VÁLIDAS, no propaga el error
  // de la primera fila — cortar acá dejaría al tenant sin recordatorios por un
  // typo en una integración que quizás ni usa para agendar.
  responses[`integrations.select:${WS1}`] = [
    {
      data: [
        { provider: "highlevel", config: { timezone: "Santiago" } },
        { provider: "caldotcom", config: { timezone: "America/Santiago" } },
      ],
      error: null,
    },
  ];
  responses[`appointments.select:${WS1}`] = [{ data: [], error: null }];
  const errSpy = mock.method(console, "error", () => {});

  try {
    // 23:30 UTC = 19:30 o 20:30 en Santiago, dentro de [8,22). En UTC sería
    // la hora 23 y quedaría fuera, así que evaluar prueba que usó Santiago.
    const tally = await withClock("2026-09-09T23:30:00.000Z", () =>
      scanTimeTriggers(FAR()),
    );

    assert.equal(
      calls.some((c) => c.key === "appointments.select"),
      true,
      "la zona válida de caldotcom tiene que salvar el recordatorio",
    );
    assert.equal(tally.errors, 0, "usar el respaldo no es un error de la regla");
    assert.ok(
      errSpy.mock.calls.some((c) => String(c.arguments[0]).includes("Santiago")),
      "el typo se loguea igual, o no se arregla nunca",
    );
  } finally {
    errSpy.mock.restore();
  }
});

test("falla la lectura de integrations → no evalúa este tick, cuenta como error", async () => {
  resetFakes();
  responses["rules.select"] = [{ data: [rule()], error: null }];
  responses[`integrations.select:${WS1}`] = [
    { data: null, error: { message: "db down" } },
  ];
  const errSpy = mock.method(console, "error", () => {});

  try {
    const tally = await withClock(NOW, () => scanTimeTriggers(FAR()));

    assert.equal(
      calls.some((c) => c.key === "appointments.select"),
      false,
      "sin poder leer integrations no sabemos la zona: asumir UTC sería el mismo daño activo por la puerta de atrás",
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
  assert.equal(calls.some((c) => c.key === "appointments.select"), false);
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

test("una regla que revienta al leer appointments no tumba a las demás (falla por ítem)", async () => {
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
  responses[`appointments.select:${WS1}`] = [{ data: null, error: { message: "boom" } }];
  responses[`appointments.select:${WS2}`] = [{ data: [appt()], error: null }];
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
  responses[`appointments.select:${WS1}`] = [{ data: [], error: null }];

  // Deadline ya vencido antes de arrancar: ni la primera regla se evalúa.
  const tally = await withClock(NOW, () => scanTimeTriggers(Date.now() - 1));

  assert.deepEqual(tally, { events: 0, errors: 0 });
  assert.equal(calls.some((c) => c.key === "appointments.select"), false);
});
