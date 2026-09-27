import assert from "node:assert/strict";
import { test } from "node:test";
import { schedulingTimeZone } from "./scheduling-timezone.ts";
import { buildNowContext } from "./business-info.ts";

const info = (timezone?: string) => ({
  structured: timezone === undefined ? {} : { timezone },
  free_text: null,
});

test("the business's zone first, then HighLevel's, then the default", () => {
  assert.equal(schedulingTimeZone(info("Europe/Madrid"), "America/Cancun"), "Europe/Madrid");
  assert.equal(schedulingTimeZone(info(), "America/Cancun"), "America/Cancun");
  assert.equal(schedulingTimeZone(null, "America/Cancun"), "America/Cancun");
  assert.equal(schedulingTimeZone(null, null), "America/Mexico_City");
});

test("an invalid business zone falls through to HighLevel's, not straight to the default", () => {
  assert.equal(schedulingTimeZone(info("not-a-zone"), "America/Cancun"), "America/Cancun");
  assert.equal(schedulingTimeZone(info("-05:00"), undefined), "America/Mexico_City");
});

test("the prompt's 'now' names the same zone the tools use", () => {
  const zone = schedulingTimeZone(info(), "America/Cancun");
  assert.match(buildNowContext(zone), /zona horaria America\/Cancun/);
  assert.doesNotMatch(buildNowContext(zone), /pasa la zona horaria/);
});
