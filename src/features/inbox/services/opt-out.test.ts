import assert from "node:assert/strict";
import { test } from "node:test";

import { manualOptInFields, optOutIntent } from "./opt-out.ts";

test("the opt-out keywords count as a whole message, any case, accents or punctuation", () => {
  for (const text of ["STOP", "Baja", "baja.", " ALTO! ", "Darme de baja", "No más mensajes", "unsubscribe"]) {
    assert.equal(optOutIntent(text), "stop", text);
  }
});

test("the opt-in keywords bring the contact back", () => {
  for (const text of ["START", "alta", "Suscribirme", "unstop"]) {
    assert.equal(optOutIntent(text), "start", text);
  }
});

test("a sentence that merely contains a keyword is a question for the agent", () => {
  for (const text of [
    "me quiero dar de baja del gimnasio, ¿cómo le hago?",
    "alto ahí, tengo una duda",
    "stop motion",
    "hola",
    "",
    null,
    undefined,
  ]) {
    assert.equal(optOutIntent(text), null, String(text));
  }
});

test("a manual opt-out is explicit; a manual opt-in clears it; no change writes nothing", () => {
  const out = manualOptInFields(false);
  assert.equal(out.opt_in, false);
  assert.equal(typeof out.opted_out_at, "string");

  const back = manualOptInFields(true);
  assert.equal(back.opt_in, true);
  assert.equal(back.opted_out_at, null);
  assert.equal(typeof back.opt_in_at, "string");

  assert.deepEqual(manualOptInFields(undefined), {});
});
