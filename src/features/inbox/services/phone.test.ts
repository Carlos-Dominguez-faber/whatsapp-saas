import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkDestination,
  internationalDigits,
  matchesOwnNumber,
  normalizePhone,
  phoneKey,
  phoneString,
  phoneVariants,
  phoneWithCountryCode,
  samePhone,
} from "./phone.ts";

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

test("00 is the international prefix", () => {
  assert.equal(normalizePhone("0052 998 123 4567"), "+529981234567");
  assert.equal(normalizePhone("00 1 555 123 4567", "52"), "+15551234567");
});

test("a number carries its country code with +, 00 or 11+ digits; national formats don't", () => {
  assert.equal(internationalDigits("+52 998 123 4567"), "529981234567");
  assert.equal(internationalDigits("0052 998 123 4567"), "529981234567");
  assert.equal(internationalDigits("5219981234567"), "5219981234567");
  assert.equal(internationalDigits("998 123 4567"), null);
  assert.equal(internationalDigits("(998) 123-4567"), null);
  assert.equal(internationalDigits("555-123-4567"), null, "US without the 1");
  assert.equal(internationalDigits("0998 123 4567"), null, "a trunk 0 is national");
  assert.equal(internationalDigits("+52"), null);
  assert.equal(internationalDigits("hola"), null);
});

test("config values that aren't strings never throw", () => {
  assert.equal(phoneString(529981234567), "529981234567");
  assert.equal(phoneString("  "), null);
  assert.equal(phoneString({ phone: "+52" }), null);
  assert.equal(phoneString(null), null);
  assert.equal(checkDestination(529981234567, "+5219981234567"), "match", "a number saved as a JSON number");
});

test("the destination check is enforced only for a number with its country code", () => {
  assert.equal(checkDestination("+52 998 123 4567", "+5219981234567"), "match");
  assert.equal(checkDestination("0052 998 123 4567", "+529981234567"), "match");
  assert.equal(checkDestination("+52 998 123 4567", "+529980000000"), "mismatch");
  // National formats: a guessed country code could reject every message.
  for (const configured of ["998 123 4567", "(998) 123-4567", "555-123-4567"]) {
    assert.equal(checkDestination(configured, "+15551234567"), "unenforced", configured);
  }
  assert.equal(checkDestination("", "+529981234567"), "unconfigured");
  assert.equal(checkDestination(undefined, "+529981234567"), "unconfigured");
  assert.equal(checkDestination({}, "+529981234567"), "unconfigured");
  assert.equal(checkDestination("+529981234567", undefined), "unenforced");
});

test("a typed number matches the account's own line, with or without its country code", () => {
  assert.ok(matchesOwnNumber("+52 998 123 4567", "+5219981234567"));
  assert.ok(matchesOwnNumber("998 123 4567", "+529981234567"));
  assert.ok(matchesOwnNumber("(998) 123-4567", "+5219981234567"));
  assert.ok(matchesOwnNumber("555-123-4567", "+15551234567"), "US without the 1");
  assert.ok(matchesOwnNumber("0052 998 123 4567", "+529981234567"));
  assert.ok(!matchesOwnNumber("998 123 4567", "+529980000000"));
  assert.ok(!matchesOwnNumber("4567", "+529981234567"), "too short to tell");
});

test("phoneVariants finds a Mexican mobile stored either way", () => {
  assert.deepEqual(phoneVariants("5512345678", "52").sort(), ["+525512345678", "+5215512345678"].sort());
  assert.ok(phoneVariants("+5215512345678").includes("+525512345678"));
  assert.deepEqual(phoneVariants("+15550001111"), ["+15550001111"]);
});

test("a HighLevel number takes the workspace's code only when it fits that country's format", () => {
  assert.equal(phoneWithCountryCode("998 123 4567", "52"), "+529981234567");
  assert.equal(phoneWithCountryCode("+1 555 123 4567", "52"), "+15551234567", "its own code wins");
  assert.equal(phoneWithCountryCode("0052 998 123 4567", "57"), "+529981234567");
  assert.equal(phoneWithCountryCode("011 2345 6789", "54"), "+541123456789", "after the trunk 0");
  assert.equal(phoneWithCountryCode("612 345 678", "34"), "+34612345678");
  assert.equal(phoneWithCountryCode("1234567", "52"), null, "too short for Mexico");
  assert.equal(phoneWithCountryCode("612 345 678", "52"), null, "a Spanish length in a Mexican workspace");
  assert.equal(phoneWithCountryCode("998 123 4567", "49"), null, "no known format");
  assert.equal(phoneWithCountryCode("ext. 12", "52"), null);
});

test("HighLevel numbers of 11-12 digits written the national way are read as national, not junk", () => {
  // Argentina: area + 15 + number, the mobile 9, the trunk 0.
  assert.equal(phoneWithCountryCode("11 15 2345 6789", "54"), "+541123456789");
  assert.equal(phoneWithCountryCode("011 15 2345 6789", "54"), "+541123456789");
  assert.equal(phoneWithCountryCode("221 15 234 5678", "54"), "+542212345678");
  assert.equal(phoneWithCountryCode("9 11 2345 6789", "54"), "+541123456789");
  // Mexico: the mobile 1, the old 044/045 prefixes, 01.
  assert.equal(phoneWithCountryCode("1 998 123 4567", "52"), "+529981234567");
  assert.equal(phoneWithCountryCode("044 998 123 4567", "52"), "+529981234567");
  assert.equal(phoneWithCountryCode("045 998 123 4567", "52"), "+529981234567");
  assert.equal(phoneWithCountryCode("01 998 123 4567", "52"), "+529981234567");
  // Brazil: an 11-digit mobile.
  assert.equal(phoneWithCountryCode("11 91234 5678", "55"), "+5511912345678");
  // The US: the trunk 1.
  assert.equal(phoneWithCountryCode("1 555 123 4567", "1"), "+15551234567");
});

test("bare digits count as international only with the workspace's own country code", () => {
  assert.equal(phoneWithCountryCode("5219981234567", "52"), "+5219981234567");
  assert.equal(phoneWithCountryCode("529981234567", "52"), "+529981234567");
  assert.equal(phoneWithCountryCode("5491123456789", "54"), "+5491123456789");
  // Another country's digits, or a number plus extension digits: unmatched.
  assert.equal(phoneWithCountryCode("447911123456", "52"), null);
  assert.equal(phoneWithCountryCode("998 123 4567 ext 12", "52"), null);
  assert.equal(phoneWithCountryCode("998 123 4567 x 123", "52"), null);
});
