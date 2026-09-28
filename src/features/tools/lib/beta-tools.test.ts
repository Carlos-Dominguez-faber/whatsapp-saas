import assert from "node:assert/strict";
import { test } from "node:test";
import { BETA_NOTE, BETA_TOOLS } from "./beta-tools.ts";
import { registry } from "../index.ts";

test("the appointment tools are the beta ones, and each is a registered tool", () => {
  assert.deepEqual(
    [...BETA_TOOLS].sort(),
    ["cancel_highlevel", "list_highlevel_appointments", "reschedule_highlevel"],
  );
  for (const name of BETA_TOOLS) assert.ok(registry.get(name), name);
  assert.match(BETA_NOTE, /sub-cuenta de HighLevel/);
});
