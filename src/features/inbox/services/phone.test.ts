import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizePhone, phoneKey, samePhone } from "./phone.ts";

test("normalizePhone writes E.164 and uses the workspace code for local numbers", () => {
  assert.equal(normalizePhone("+52 998 123 4567"), "+529981234567");
  assert.equal(normalizePhone("(998) 123-4567", "52"), "+529981234567");
  assert.equal(normalizePhone("998.123.4567", "57"), "+579981234567");
  assert.equal(normalizePhone("5215512345678"), "+5215512345678");
});

test("Mexico: +52 1 and +52 are the same mobile, in both directions", () => {
  assert.ok(samePhone("+5215512345678", "+525512345678"));
  assert.ok(samePhone("+52 55 1234 5678", "+52 1 55 1234 5678"));
  assert.ok(samePhone("5512345678", "+5215512345678", "52"), "a local number with the workspace code");
  assert.equal(phoneKey("+5215512345678"), "525512345678");
});

test("Argentina: +54 9 and +54 are the same mobile", () => {
  assert.ok(samePhone("+5491123456789", "+541123456789"));
});

test("different numbers stay different", () => {
  assert.ok(!samePhone("+525512345678", "+525512345679"));
  // A 13-digit number from another country keeps its digits.
  assert.equal(phoneKey("+4412345678901"), "4412345678901");
  assert.ok(!samePhone("+15550001111", "+525550001111"));
});
