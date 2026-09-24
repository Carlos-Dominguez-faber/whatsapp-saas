import test from "node:test";
import assert from "node:assert/strict";

import { retryLookup, unwrapResult } from "./retry.ts";

/** sleep falso: registra las esperas en vez de dormirlas. */
function fakeSleep() {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

test("devuelve al primer intento sin esperar", async () => {
  const { waits, sleep } = fakeSleep();
  let calls = 0;

  const found = await retryLookup(
    async () => {
      calls++;
      return { id: "msg-1" };
    },
    { sleep },
  );

  assert.deepEqual(found, { id: "msg-1" });
  assert.equal(calls, 1, "no debe reintentar si encontró a la primera");
  assert.deepEqual(waits, [], "no debe esperar si encontró a la primera");
});

test("reintenta hasta encontrar: el insert llega tarde", async () => {
  const { waits, sleep } = fakeSleep();
  let calls = 0;

  const found = await retryLookup(
    async () => {
      calls++;
      return calls < 3 ? null : { id: "msg-2" };
    },
    { sleep },
  );

  assert.deepEqual(found, { id: "msg-2" });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [300, 300], "espera entre intentos, no después");
});

test("se rinde tras agotar los intentos y devuelve null", async () => {
  const { waits, sleep } = fakeSleep();
  let calls = 0;

  const found = await retryLookup(
    async () => {
      calls++;
      return null;
    },
    { sleep },
  );

  assert.equal(found, null, "sin fila: null, no undefined ni excepción");
  assert.equal(calls, 3, "exactamente 3 intentos por defecto");
  assert.equal(waits.length, 2, "no debe esperar después del último intento");
});

test("undefined cuenta como no encontrado", async () => {
  const { sleep } = fakeSleep();
  const found = await retryLookup(async () => undefined, { attempts: 2, sleep });
  assert.equal(found, null);
});

test("respeta attempts y delayMs personalizados", async () => {
  const { waits, sleep } = fakeSleep();
  let calls = 0;

  await retryLookup(
    async () => {
      calls++;
      return null;
    },
    { attempts: 5, delayMs: 50, sleep },
  );

  assert.equal(calls, 5);
  assert.deepEqual(waits, [50, 50, 50, 50]);
});

test("attempts: 1 no reintenta", async () => {
  const { waits, sleep } = fakeSleep();
  let calls = 0;

  await retryLookup(
    async () => {
      calls++;
      return null;
    },
    { attempts: 1, sleep },
  );

  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test("propaga el error del lookup en vez de tragárselo", async () => {
  const { sleep } = fakeSleep();

  await assert.rejects(
    () =>
      retryLookup(
        async () => {
          throw new Error("conexión caída");
        },
        { sleep },
      ),
    /conexión caída/,
    "un fallo real de DB no debe disfrazarse de 'mensaje no encontrado'",
  );
});

// ── contrato real de Supabase: `{ data, error }`, la promesa NO se rechaza ────
//
// El test viejo ("propaga el error del lookup") usaba una función que LANZA, que
// no es lo que hace supabase-js: ante un fallo de SQL, un timeout o Postgres
// caído, resuelve `{ data: null, error: {…} }`. Lo que se prueba acá es el
// desenvolvedor que usa la ruta del webhook.

test("unwrapResult: camino feliz, devuelve data", () => {
  assert.deepEqual(
    unwrapResult({ data: { id: "msg-1" }, error: null }, "messages lookup"),
    { id: "msg-1" },
  );
});

test("unwrapResult: sin filas (data null, error null) es 'no encontrado', no un fallo", () => {
  assert.equal(unwrapResult({ data: null, error: null }, "messages lookup"), null);
});

test("unwrapResult: {data:null, error:{…}} lanza — un fallo de base no es 'no encontrado'", () => {
  assert.throws(
    () =>
      unwrapResult(
        { data: null, error: { message: "canceling statement due to statement timeout" } },
        "messages lookup",
      ),
    /messages lookup: canceling statement/,
  );
});

test("retryLookup + unwrapResult: un error de base corta los reintentos y se propaga", async () => {
  const { waits, sleep } = fakeSleep();
  let calls = 0;

  await assert.rejects(
    () =>
      retryLookup(async () => {
        calls++;
        // Lo que devuelve supabase-js cuando la base se cae.
        return unwrapResult(
          { data: null, error: { message: "connection terminated" } },
          "messages lookup",
        );
      }, { sleep }),
    /connection terminated/,
    "debe propagarse para que el webhook responda 500 y el proveedor reintente",
  );
  assert.equal(calls, 1, "no tiene sentido reintentar 3 veces una base caída");
  assert.deepEqual(waits, []);
});

test("retryLookup + unwrapResult: 0 filas sí reintenta (el insert puede venir en camino)", async () => {
  const { waits, sleep } = fakeSleep();
  let calls = 0;

  const found = await retryLookup(async () => {
    calls++;
    return unwrapResult(
      calls < 2
        ? { data: null, error: null }
        : { data: { id: "msg-9" }, error: null },
      "messages lookup",
    );
  }, { sleep });

  assert.deepEqual(found, { id: "msg-9" });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [300]);
});
