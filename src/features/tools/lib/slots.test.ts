import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAvailabilityOutput,
  groupByDay,
  resolveTimeZone,
  zonedDayRange,
} from "./slots.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Genera slots ISO cada hora de 09:00 a 18:00 (10/día) en UTC para `days`. */
function hourlySlotsUtc(days: string[]): string[] {
  const out: string[] = [];
  for (const day of days) {
    for (let h = 9; h <= 18; h++) {
      out.push(`${day}T${String(h).padStart(2, "0")}:00:00Z`);
    }
  }
  return out;
}

function isoDay(day: string): string[] {
  return Array.from(
    { length: 10 },
    (_, i) => `${day}T${String(i + 9).padStart(2, "0")}:00:00+00:00`,
  );
}

test("caso real de producción: un día no pierde horarios del medio del rango", () => {
  const days = [
    "2026-09-14",
    "2026-09-15",
    "2026-09-16",
    "2026-09-17",
    "2026-09-18",
    "2026-09-19",
  ];
  const slots = hourlySlotsUtc(days);
  assert.ok(slots.length > 20, `esperaba >20 slots, hay ${slots.length}`);

  const { days: grouped } = groupByDay(slots, "UTC");

  assert.ok(grouped["2026-09-17"].includes("2026-09-17T12:00:00+00:00"));
  assert.ok(grouped["2026-09-17"].includes("2026-09-17T13:00:00+00:00"));
  assert.ok(grouped["2026-09-17"].includes("2026-09-17T15:00:00+00:00"));
});

test("el valor es un ISO completo, no una etiqueta HH:MM", () => {
  // El modelo copia este string literal a schedule_highlevel; si guardáramos
  // "12:00" tendría que reconstruir el instante haciendo aritmética de fechas.
  const { days } = groupByDay(
    ["2026-09-17T12:00:00-03:00"],
    "America/Santiago",
  );

  assert.deepEqual(days["2026-09-17"], ["2026-09-17T12:00:00-03:00"]);
});

test("cada slot se reescribe con el offset de tz, no con el que mandó el proveedor", () => {
  // schedule/cancel/reschedule validan el offset contra la zona de agenda: un
  // slot con el offset de otra zona se rechazaría allá.
  const { days } = groupByDay(
    ["2026-09-17T15:00:00Z", "2026-09-17T11:00:00-05:00"],
    "America/Cancun",
  );

  assert.deepEqual(days["2026-09-17"], [
    "2026-09-17T10:00:00-05:00",
    "2026-09-17T11:00:00-05:00",
  ]);
});

test("el mismo instante escrito con dos offsets es un solo horario", () => {
  const { days } = groupByDay(
    ["2026-09-17T15:00:00Z", "2026-09-17T10:00:00-05:00"],
    "America/Cancun",
  );

  assert.deepEqual(days["2026-09-17"], ["2026-09-17T10:00:00-05:00"]);
});

test("un día presente aparece completo aunque el total supere cualquier tope", () => {
  const days = ["2026-09-14", "2026-09-15", "2026-09-16"];
  const slots = hourlySlotsUtc(days);

  const { days: grouped } = groupByDay(slots, "UTC");

  for (const day of days) {
    assert.deepEqual(grouped[day], isoDay(day), `día ${day} incompleto`);
  }
});

test("maxDays recorta días enteros, no horarios sueltos, y cuenta omittedDays", () => {
  const days = [
    "2026-09-14",
    "2026-09-15",
    "2026-09-16",
    "2026-09-17",
    "2026-09-18",
  ];
  const slots = hourlySlotsUtc(days);

  const { days: grouped, omittedDays } = groupByDay(slots, "UTC", 3);

  assert.equal(omittedDays, 2);
  assert.deepEqual(Object.keys(grouped), [
    "2026-09-14",
    "2026-09-15",
    "2026-09-16",
  ]);
  // los días que quedan siguen completos, 10 horarios cada uno
  for (const day of Object.keys(grouped)) {
    assert.equal(grouped[day].length, 10, `día ${day} incompleto`);
  }
});

test("agrupa por el día LOCAL en tz, no por el día UTC", () => {
  // 2026-06-13T02:00:00Z en Santiago (UTC-4 en invierno) es 2026-06-12 22:00 local.
  const { days } = groupByDay(["2026-06-13T02:00:00Z"], "America/Santiago");

  assert.deepEqual(Object.keys(days), ["2026-06-12"]);
  assert.deepEqual(days["2026-06-12"], ["2026-06-12T22:00:00-04:00"]);
});

test("el retroceso de horario no colapsa dos cupos distintos en uno", () => {
  // En Chile, el 5 de abril de 2026 se atrasa el reloj: 02:30Z y 03:30Z son
  // las dos "23:30" del 4 de abril local. Son dos cupos reales distintos.
  const { days } = groupByDay(
    ["2026-04-05T02:30:00Z", "2026-04-05T03:30:00Z"],
    "America/Santiago",
  );

  assert.deepEqual(days["2026-04-04"], [
    "2026-04-04T23:30:00-03:00",
    "2026-04-04T23:30:00-04:00",
  ]);
});

test("un timestamp sin offset no se adivina con la zona del servidor", () => {
  // "2026-09-14T12:00:00" es 09:00Z con TZ=UTC y 12:00Z con TZ=America/Santiago:
  // el día local dependería de dónde corre el servidor. Se declara ilegible.
  const { days, unreadable } = groupByDay(["2026-09-14T12:00:00"], "UTC");

  assert.deepEqual(days, {});
  assert.equal(unreadable, 1);
});

test("un valor no parseable se cuenta como ilegible, no se descarta en silencio", () => {
  const { days, unreadable } = groupByDay(
    ["2026-06-12T15:00:00Z", "mañana a las 3", null, 42],
    "UTC",
  );

  assert.deepEqual(days, { "2026-06-12": ["2026-06-12T15:00:00+00:00"] });
  assert.equal(unreadable, 3);
});

test("acepta el formato de objeto de Cal.com ({ start }) además de strings", () => {
  const { days, unreadable } = groupByDay(
    [{ start: "2026-06-12T15:00:00Z" }, "2026-06-12T16:00:00Z"],
    "UTC",
  );

  assert.equal(unreadable, 0);
  assert.deepEqual(days["2026-06-12"], [
    "2026-06-12T15:00:00+00:00",
    "2026-06-12T16:00:00+00:00",
  ]);
});

test("un objeto sin `start` sigue contándose como ilegible", () => {
  const { days, unreadable } = groupByDay(
    [{ time: "2026-06-12T15:00:00Z" }, "2026-06-12T16:00:00Z"],
    "UTC",
  );

  assert.equal(unreadable, 1);
  assert.deepEqual(days["2026-06-12"], ["2026-06-12T16:00:00+00:00"]);
});

test("ordena los días y las horas, y deduplica", () => {
  const { days } = groupByDay(
    [
      "2026-06-13T15:00:00Z",
      "2026-06-12T16:00:00Z",
      "2026-06-12T15:00:00Z",
      "2026-06-12T15:00:00Z", // duplicado
    ],
    "UTC",
  );

  assert.deepEqual(Object.keys(days), ["2026-06-12", "2026-06-13"]);
  assert.deepEqual(days["2026-06-12"], [
    "2026-06-12T15:00:00+00:00",
    "2026-06-12T16:00:00+00:00",
  ]);
});

test("zona horaria inválida no lanza, degrada sin reventar", () => {
  assert.doesNotThrow(() => {
    groupByDay(["2026-06-12T15:00:00Z"], "Marte/Olympus");
  });
});

test("resolveTimeZone toma la primera candidata válida", () => {
  assert.equal(
    resolveTimeZone("America/Santiagoo", "America/Bogota"),
    "America/Bogota",
  );
  assert.equal(resolveTimeZone("America/Santiago", "UTC"), "America/Santiago");
});

test("resolveTimeZone cae a la zona por defecto cuando ninguna candidata sirve", () => {
  assert.equal(resolveTimeZone("Chile", "GMT-3", "", undefined), "America/Mexico_City");
  assert.equal(resolveTimeZone(), "America/Mexico_City");
});

test("el output no afirma ausencia de cupos cuando hubo horarios ilegibles", () => {
  const out = buildAvailabilityOutput(
    { days: {}, omittedDays: 0, unreadable: 4, partialDay: null },
    "UTC",
  );

  assert.equal(out.count, 0);
  assert.equal(out.unreadable, 4);
  assert.doesNotMatch(out.message, /No hay horarios disponibles/);
  assert.match(out.message, /4/);
});

test("el output declara ausencia solo cuando no hubo nada ilegible", () => {
  const out = buildAvailabilityOutput(
    { days: {}, omittedDays: 0, unreadable: 0, partialDay: null },
    "UTC",
  );

  assert.equal(out.message, "No hay horarios disponibles en ese rango.");
});

test("el output dice hasta qué día se sabe cuando hay recorte por maxDays", () => {
  const out = buildAvailabilityOutput(
    {
      days: {
        "2026-09-14": ["2026-09-14T15:00:00Z"],
        "2026-09-15": ["2026-09-15T15:00:00Z"],
      },
      omittedDays: 3,
      unreadable: 0,
      partialDay: null,
    },
    "UTC",
  );

  assert.equal(out.count, 2);
  assert.equal(out.covered_until, "2026-09-15");
  assert.equal(out.omitted_days, 3);
  assert.match(out.message, /2026-09-15/);
});

test("el output dice en qué zona están los horarios", () => {
  const out = buildAvailabilityOutput(
    { days: { "2026-06-12": ["2026-06-12T10:00:00-05:00"] }, omittedDays: 0, unreadable: 0, partialDay: null },
    "America/Bogota",
  );

  assert.equal(out.timezone, "America/Bogota");
  assert.match(out.message, /America\/Bogota/);
});

test("zonedDayRange arranca en la medianoche local, no en la UTC", () => {
  // Bogotá es UTC-5 todo el año (sin horario de verano).
  const range = zonedDayRange("2026-06-12", "2026-06-12", "America/Bogota");
  assert.ok(range);
  assert.equal(
    new Date(range.startMs).toISOString(),
    "2026-06-12T05:00:00.000Z",
  );
  assert.equal(range.endMs, range.startMs + DAY_MS - 1);
});

test("zonedDayRange cubre un rango de varios días", () => {
  const range = zonedDayRange("2026-06-12", "2026-06-14", "America/Bogota");
  assert.ok(range);
  assert.equal(range.endMs - range.startMs, 3 * DAY_MS - 1);
});

test("zonedDayRange en Chile invierno corre la ventana 4 horas", () => {
  const range = zonedDayRange("2026-06-12", "2026-06-12", "America/Santiago");
  assert.ok(range);
  assert.equal(
    new Date(range.startMs).toISOString(),
    "2026-06-12T04:00:00.000Z",
  );
});

test("zonedDayRange cae a UTC con una zona inválida", () => {
  const range = zonedDayRange("2026-06-12", "2026-06-12", "Marte/Olympus");
  assert.ok(range);
  assert.equal(
    new Date(range.startMs).toISOString(),
    "2026-06-12T00:00:00.000Z",
  );
});

test("zonedDayRange devuelve null con fechas inválidas", () => {
  assert.equal(zonedDayRange("ayer", "2026-06-12", "UTC"), null);
  assert.equal(zonedDayRange("2026-06-12", "cuando sea", "UTC"), null);
});

test("ordena por instante, no alfabéticamente por el texto del ISO", () => {
  // "10:00:00-05:00" (15:00Z) ordena ANTES que "14:00:00+00:00" (14:00Z) si se
  // comparan como texto, y después si se comparan como instantes.
  const { days } = groupByDay(
    ["2026-06-12T10:00:00-05:00", "2026-06-12T14:00:00+00:00"],
    "UTC",
  );

  assert.deepEqual(days["2026-06-12"], [
    "2026-06-12T14:00:00+00:00",
    "2026-06-12T15:00:00+00:00",
  ]);
});

test("dos slots que solo difieren en los segundos son dos entradas", () => {
  const { days } = groupByDay(
    ["2026-06-12T15:00:00Z", "2026-06-12T15:00:30Z"],
    "UTC",
  );

  assert.equal(days["2026-06-12"].length, 2);
});

test("con horarios válidos e ilegibles el mensaje declara los ilegibles", () => {
  const out = buildAvailabilityOutput(
    {
      days: { "2026-06-12": ["2026-06-12T15:00:00Z"] },
      omittedDays: 0,
      unreadable: 2,
      partialDay: null,
    },
    "UTC",
  );

  assert.equal(out.count, 1);
  assert.match(out.message, /2/);
  assert.match(out.message, /ilegible/i);
});

test("zonedDayRange cubre el día de 25 horas del cambio de hora chileno", () => {
  // El 4 de abril de 2026 en Chile el reloj se atrasa a las 24:00 locales: ese
  // día dura 25 horas. Sumar 24 h dejaba fuera la segunda vuelta de las 23:30,
  // y el bot negaba un cupo que existía.
  const range = zonedDayRange("2026-04-04", "2026-04-04", "America/Santiago");
  assert.ok(range);
  assert.equal(
    new Date(range.startMs).toISOString(),
    "2026-04-04T03:00:00.000Z",
  );
  assert.equal(
    new Date(range.endMs).toISOString(),
    "2026-04-05T03:59:59.999Z",
  );
});

test("zonedDayRange arranca en la medianoche del régimen horario correcto", () => {
  // La medianoche del 5 de abril ya es UTC-4; medir el offset en la medianoche
  // UTC daba UTC-3 y corría la ventana una hora.
  const range = zonedDayRange("2026-04-05", "2026-04-05", "America/Santiago");
  assert.ok(range);
  assert.equal(
    new Date(range.startMs).toISOString(),
    "2026-04-05T04:00:00.000Z",
  );
});

test("zonedDayRange: el día del salto de primavera empieza en el primer instante que existe", () => {
  // Chile 2026: el horario de verano empieza el domingo 2026-09-06. A las 00:00
  // el reloj salta a la 01:00, así que la medianoche del 6 NO existe.
  const r = zonedDayRange("2026-09-06", "2026-09-06", "America/Santiago");
  assert.ok(r);
  // 04:00Z = 01:00 local del día 6. 03:00Z sería 23:00 del día 5: otro día.
  assert.equal(new Date(r!.startMs).toISOString(), "2026-09-06T04:00:00.000Z");
  assert.equal(
    new Date(r!.startMs).toLocaleDateString("en-CA", { timeZone: "America/Santiago" }),
    "2026-09-06",
  );
});

test("zonedDayRange: el día anterior al salto no se mueve", () => {
  const r = zonedDayRange("2026-09-05", "2026-09-05", "America/Santiago");
  assert.ok(r);
  // 2026-09-05 todavía es UTC-4.
  assert.equal(new Date(r!.startMs).toISOString(), "2026-09-05T04:00:00.000Z");
  // El día 5 termina 1 ms antes del primer instante del 6.
  assert.equal(new Date(r!.endMs + 1).toISOString(), "2026-09-06T04:00:00.000Z");
});

test("zonedDayRange: un día normal en horario de verano empieza a las 03:00Z", () => {
  const r = zonedDayRange("2026-09-15", "2026-09-15", "America/Santiago");
  assert.ok(r);
  assert.equal(new Date(r!.startMs).toISOString(), "2026-09-15T03:00:00.000Z");
});

test("maxSlots recorta días enteros; un primer día más grande que el tope se muestra parcial", () => {
  const day = (d: string, n: number) =>
    Array.from({ length: n }, (_, i) =>
      `2026-06-${d}T${String(10 + Math.floor(i / 6)).padStart(2, "0")}:${String((i % 6) * 10).padStart(2, "0")}:00Z`,
    );
  const slots = [...day("12", 8), ...day("13", 8), ...day("14", 8)];
  const { days, omittedDays } = groupByDay(slots, "UTC", 14, 20);
  assert.deepEqual(Object.keys(days), ["2026-06-12", "2026-06-13"]);
  assert.equal(days["2026-06-13"].length, 8, "a kept day is complete");
  assert.equal(omittedDays, 1);

  const big = groupByDay(day("12", 30), "UTC", 14, 20);
  assert.equal(big.days["2026-06-12"].length, 20, "the earliest 20");
  assert.equal(big.partialDay, "2026-06-12");
  assert.match(
    buildAvailabilityOutput(big, "UTC").message,
    /El 2026-06-12 tiene más horarios de los que se muestran/,
  );
});
