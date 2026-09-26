import assert from "node:assert/strict";
import { test } from "node:test";
import { rankKapsoNumbers, type KapsoDiscoveredNumber } from "./kapso-client.ts";

const number = (id: string, kind: string, status: string | null): KapsoDiscoveredNumber => ({
  phone_number_id: id,
  waba_id: "waba",
  display_phone_number: null,
  verified_name: null,
  status,
  kind,
});

test("connected production numbers come before sandbox and pending ones", () => {
  const ranked = rankKapsoNumbers([
    number("sandbox", "sandbox", null),
    number("pending", "production", "PENDING"),
    number("live", "production", "CONNECTED"),
  ]);
  assert.deepEqual(ranked.map((n) => n.phone_number_id), ["live", "sandbox", "pending"]);
});
