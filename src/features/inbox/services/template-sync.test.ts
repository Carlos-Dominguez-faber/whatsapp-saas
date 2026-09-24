/**
 * Corre con `npm run test:unit` (node --test, sin framework).
 * Cubre el mapeo puro del sync de plantillas: motivo de rechazo y approved_at.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  extractRejectionReason,
  templateStatusPatch,
} from "./template-sync.ts";

const NOW = "2026-08-11T12:00:00.000Z";
const BEFORE = "2026-01-01T00:00:00.000Z";

// ── extractRejectionReason ───────────────────────────────────────────────────

test("extractRejectionReason: devuelve el motivo real de Meta", () => {
  assert.equal(extractRejectionReason("INCORRECT_CATEGORY"), "INCORRECT_CATEGORY");
  assert.equal(extractRejectionReason("  INVALID_FORMAT  "), "INVALID_FORMAT");
});

test("extractRejectionReason: 'NONE' y vacíos colapsan a null", () => {
  for (const raw of ["NONE", "none", "", "   ", "null", "undefined"]) {
    assert.equal(extractRejectionReason(raw), null, `falló con ${JSON.stringify(raw)}`);
  }
});

test("extractRejectionReason: entrada no-string no revienta", () => {
  for (const raw of [undefined, null, 42, {}, [], true]) {
    assert.equal(extractRejectionReason(raw), null);
  }
});

// ── templateStatusPatch ──────────────────────────────────────────────────────

test("rechazada: persiste el motivo que devolvió Meta", () => {
  const patch = templateStatusPatch("rejected", "ABUSIVE_CONTENT", undefined, NOW);
  assert.equal(patch.rejection_reason, "ABUSIVE_CONTENT");
  assert.equal(patch.approved_at, undefined);
});

test("rechazada sin motivo remoto: NO borra el motivo ya guardado (el bug)", () => {
  const patch = templateStatusPatch(
    "rejected",
    null,
    { rejection_reason: "INVALID_FORMAT", approved_at: null },
    NOW,
  );
  assert.equal(patch.rejection_reason, "INVALID_FORMAT");
});

test("rechazada sin motivo remoto ni guardado: null", () => {
  assert.equal(templateStatusPatch("rejected", null, undefined, NOW).rejection_reason, null);
});

test("el motivo remoto gana sobre el guardado", () => {
  const patch = templateStatusPatch(
    "rejected",
    "SCAM",
    { rejection_reason: "INVALID_FORMAT", approved_at: null },
    NOW,
  );
  assert.equal(patch.rejection_reason, "SCAM");
});

test("aprobada: limpia el motivo viejo y sella approved_at", () => {
  const patch = templateStatusPatch(
    "approved",
    null,
    { rejection_reason: "INVALID_FORMAT", approved_at: null },
    NOW,
  );
  assert.equal(patch.rejection_reason, null);
  assert.equal(patch.approved_at, NOW);
});

test("aprobada ya sellada: approved_at no se mueve en cada sync", () => {
  const patch = templateStatusPatch(
    "approved",
    null,
    { rejection_reason: null, approved_at: BEFORE },
    NOW,
  );
  assert.equal(patch.approved_at, undefined, "no debe reescribir approved_at");
});

test("pausada/enviada: sin approved_at nuevo y sin motivo", () => {
  for (const status of ["submitted", "paused", "draft"] as const) {
    const patch = templateStatusPatch(status, "SCAM", undefined, NOW);
    assert.equal(patch.rejection_reason, null, status);
    assert.equal(patch.approved_at, undefined, status);
  }
});
