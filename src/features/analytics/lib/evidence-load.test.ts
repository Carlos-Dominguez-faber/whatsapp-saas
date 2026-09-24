import assert from "node:assert/strict";
import { test } from "node:test";
import { EVIDENCE_TRANSPORT_ERROR, settleEvidence } from "./evidence-load.ts";

test("un rechazo de la Server Action se vuelve el error natural, sin detalle técnico", async () => {
  const r = await settleEvidence(Promise.reject(new TypeError("Failed to fetch")));
  assert.deepEqual(r, { error: EVIDENCE_TRANSPORT_ERROR });
  assert.doesNotMatch(EVIDENCE_TRANSPORT_ERROR, /fetch|Error|undefined/);
  // Un rechazo con cualquier valor (no solo Error) tampoco se escapa.
  assert.deepEqual(await settleEvidence(Promise.reject("x")), { error: EVIDENCE_TRANSPORT_ERROR });
});

test("una respuesta normal o un { error } del servidor pasan sin tocar", async () => {
  const ok = { data: [], hasMore: false };
  assert.equal(await settleEvidence(Promise.resolve(ok)), ok);
  assert.deepEqual(await settleEvidence(Promise.resolve({ error: "No tienes acceso." })), { error: "No tienes acceso." });
});

test("el diálogo pasa cada carga por settleEvidence (sin eso vuelve a quedar cargando)", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../components/evidence-dialog.tsx", import.meta.url), "utf8");
  assert.match(src, /settleEvidence\(\s*getEvidenceAction\(/);
  assert.doesNotMatch(src, /console\.(error|log)/);
});
