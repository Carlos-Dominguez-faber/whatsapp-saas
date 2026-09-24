import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyTopicsMessage,
  evidenceCellLabel,
  formatPct,
  partialCoverageMessage,
  pct,
  toInsightsView,
  type RawInsights,
} from "./insights-view.ts";

const TZ = "America/Santiago";
const NOW = new Date("2026-09-15T15:00:00Z"); // inicio de hoy en Santiago: 2026-09-15T03:00Z

function raw(over: Partial<RawInsights> = {}): RawInsights {
  return {
    base: { conversations: 200, booked: 62, handed_off: 20, tags: { vip: 40 } },
    prev_conversations: 160,
    prev_booked: 40,        // 25% del universo anterior
    prev_handed_off: 24,    // 15% del universo anterior
    topics: [
      { id: "t-price", name: "Precios", conversations: 50, prev_conversations: 16, booked: 6, handed_off: 10, tags: { vip: 25 } },
      { id: "t-park", name: "Estacionamiento", conversations: 30, prev_conversations: 30, booked: 15, handed_off: 0, tags: { vip: 15 } },
    ],
    trend: [
      { topic_id: "t-price", week: "2026-08-31", conversations: "20" },
      { topic_id: "t-price", week: "2026-09-07", conversations: 30 },
      { topic_id: "t-park", week: "2026-09-07", conversations: 30 },
    ],
    partial_conversations: 0,
    oldest_pending: null,
    ...over,
  };
}

test("conversaciones analizadas parcialmente llegan a la vista y al aviso", () => {
  assert.equal(toInsightsView(raw({ partial_conversations: "3" }), TZ, NOW).partialConversations, 3);
  assert.equal(toInsightsView(raw(), TZ, NOW).partialConversations, 0);
  // Payload sin la clave o con basura: sin aviso, no "NaN conversaciones".
  const { partial_conversations: _omit, ...missing } = raw();
  void _omit;
  assert.equal(toInsightsView(missing as RawInsights, TZ, NOW).partialConversations, 0);
  assert.equal(toInsightsView(raw({ partial_conversations: "x" }), TZ, NOW).partialConversations, 0);
  assert.equal(partialCoverageMessage(0), null);
  assert.equal(partialCoverageMessage(-1), null);
  assert.equal(partialCoverageMessage(Number.NaN), null);
  assert.equal(partialCoverageMessage(1), "1 conversación se analizó parcialmente por su largo.");
  assert.equal(partialCoverageMessage(1200), "1.200 conversaciones se analizaron parcialmente por su largo.");
});

test("pct: calcula porcentaje o null si denominador es 0", () => {
  assert.equal(pct(31, 100), 31);
  assert.equal(pct(62, 200), 31);
  assert.equal(pct(0, 200), 0);
  assert.equal(pct(100, 0), null);
});

test("pct: numerador NaN (clave ausente en el payload) no filtra como NaN%, se trata como dato faltante", () => {
  assert.equal(pct(Number(undefined), 5), null);
  assert.equal(formatPct(pct(Number(undefined), 5)), "—");
});

test("formatPct: formatea como texto localizado o dash", () => {
  assert.equal(formatPct(31.5), "31,5%");
  assert.equal(formatPct(0), "0%");
  assert.equal(formatPct(null), "—");
});

test("evidenceCellLabel: nombra tema y columna para el lector de pantalla", () => {
  assert.equal(evidenceCellLabel("Precios", "Agendaron"), "Ver conversaciones de Precios — Agendaron");
});

test("emptyTopicsMessage: solo quien puede gestionar recibe una instrucción accionable", () => {
  assert.equal(emptyTopicsMessage(true), "Aún no hay temas: crea el primero para empezar a medir.");
  assert.equal(emptyTopicsMessage(false), "Aún no hay temas. Pídele a un manager que cree el primero.");
});

test("resumen: universo, variación y porcentajes de la base", () => {
  const v = toInsightsView(raw(), TZ, NOW);
  assert.equal(v.universe, 200);
  assert.equal(v.universePrev, 160);
  assert.equal(v.universeChangePct, 25);
  assert.equal(v.bookedPct, 31);
  assert.equal(v.handedOffPct, 10);
  assert.deepEqual(v.tagPcts, { vip: 20 });
  // Las tres tarjetas traen variación. 31% vs 25% = +6 pts; 10% vs 15% = −5 pts.
  assert.equal(v.bookedDeltaPts, 6);
  assert.equal(v.handedOffDeltaPts, -5);
});

test("temas: bigint como texto se normaliza, orden por conversaciones y cruce por tema", () => {
  const v = toInsightsView(raw(), TZ, NOW);
  assert.deepEqual(v.topics.map((t) => t.id), ["t-price", "t-park"]);
  const price = v.topics[0];
  assert.equal(price.conversations, 50);
  assert.equal(price.sharePct, 25);
  assert.equal(price.prevSharePct, 10);
  assert.equal(price.deltaPts, 15);
  assert.equal(price.bookedPct, 12);
  assert.equal(price.handedOffPct, 20);
  assert.deepEqual(price.tagPcts, { vip: 50 });
});

test("tema sin conversaciones: porcentajes de cruce null, share 0", () => {
  const v = toInsightsView(
    raw({ topics: [{ id: "t", name: "Nuevo", conversations: 0, prev_conversations: 0, booked: 0, handed_off: 0, tags: {} }] }),
    TZ,
    NOW,
  );
  assert.equal(v.topics[0].sharePct, 0);
  assert.equal(v.topics[0].bookedPct, null);
  assert.equal(v.topics[0].deltaPts, 0);
});

test("sin período anterior: variaciones null, también las de las tarjetas", () => {
  const v = toInsightsView(raw({ prev_conversations: 0, prev_booked: 0, prev_handed_off: 0 }), TZ, NOW);
  assert.equal(v.universeChangePct, null);
  assert.equal(v.topics[0].prevSharePct, null);
  assert.equal(v.topics[0].deltaPts, null);
  assert.equal(v.bookedDeltaPts, null);
  assert.equal(v.handedOffDeltaPts, null);
});

test("payload con una clave ausente (deriva de forma de get_insights): delta null, nunca NaN%", () => {
  // Simula un payload deformado (clave ausente/renombrada).
  const v = toInsightsView(raw({ prev_booked: undefined, prev_handed_off: undefined }), TZ, NOW);
  assert.equal(v.bookedDeltaPts, null);
  assert.equal(v.handedOffDeltaPts, null);
  assert.equal(formatPct(v.bookedDeltaPts), "—");
});

test("universo vacío: todo null, sin dividir por cero", () => {
  const v = toInsightsView(
    raw({ base: { conversations: 0, booked: 0, handed_off: 0, tags: { vip: 0 } }, topics: [], trend: [] }),
    TZ,
    NOW,
  );
  assert.equal(v.bookedPct, null);
  assert.deepEqual(v.tagPcts, { vip: null });
  assert.deepEqual(v.weeks, []);
});

test("tendencia: semanas ordenadas y matriz por tema", () => {
  const v = toInsightsView(raw(), TZ, NOW);
  assert.deepEqual(v.weeks, ["2026-08-31", "2026-09-07"]);
  assert.equal(v.trend["t-price"]["2026-08-31"], 20);
  assert.equal(v.trend["t-park"]["2026-08-31"], undefined);
});

test("stalePending: pendiente de antes de hoy → true; de hoy → false; sin pendientes → false", () => {
  assert.equal(toInsightsView(raw({ oldest_pending: "2026-09-15T02:59:00Z" }), TZ, NOW).stalePending, true);
  assert.equal(toInsightsView(raw({ oldest_pending: "2026-09-15T03:30:00Z" }), TZ, NOW).stalePending, false);
  assert.equal(toInsightsView(raw({ oldest_pending: null }), TZ, NOW).stalePending, false);
});
