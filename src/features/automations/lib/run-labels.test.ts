import assert from "node:assert/strict";
import { test } from "node:test";
import { runReasonLabel } from "./run-labels.ts";

test("the Cal.com causes read in Spanish, also once the retries run out", () => {
  assert.equal(runReasonLabel("pending_confirmation"), "la cita espera que el negocio la acepte en Cal.com");
  assert.equal(runReasonLabel("calcom_not_connected"), "Cal.com no está conectado");
  assert.equal(runReasonLabel("calcom_unconfirmable"), "la cita no se puede comprobar en Cal.com");
  assert.equal(
    runReasonLabel("max_attempts:calcom_read_failed"),
    "se agotaron los intentos (no se pudo leer Cal.com)",
  );
});

test("an unknown cause still shows as its code", () => {
  assert.equal(runReasonLabel("max_attempts:send_not_accepted"), "se agotaron los intentos (send_not_accepted)");
  assert.equal(runReasonLabel("hl_read_failed"), "hl_read_failed");
  assert.equal(runReasonLabel("missing_variable:nombre"), "falta el dato nombre");
});
