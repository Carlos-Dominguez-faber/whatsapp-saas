import assert from "node:assert/strict";
import { test } from "node:test";

import { manualOptInFields, optOutIntent } from "./opt-out.ts";

test("an explicit opt-out counts as a whole message, any case, accents or punctuation", () => {
  for (const text of [
    "STOP",
    "stop.",
    "Darme de baja",
    "No más mensajes",
    "No quiero recibir mensajes!",
    "unsubscribe",
    "Stop promotions",
    "Detener promociones",
  ]) {
    assert.equal(optOutIntent(text), "stop", text);
  }
});

test("only an explicit phrase brings the contact back", () => {
  for (const text of ["START", "Suscribirme", "reanudar mensajes"]) {
    assert.equal(optOutIntent(text), "start", text);
  }
});

test("one-word answers and list taps are never an opt-out or an opt-in", () => {
  for (const text of ["baja", "Baja", "alta", "ALTA", "alto", "Alto!", "bajo", "no", "listo"]) {
    assert.equal(optOutIntent(text), null, text);
  }
});

test("a sentence that merely contains a phrase is a question for the agent", () => {
  for (const text of [
    "me quiero dar de baja del gimnasio, ¿cómo le hago?",
    "quiero darme de baja del plan",
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
