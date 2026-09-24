import assert from "node:assert/strict";
import { test } from "node:test";
import { EvidenceInputSchema, parseInsightsParams, TopicInputSchema } from "./schemas.ts";

const TZ = "America/Santiago";
// 2026-09-15 15:00 UTC = 12:00 en Santiago (UTC-3 desde el 6 de septiembre).
const NOW = new Date("2026-09-15T15:00:00Z");

test("sin parámetros usa los últimos 30 días TERMINANDO AYER en la zona del workspace", () => {
  // El dashboard muestra hasta el cierre del día anterior. Incluir hoy
  // metería en el denominador conversaciones todavía sin clasificar y partiría
  // todos los porcentajes al medio.
  const r = parseInsightsParams({}, TZ, NOW);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.preset, "30");
  assert.equal(r.value.fromDate, "2026-08-16");
  assert.equal(r.value.toDate, "2026-09-14");
  // Exclusivo: el inicio de hoy en Santiago.
  assert.equal(r.value.toIso, "2026-09-15T03:00:00.000Z");
  assert.deepEqual(r.value.tags, []);
});

test("preset 7 cubre 7 días calendario terminando ayer", () => {
  const r = parseInsightsParams({ range: "7" }, TZ, NOW);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.value.fromDate, "2026-09-08");
  assert.equal(r.value.toDate, "2026-09-14");
  assert.equal(r.value.fromIso, "2026-09-08T03:00:00.000Z");
});

test("un rango explícito que llega hasta hoy se recorta a ayer", () => {
  const r = parseInsightsParams({ from: "2026-09-01", to: "2026-09-15" }, TZ, NOW);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.value.toDate, "2026-09-14");
  assert.equal(r.value.toIso, "2026-09-15T03:00:00.000Z");
});

test("un rango que empieza hoy no tiene días válidos → error", () => {
  const r = parseInsightsParams({ from: "2026-09-15", to: "2026-09-20" }, TZ, NOW);
  assert.deepEqual(r, { ok: false, error: "El análisis llega hasta ayer; elige un rango que termine antes de hoy." });
});

test("preset desconocido cae en 30", () => {
  const r = parseInsightsParams({ range: "15" }, TZ, NOW);
  assert.ok(r.ok && r.value.preset === "30");
});

test("rango explícito válido, con from y to en la zona", () => {
  const r = parseInsightsParams({ from: "2026-09-01", to: "2026-09-07" }, TZ, NOW);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.value.preset, null);
  // 1 de septiembre todavía es UTC-4 en Chile.
  assert.equal(r.value.fromIso, "2026-09-01T04:00:00.000Z");
  assert.equal(r.value.toIso, "2026-09-08T03:00:00.000Z");
});

test("texto en lugar de fecha → error de validación", () => {
  const r = parseInsightsParams({ from: "ayer", to: "2026-09-07" }, TZ, NOW);
  assert.deepEqual(r, { ok: false, error: "Las fechas del filtro no son válidas." });
});

test("fecha imposible (31 de febrero) → error de validación", () => {
  const r = parseInsightsParams({ from: "2026-02-31", to: "2026-03-05" }, TZ, NOW);
  assert.equal(r.ok, false);
});

test("solo una de las dos fechas → error de validación", () => {
  assert.equal(parseInsightsParams({ from: "2026-09-01" }, TZ, NOW).ok, false);
});

test("from posterior a to → error", () => {
  const r = parseInsightsParams({ from: "2026-09-10", to: "2026-09-01" }, TZ, NOW);
  assert.deepEqual(r, { ok: false, error: "La fecha de inicio debe ser anterior a la de término." });
});

test("rango de 367 días → error; 366 pasa", () => {
  assert.deepEqual(parseInsightsParams({ from: "2025-01-01", to: "2026-01-02" }, TZ, NOW), {
    ok: false,
    error: "El rango puede ser de hasta 366 días.",
  });
  assert.equal(parseInsightsParams({ from: "2025-01-01", to: "2026-01-01" }, TZ, NOW).ok, true);
});

test("etiquetas: parámetros repetidos, recortadas, sin vacías ni repetidas", () => {
  const r = parseInsightsParams({ tags: [" vip ", "frio", "", "vip"] }, TZ, NOW);
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.value.tags, ["vip", "frio"]);
});

test("una etiqueta con coma sobrevive entera", () => {
  // conversation-actions.ts:63 acepta etiquetas con coma. Separar por coma
  // convertía "precio, alto" en dos columnas inexistentes y podía disparar
  // falsamente el tope de 5.
  const r = parseInsightsParams({ tags: ["precio, alto"] }, TZ, NOW);
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.value.tags, ["precio, alto"]);
});

test("una sola etiqueta puede venir como string suelto", () => {
  const r = parseInsightsParams({ tags: "vip" }, TZ, NOW);
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.value.tags, ["vip"]);
});

test("más de 5 etiquetas → error", () => {
  const r = parseInsightsParams({ tags: ["a", "b", "c", "d", "e", "f"] }, TZ, NOW);
  assert.deepEqual(r, { ok: false, error: "Puedes comparar hasta 5 etiquetas a la vez." });
});

test("parámetro repetido en la URL usa el primero", () => {
  const r = parseInsightsParams({ range: ["7", "90"] }, TZ, NOW);
  assert.ok(r.ok && r.value.preset === "7");
});

test("TopicInputSchema: válido recorta espacios", () => {
  const r = TopicInputSchema.safeParse({ name: "  Precio ", description: " Objeción de precio " });
  assert.ok(r.success);
  if (r.success) assert.deepEqual(r.data, { name: "Precio", description: "Objeción de precio" });
});

test("TopicInputSchema: nombre vacío, largo de más y descripción vacía, con mensaje por campo", () => {
  const empty = TopicInputSchema.safeParse({ name: "   ", description: "x" });
  assert.equal(empty.success, false);
  if (!empty.success) assert.equal(empty.error.issues[0].path[0], "name");

  const long = TopicInputSchema.safeParse({ name: "x".repeat(61), description: "x" });
  assert.equal(long.success, false);
  if (!long.success) assert.equal(long.error.issues[0].message, "El nombre puede tener hasta 60 caracteres.");

  const noDesc = TopicInputSchema.safeParse({ name: "Precio", description: "" });
  assert.equal(noDesc.success, false);
  if (!noDesc.success) assert.equal(noDesc.error.issues[0].path[0], "description");

  const wrongType = TopicInputSchema.safeParse({ name: 42, description: "x" });
  assert.equal(wrongType.success, false);
});

const validEvidence = {
  topicId: "0b8f7a52-3c1d-4e2f-9a6b-1c2d3e4f5a6b",
  outcome: "all",
  page: 0,
  fromIso: "2026-09-01T04:00:00.000Z",
  toIso: "2026-09-08T03:00:00.000Z",
};

test("EvidenceInputSchema: válido", () => {
  assert.equal(EvidenceInputSchema.safeParse(validEvidence).success, true);
});

test("EvidenceInputSchema: rechaza topicId no uuid, página con letras, outcome tag sin etiqueta, rango invertido y rango largo", () => {
  assert.equal(EvidenceInputSchema.safeParse({ ...validEvidence, topicId: "abc" }).success, false);
  assert.equal(EvidenceInputSchema.safeParse({ ...validEvidence, page: "a" }).success, false);
  assert.equal(EvidenceInputSchema.safeParse({ ...validEvidence, page: -1 }).success, false);
  assert.equal(EvidenceInputSchema.safeParse({ ...validEvidence, outcome: "tag" }).success, false);
  assert.equal(EvidenceInputSchema.safeParse({ ...validEvidence, outcome: "tag", tag: "vip" }).success, true);
  assert.equal(EvidenceInputSchema.safeParse({ ...validEvidence, outcome: "otro" }).success, false);
  assert.equal(
    EvidenceInputSchema.safeParse({ ...validEvidence, fromIso: validEvidence.toIso, toIso: validEvidence.fromIso }).success,
    false,
  );
  assert.equal(
    EvidenceInputSchema.safeParse({ ...validEvidence, fromIso: "2024-01-01T00:00:00.000Z" }).success,
    false,
  );
  assert.equal(EvidenceInputSchema.safeParse({ ...validEvidence, fromIso: "ayer" }).success, false);
});
