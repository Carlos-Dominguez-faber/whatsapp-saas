import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveCalendarId } from "./calendar-id.ts";

test("workspace calendar wins over the model's value", () => {
  assert.equal(resolveCalendarId("cal_real", "default"), "cal_real");
});

test("empty string from the model does not override a configured calendar", () => {
  assert.equal(resolveCalendarId("cal_real", ""), "cal_real");
});

test("falls back to the model's value when the workspace has none configured", () => {
  assert.equal(resolveCalendarId(null, "cal_from_model"), "cal_from_model");
  assert.equal(resolveCalendarId(undefined, "cal_from_model"), "cal_from_model");
});

test("returns undefined when neither side has a calendar", () => {
  assert.equal(resolveCalendarId(null, undefined), undefined);
  assert.equal(resolveCalendarId("", ""), undefined);
});
