/**
 * Corre con `npm run test:unit` (node --test, sin framework).
 * Módulo puro: normalización de la categoría en el borde.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { normalizeCategory, buildKapsoPayload } from "./template-form.ts";

// ── camino feliz ─────────────────────────────────────────────────────────────

test("normaliza lo que devuelve Meta (MAYÚSCULAS) a la forma guardada", () => {
  assert.equal(normalizeCategory("UTILITY"), "utility");
  assert.equal(normalizeCategory("MARKETING"), "marketing");
  assert.equal(normalizeCategory("AUTHENTICATION"), "authentication");
});

test("lo que ya viene en minúsculas queda igual", () => {
  assert.equal(normalizeCategory("utility"), "utility");
  assert.equal(normalizeCategory("marketing"), "marketing");
});

test("tolera espacios y mayúsculas mezcladas", () => {
  assert.equal(normalizeCategory("  Authentication  "), "authentication");
  assert.equal(normalizeCategory("UtIlItY"), "utility");
});

// ── caminos de error ─────────────────────────────────────────────────────────

test("entrada no usable devuelve '' para que el llamador ponga el defecto", () => {
  for (const raw of [undefined, null, 42, {}, [], true, "", "   "]) {
    assert.equal(normalizeCategory(raw), "", `falló con ${JSON.stringify(raw)}`);
  }
});

test("una categoría de autenticación NUNCA se confunde con utility", () => {
  // Es el bug que motivó esto: `"AUTHENTICATION" === "authentication"` es false,
  // así que el guard la dejaba pasar y se enviaba a Meta como UTILITY.
  for (const raw of ["AUTHENTICATION", "Authentication", "authentication"]) {
    assert.equal(normalizeCategory(raw), "authentication");
    assert.notEqual(normalizeCategory(raw), "utility");
  }
});

test("buildKapsoPayload sigue mandando la categoría en MAYÚSCULAS a Meta", () => {
  const payload = buildKapsoPayload({
    name: "recordatorio_cita",
    category: "utility",
    header_type: "none",
    header_text: "",
    body_template: "Hola, te recordamos tu cita.",
    body_variables: [],
    footer_text: "",
    buttons: [],
  });
  assert.equal(payload.category, "UTILITY");
});
