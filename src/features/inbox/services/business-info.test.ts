import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildNowContext,
  buildUpcomingDaysTable,
} from "./business-info.ts";

test("advances by calendar days in the target timezone across a DST transition (no skipped/duplicate dates)", () => {
  // America/New_York springs forward on 2026-03-08 at 02:00 local (EST -05:00 -> EDT -04:00).
  // "now" here is 2026-03-07T23:00:00 EST, i.e. 2026-03-08T04:00:00.000Z — chosen so the
  // 7-day window straddles the transition.
  const now = new Date("2026-03-08T04:00:00.000Z");
  const result = buildUpcomingDaysTable("America/New_York", now);

  const expectedDates = [
    "2026-03-07",
    "2026-03-08",
    "2026-03-09",
    "2026-03-10",
    "2026-03-11",
    "2026-03-12",
    "2026-03-13",
  ];

  const dateLines = result
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.split(": ")[1].split(" ")[0]);

  assert.deepEqual(
    dateLines,
    expectedDates,
    "dates must advance exactly one calendar day at a time, with no skip or duplicate across the DST transition",
  );
});

test("gives each day in the table its own correct UTC offset across a DST transition, not 'now's offset (pre-existing bug)", () => {
  // Same transition as the calendar-day-advance test above: America/New_York
  // springs forward 2026-03-08 02:00 local (EST -05:00 -> EDT -04:00).
  const now = new Date("2026-03-08T04:00:00.000Z"); // 2026-03-07T23:00 EST
  const result = buildUpcomingDaysTable("America/New_York", now);

  const lines = result.split("\n").filter((line) => line.startsWith("- "));
  const beforeTransition = lines.find((l) => l.includes("2026-03-07"));
  const afterTransition = lines.find((l) => l.includes("2026-03-10"));

  assert.ok(beforeTransition?.includes("-05:00"), "pre-transition day must show EST offset -05:00");
  assert.ok(afterTransition?.includes("-04:00"), "post-transition day must show EDT offset -04:00");
});

test("includes a 7-day date table in the given timezone for the LLM to copy from", () => {
  const tz = "America/Santiago";
  const result = buildNowContext(tz);

  assert.match(result, /## Próximos 7 días/);
  assert.match(result, /copia la fecha exacta de la tabla/);

  // Independent oracle: anchor "today" via Intl (same technique
  // buildUpcomingDaysTable uses internally), then advance in UTC
  // calendar-day arithmetic — not the fixed-24h-instant formula the
  // pre-fix implementation used, which this test must not resurrect as
  // its own oracle (a test whose oracle matches the bug can never catch it).
  const now = new Date();
  const todayIso = now.toLocaleDateString("en-CA", { timeZone: tz });
  const [year, month, day] = todayIso.split("-").map(Number);
  for (let i = 0; i < 7; i++) {
    const expectedDate = new Date(Date.UTC(year, month - 1, day + i))
      .toISOString()
      .slice(0, 10);
    assert.match(
      result,
      new RegExp(expectedDate.replace(/-/g, "\\-")),
      `expected the table to include ${expectedDate} (today +${i})`,
    );
  }
});

test("defaults to America/Mexico_City when no timezone is given", () => {
  const result = buildNowContext();
  assert.match(result, /zona horaria America\/Mexico_City/);
  assert.match(result, /## Próximos 7 días/);
});

test("includes human-readable current date/time and UTC offset (pre-existing behavior)", () => {
  const tz = "America/Santiago";
  const result = buildNowContext(tz);
  const now = new Date();

  const expectedHuman = now.toLocaleString("es-MX", {
    timeZone: tz,
    dateStyle: "full",
    timeStyle: "short",
  });
  assert.match(result, /## Fecha actual/);
  assert.ok(
    result.includes(`Hoy es ${expectedHuman}`),
    `expected the human-readable date/time line for ${tz}`,
  );

  // Independent oracle for the offset: recomputed here via Intl directly
  // (same technique the private offsetFor() uses internally) rather than
  // calling into production code, so this isn't just re-running the same path.
  const offsetPart =
    new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
      .formatToParts(now)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
  const expectedOffset = offsetPart.replace("GMT", "") || "+00:00";

  assert.ok(
    result.includes(`offset ${expectedOffset}`),
    `expected offset ${expectedOffset} in the Fecha actual line`,
  );
  assert.match(result, /Usa esta tabla para resolver referencias como "el martes"/);
  assert.match(
    result,
    /construye las horas en ISO con el offset que aparece junto a esa fecha en la tabla/,
    "expected the instruction to point at each row's own offset, not a single fixed one",
  );
});

test("falls back to the default timezone instead of throwing on an invalid IANA timezone, and logs a warning", () => {
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    const result = buildNowContext("not-a-real-timezone");
    assert.match(result, /zona horaria America\/Mexico_City/);
    assert.match(result, /## Próximos 7 días/);
    assert.equal(warnings.length, 1, "expected exactly one warning");
    assert.match(String(warnings[0][0]), /invalid timezone/);
  } finally {
    console.warn = originalWarn;
  }
});
