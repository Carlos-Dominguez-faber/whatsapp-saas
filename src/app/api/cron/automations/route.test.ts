import assert from "node:assert/strict";
import { test, mock } from "node:test";

const scanCalls: Array<{ deadline: number; at: number }> = [];
let scanShouldThrow = false;
/** Código de fase que el scan-time DEVUELVE (sin lanzar), como en la vida real. */
let scanPhaseError: string | undefined;
mock.module("@/features/automations/services/scan-time.ts", {
  exports: {
    scanTimeTriggers: async (deadline: number) => {
      scanCalls.push({ deadline, at: Date.now() });
      if (scanShouldThrow) throw new Error("connection refused al escanear citas");
      if (scanPhaseError) {
        return { events: 0, errors: 1, error: scanPhaseError };
      }
      return { events: 2, errors: 0 };
    },
  },
});

const expandCalls: Array<{ deadline: number; at: number }> = [];
let expandShouldThrow = false;
/** Código de fase que la expansión DEVUELVE (sin lanzar), como en la vida real. */
let expandPhaseError: string | undefined;
/** Milisegundos que "tarda" la expansión, para probar el presupuesto. */
let expandDelayMs = 0;
mock.module("@/features/automations/services/expand.ts", {
  exports: {
    expandAutomationEvents: async (deadline: number) => {
      if (expandShouldThrow) throw new Error("connection refused a la base");
      expandCalls.push({ deadline, at: Date.now() });
      if (expandDelayMs > 0) await new Promise((r) => setTimeout(r, expandDelayMs));
      if (expandPhaseError) {
        return { events: 0, runs: 0, errors: 1, error: expandPhaseError };
      }
      return { events: 3, runs: 5, errors: 0 };
    },
  },
});

const drainCalls: Array<{ max: number; deadline: number; at: number }> = [];
let drainShouldThrow = false;
/** Código de fase que el drenaje DEVUELVE (sin lanzar): la RPC del claim falló. */
let drainPhaseError: string | undefined;
mock.module("@/features/automations/services/executor.ts", {
  exports: {
    drainAutomationRuns: async (max: number, deadline: number) => {
      drainCalls.push({ max, deadline, at: Date.now() });
      if (drainShouldThrow) throw new Error("connection refused al reclamar runs");
      if (drainPhaseError) {
        return { done: 4, failed: 1, skipped: 0, retry: 0, lost: 0, error: drainPhaseError };
      }
      return { done: 4, failed: 1, skipped: 0, retry: 0, lost: 0 };
    },
  },
});

const hubspotLogCalls: Array<{ deadline: number; at: number }> = [];
let hubspotLogsResult: Record<string, unknown> = { done: 1, retry: 0, failed: 0, cancelled: 0 };
let hubspotLogsShouldThrow = false;
mock.module("@/features/inbox/services/hubspot-log-queue.ts", {
  exports: {
    drainHubSpotConversationLogs: async (deadline: number) => {
      hubspotLogCalls.push({ deadline, at: Date.now() });
      if (hubspotLogsShouldThrow) throw new Error("connection refused en la cola de HubSpot");
      return hubspotLogsResult;
    },
  },
});

const { GET, maxDuration, RUN_BUDGET_MS } = await import("./route.ts");

function req(auth?: string) {
  return new Request("http://localhost/api/cron/automations", {
    headers: auth ? { Authorization: auth } : {},
  });
}

function reset() {
  scanCalls.length = 0;
  scanShouldThrow = false;
  scanPhaseError = undefined;
  expandCalls.length = 0;
  drainCalls.length = 0;
  expandShouldThrow = false;
  expandDelayMs = 0;
  expandPhaseError = undefined;
  drainShouldThrow = false;
  drainPhaseError = undefined;
  hubspotLogCalls.length = 0;
  hubspotLogsResult = { done: 1, retry: 0, failed: 0, cancelled: 0 };
  hubspotLogsShouldThrow = false;
}

// ── Camino correcto ──────────────────────────────────────────────────────────

test("con el bearer correcto escanea, expande y después drena, con la forma exacta del JSON", async () => {
  reset();
  process.env.CRON_SECRET = "s3cret";
  const res = await GET(req("Bearer s3cret"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    ok: true,
    scanned: { events: 2, errors: 0 },
    expanded: { events: 3, runs: 5, errors: 0 },
    executed: { done: 4, failed: 1, skipped: 0, retry: 0, lost: 0 },
    hubspotLogs: { done: 1, retry: 0, failed: 0, cancelled: 0 },
  });
  assert.equal(scanCalls.length, 1);
  assert.equal(expandCalls.length, 1);
  assert.equal(drainCalls.length, 1);
  assert.ok(
    scanCalls[0].at <= expandCalls[0].at,
    "escanear ANTES de expandir: si no, los eventos que puso el scan esperan al siguiente tick",
  );
  assert.ok(
    expandCalls[0].at <= drainCalls[0].at,
    "expandir ANTES de drenar: si no, los eventos de este tick esperan al siguiente",
  );
  assert.ok(drainCalls[0].at <= hubspotLogCalls[0].at, "la cola de HubSpot va DESPUÉS del drenaje del motor");
  assert.equal(hubspotLogCalls[0].deadline, drainCalls[0].deadline, "mismo deadline de la corrida");
});

test("el presupuesto cabe dentro del intervalo del cron", () => {
  // Los tres números son un solo invariante: si maxDuration sube por encima del
  // minuto del job, dos ticks corren a la vez como caso NORMAL. Y si
  // RUN_BUDGET_MS iguala al maxDuration, la función se corta a mitad de una fila.
  assert.equal(maxDuration, 60);
  assert.ok(
    RUN_BUDGET_MS < maxDuration * 1000,
    "el presupuesto tiene que dejar margen dentro del maxDuration",
  );
  assert.ok(
    maxDuration * 1000 <= 60_000,
    "el job corre cada minuto: un maxDuration mayor garantiza solape",
  );
  assert.equal(RUN_BUDGET_MS, 50_000);
});

test("el drenaje recibe (20, deadline) con el presupuesto de la corrida", async () => {
  reset();
  process.env.CRON_SECRET = "s3cret";
  await GET(req("Bearer s3cret"));
  const { max, deadline, at } = drainCalls[0];
  assert.equal(max, 20);
  const restante = deadline - at;
  assert.ok(
    restante > 45_000 && restante <= 50_000,
    `esperaba ~50000 ms de presupuesto, quedaban ${restante}`,
  );
});

test("el presupuesto se fija ANTES de expandir: una expansión lenta lo descuenta", async () => {
  reset();
  process.env.CRON_SECRET = "s3cret";
  // Si el deadline se fijara dentro de drainAutomationRuns, la ruta podría
  // consumir el tiempo de la expansión MÁS los 50 s del drenaje contra un
  // maxDuration de 60, y morir a mitad de una fila dejándola 'processing'.
  expandDelayMs = 50;
  await GET(req("Bearer s3cret"));
  const { deadline, at } = drainCalls[0];
  const restante = deadline - at;
  assert.ok(restante < 50_000, `el deadline tiene que venir descontado (quedaban ${restante})`);
  assert.ok(restante > 40_000, "y seguir siendo el presupuesto de la corrida, no un valor nuevo");
  assert.equal(
    expandCalls[0].deadline,
    deadline,
    "las dos etapas comparten EL MISMO instante absoluto",
  );
  assert.equal(
    scanCalls[0].deadline,
    deadline,
    "las tres etapas comparten EL MISMO instante absoluto",
  );
});

// ── Caminos de error ─────────────────────────────────────────────────────────

test("falla cerrado cuando CRON_SECRET no está configurado, aunque el header coincida", async () => {
  reset();
  delete process.env.CRON_SECRET;
  // El header que mandaría un cron mal configurado si el secreto fuera undefined.
  const res = await GET(req("Bearer undefined"));
  assert.equal(res.status, 401);
  assert.equal(expandCalls.length, 0);
  assert.equal(drainCalls.length, 0);
});

test("401 con bearer equivocado del MISMO largo, de otro largo, o ausente", async () => {
  reset();
  // Un secreto realista: el que genera scripts/setup.mjs es hexadecimal.
  process.env.CRON_SECRET = "a1b2c3d4e5f60718";

  // El caso que de verdad prueba la comparación
  // es un secreto INCORRECTO DEL MISMO LARGO. Con largos distintos, el guard de
  // longitud que va antes de timingSafeEqual corta primero y el test pasa sin
  // haber ejercitado nunca la comparación real — que es lo único que puede
  // estar mal escrito.
  assert.equal((await GET(req("Bearer a1b2c3d4e5f60719"))).status, 401);
  assert.equal((await GET(req("Bearer 0000000000000000"))).status, 401);

  // Los otros dos caminos siguen cubiertos.
  assert.equal((await GET(req("Bearer corto"))).status, 401);
  assert.equal((await GET(req())).status, 401);
  assert.equal(drainCalls.length, 0);

  // Camino correcto con el mismo secreto largo: el 200 tiene que seguir saliendo.
  assert.equal((await GET(req("Bearer a1b2c3d4e5f60718"))).status, 200);
  assert.equal(drainCalls.length, 1);
});

test("si la expansión falla igual se ejecuta la cola pendiente, se responde 500 y no se filtra el error", async () => {
  reset();
  process.env.CRON_SECRET = "s3cret";
  expandShouldThrow = true;
  const res = await GET(req("Bearer s3cret"));
  // Una fase que lanzó no puede salir con el código del tick sano.
  assert.equal(res.status, 500);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.ok, false);
  assert.deepEqual(body.expanded, { events: 0, runs: 0, errors: 1, error: "expand_threw" });
  assert.deepEqual(body.executed, { done: 4, failed: 1, skipped: 0, retry: 0, lost: 0 });
  assert.equal(drainCalls.length, 1, "la cola ya expandida no depende de que la expansión ande");
  // El detalle técnico vive SOLO en el log del servidor.
  assert.ok(
    !JSON.stringify(body).includes("connection refused"),
    "la respuesta no puede exponer el mensaje crudo de la base",
  );
});

test("la RPC del claim que DEVUELVE error responde 500 con claim_failed y conserva el tally", async () => {
  reset();
  process.env.CRON_SECRET = "s3cret";
  drainPhaseError = "claim_failed";
  const res = await GET(req("Bearer s3cret"));
  // El `break` del drenaje sale sin lanzar; sin leer `error`, la ruta
  // firmaría `200 {ok:true}` con el tally en ceros: indistinguible de una cola
  // vacía, con la cola creciendo y el monitoreo en verde.
  assert.equal(res.status, 500);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.ok, false);
  assert.deepEqual(
    body.executed,
    { done: 4, failed: 1, skipped: 0, retry: 0, lost: 0, error: "claim_failed" },
    "el tally de los runs que el tick SÍ ejecutó no se pierde (por eso no se lanza)",
  );
  assert.deepEqual(body.expanded, { events: 3, runs: 5, errors: 0 });
});

test("la expansión que DEVUELVE su código de fase responde 500, y el drenaje igual corre", async () => {
  reset();
  process.env.CRON_SECRET = "s3cret";
  expandPhaseError = "scan_failed";
  const res = await GET(req("Bearer s3cret"));
  assert.equal(res.status, 500);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.ok, false);
  assert.deepEqual(body.expanded, { events: 0, runs: 0, errors: 1, error: "scan_failed" });
  assert.equal(drainCalls.length, 1, "la cola ya expandida no depende del scan");
  assert.deepEqual(body.executed, { done: 4, failed: 1, skipped: 0, retry: 0, lost: 0 });
});

test("scan-time que DEVUELVE su código de fase responde 500 con scan_time_failed, y expansión + drenaje igual corren", async () => {
  reset();
  process.env.CRON_SECRET = "s3cret";
  scanPhaseError = "scan_time_failed";
  const res = await GET(req("Bearer s3cret"));
  assert.equal(res.status, 500);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.ok, false);
  assert.deepEqual(body.scanned, { events: 0, errors: 1, error: "scan_time_failed" });
  assert.equal(expandCalls.length, 1, "la expansión no depende de que el scan haya andado");
  assert.equal(drainCalls.length, 1, "el drenaje no depende de que el scan haya andado");
  assert.deepEqual(
    body.expanded,
    { events: 3, runs: 5, errors: 0 },
    "el tally de la expansión no se pierde por un scan caído",
  );
  assert.deepEqual(
    body.executed,
    { done: 4, failed: 1, skipped: 0, retry: 0, lost: 0 },
    "el tally del drenaje no se pierde por un scan caído",
  );
});

test("si scanTimeTriggers lanza, la ruta no revienta pero responde 500 con ok:false y scan_time_failed", async () => {
  reset();
  process.env.CRON_SECRET = "s3cret";
  scanShouldThrow = true;
  const res = await GET(req("Bearer s3cret"));
  assert.equal(res.status, 500);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.ok, false);
  assert.deepEqual(body.scanned, { events: 0, errors: 1, error: "scan_time_failed" });
  assert.equal(expandCalls.length, 1, "la expansión igual corre aunque el scan haya lanzado");
  assert.equal(drainCalls.length, 1, "el drenaje igual corre aunque el scan haya lanzado");
  assert.ok(
    !JSON.stringify(body).includes("connection refused"),
    "la respuesta no puede exponer el mensaje crudo de la excepción",
  );
});

test("`failed > 0` sin fallo de fase SIGUE siendo 200 — falla por ítem, no del tick", async () => {
  reset();
  process.env.CRON_SECRET = "s3cret";
  // El camino sano no cambió: el mock devuelve failed:1 y el tick es sano.
  const res = await GET(req("Bearer s3cret"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.equal((body.executed as { failed: number }).failed, 1);
  assert.ok(
    !Object.hasOwn(body.executed as object, "error"),
    "sin fallo de fase el body no lleva código: hacerlo 500 pondría el monitor rojo por un lote transitorio",
  );
});

test("si drainAutomationRuns lanza, la ruta no revienta pero responde 500 con ok:false y el código de la fase", async () => {
  reset();
  process.env.CRON_SECRET = "s3cret";
  drainShouldThrow = true;
  const res = await GET(req("Bearer s3cret"));
  // El try/catch sigue evitando que Next tumbe la ruta con un 500 sin body
  // (por eso el body de abajo tiene que llegar entero), pero el estado ya NO
  // puede ser el del tick sano: 200 + ok:true es la comprobación de salud
  // documentada, y un drenaje que no ejecutó nada no la puede firmar.
  assert.equal(res.status, 500);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.ok, false);
  assert.deepEqual(
    body.expanded,
    { events: 3, runs: 5, errors: 0 },
    "la expansión ya corrió y está confirmada en base: su resultado no se pierde",
  );
  assert.deepEqual(body.executed, {
    done: 0,
    failed: 0,
    skipped: 0,
    retry: 0,
    lost: 0,
    error: "drain_threw",
  });
  // El detalle técnico vive SOLO en el log del servidor, nunca en el body.
  assert.ok(
    !JSON.stringify(body).includes("connection refused"),
    "la respuesta no puede exponer el mensaje crudo de la excepción",
  );
});

test("la fase hubspotLogs que DEVUELVE su código responde 500 y conserva el resto del tally", async () => {
  reset();
  process.env.CRON_SECRET = "s3cret";
  hubspotLogsResult = { done: 0, retry: 0, failed: 0, cancelled: 0, error: "hubspot_logs_claim_failed" };
  const res = await GET(req("Bearer s3cret"));
  assert.equal(res.status, 500);
  const body = (await res.json()) as { ok: boolean; executed: unknown; hubspotLogs: { error: string } };
  assert.equal(body.ok, false);
  assert.equal(body.hubspotLogs.error, "hubspot_logs_claim_failed");
  assert.deepEqual(body.executed, { done: 4, failed: 1, skipped: 0, retry: 0, lost: 0 });
});

test("si la fase hubspotLogs lanza, la ruta no revienta: 500 con hubspot_logs_threw y sin el mensaje", async () => {
  reset();
  process.env.CRON_SECRET = "s3cret";
  hubspotLogsShouldThrow = true;
  const res = await GET(req("Bearer s3cret"));
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.ok(text.includes("hubspot_logs_threw"));
  assert.ok(!text.includes("connection refused"));
});

test("si el motor se cae, la cola de HubSpot igual corre", async () => {
  reset();
  process.env.CRON_SECRET = "s3cret";
  drainShouldThrow = true;
  await GET(req("Bearer s3cret"));
  assert.equal(hubspotLogCalls.length, 1);
});
