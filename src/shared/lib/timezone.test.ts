import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TIMEZONE, isIanaTimeZone, resolveTimeZone } from "./timezone.ts";

test("IANA names pass; offsets and abbreviations don't", () => {
  for (const ok of ["America/Mexico_City", "America/Argentina/Buenos_Aires", "Etc/GMT+5", "UTC"]) {
    assert.ok(isIanaTimeZone(ok), ok);
  }
  for (const bad of ["-05:00", "GMT-3", "EST", "CST", "Chile", "America/Santiagoo", "", null, 5]) {
    assert.ok(!isIanaTimeZone(bad), String(bad));
  }
});

test("the first valid candidate wins, and the default closes the chain", () => {
  assert.equal(resolveTimeZone("EST", "America/Bogota", "UTC"), "America/Bogota");
  assert.equal(resolveTimeZone(undefined, null, "-05:00"), DEFAULT_TIMEZONE);
});

import { formatWithOffset, wallClockToInstant } from "./timezone.ts";

const wall = (s: string) => {
  const [d, t] = s.split("T");
  const [year, month, day] = d.split("-").map(Number);
  const [hour, minute] = t.split(":").map(Number);
  return { year, month, day, hour, minute, second: 0 };
};

test("a wall-clock time maps to its instant in the zone, across DST", () => {
  // New York: EST (-05:00) in January, EDT (-04:00) in July.
  assert.equal(
    new Date(wallClockToInstant(wall("2026-01-15T10:00"), "America/New_York")!).toISOString(),
    "2026-01-15T15:00:00.000Z",
  );
  assert.equal(
    new Date(wallClockToInstant(wall("2026-07-15T10:00"), "America/New_York")!).toISOString(),
    "2026-07-15T14:00:00.000Z",
  );
});

test("impossible dates and skipped hours have no instant", () => {
  assert.equal(wallClockToInstant(wall("2026-02-30T10:00"), "America/Mexico_City"), null);
  // 2026-03-08 02:30 doesn't exist in New York (02:00 → 03:00).
  assert.equal(wallClockToInstant(wall("2026-03-08T02:30"), "America/New_York"), null);
});

test("the repeated hour when clocks go back gives the earlier instant, east or west of UTC", () => {
  // New York, 2026-11-01: 01:30 happens at 05:30Z (EDT) and again at 06:30Z (EST).
  assert.equal(
    new Date(wallClockToInstant(wall("2026-11-01T01:30"), "America/New_York")!).toISOString(),
    "2026-11-01T05:30:00.000Z",
  );
  // Madrid, 2026-10-25: 02:30 happens at 00:30Z (CEST) and again at 01:30Z (CET).
  assert.equal(
    new Date(wallClockToInstant(wall("2026-10-25T02:30"), "Europe/Madrid")!).toISOString(),
    "2026-10-25T00:30:00.000Z",
  );
});

test("formatWithOffset uses the zone's offset at that instant", () => {
  assert.equal(formatWithOffset(Date.parse("2026-07-15T14:00:00Z"), "America/New_York"), "2026-07-15T10:00:00-04:00");
  assert.equal(formatWithOffset(Date.parse("2026-01-15T15:00:00Z"), "America/New_York"), "2026-01-15T10:00:00-05:00");
  assert.equal(formatWithOffset(Date.parse("2026-01-15T16:00:00Z"), "America/Mexico_City"), "2026-01-15T10:00:00-06:00");
});
