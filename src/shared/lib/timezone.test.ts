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
