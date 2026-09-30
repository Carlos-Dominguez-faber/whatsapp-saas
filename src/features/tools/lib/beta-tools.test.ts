import assert from "node:assert/strict";
import { test } from "node:test";
import { BETA_TOOLS } from "./beta-tools.ts";
import { registry } from "../index.ts";

test("the appointment tools are the beta ones, and each is a registered tool", () => {
  assert.deepEqual(
    [...BETA_TOOLS.keys()].sort(),
    [
      "cancel_calcom",
      "cancel_highlevel",
      "check_availability_calcom",
      "list_calcom_appointments",
      "list_event_types_calcom",
      "list_highlevel_appointments",
      "reschedule_calcom",
      "reschedule_highlevel",
      "schedule_calcom",
    ],
  );
  for (const name of BETA_TOOLS.keys()) assert.ok(registry.get(name), name);
  assert.match(BETA_TOOLS.get("cancel_highlevel")!, /sub-cuenta de HighLevel/);
  assert.match(BETA_TOOLS.get("schedule_calcom")!, /Cal\.com de prueba/);
});
