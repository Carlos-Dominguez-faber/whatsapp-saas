import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyTopicsMessage,
  evidenceCellLabel,
  formatPct,
  partialCoverageMessage,
  pct,
  analysisNotice,
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

test("REVIEW H2: a topic's share is over the analysed conversations, and the notice says how many aren't", () => {
  // 10 customers asked about prices yesterday; the run read 4 of them so far.
  const v = toInsightsView(
    raw({
      base: { conversations: 10, booked: 0, handed_off: 0, tags: {} },
      topics: [{ id: "t", name: "Precio", universe: 4, in_coverage: 10, conversations: 4, prev_conversations: null, booked: 0, handed_off: 0, tags: {} }],
      analysis: { conversations: 10, analyzed: 4, pending: 5, failed: 1, too_old: 0 },
    }),
    TZ,
    NOW,
  );
  assert.equal(v.topics[0].sharePct, 100, "4 of the 4 read, not 40 % of the 10");
  assert.equal(v.topics[0].analyzed, 4);
  assert.equal(v.topics[0].inCoverage, 10);
  assert.equal(
    analysisNotice(v.analysis),
    "Se han analizado 4 de 10 conversaciones de este período; los temas se miden solo sobre las analizadas. " +
      "De las demás: 5 se analizarán en las próximas horas; 1 no se pudo analizar (se reintenta si el cliente vuelve a escribir).",
  );
  assert.equal(analysisNotice({ conversations: 3, analyzed: 3, pending: 0, failed: 0, tooOld: 0, blocked: null }), null);
  assert.match(analysisNotice({ conversations: 3, analyzed: 1, pending: 0, failed: 0, tooOld: 2, blocked: null }) ?? "", /2 tienen más de 30 días/);
});

test("a topic covered from mid-range is measured over its own universe, without a delta", () => {
  const view = toInsightsView(
    raw({
      topics: [
        // Covered from 10 Sep (Santiago): 40 customers wrote since, 10 raised it.
        {
          id: "t-new", name: "Nuevo", universe: 40, covered_from: "2026-09-10T03:00:00Z",
          conversations: 10, prev_conversations: null, booked: 2, handed_off: 1, tags: {},
        },
        { id: "t-old", name: "Viejo", universe: 200, covered_from: null, conversations: 50, prev_conversations: 16, booked: 0, handed_off: 0, tags: {} },
      ],
      trend: [{ topic_id: "t-new", week: "2026-09-07", conversations: 10 }],
    }),
    TZ,
    NOW,
  );
  const t = view.topics.find((x) => x.id === "t-new")!;
  assert.equal(t.sharePct, 25, "10 of the 40 covered, not of the range's 200");
  assert.equal(t.prevSharePct, null);
  assert.equal(t.deltaPts, null);
  assert.equal(t.coveredFromLabel, "10 sept");
  assert.equal(t.coveredFromWeek, "2026-09-07", "Thursday 10 Sep is in the week of Monday 7 Sep");
  assert.equal(t.notCovered, false);
  const old = view.topics.find((x) => x.id === "t-old")!;
  assert.equal(old.coveredFromLabel, null);
  assert.equal(old.deltaPts, 15);
});

test("a topic created after the range has no share at all", () => {
  const view = toInsightsView(
    raw({
      topics: [{
        id: "t-today", name: "Hoy", universe: 0, covered_from: "2026-09-15T14:00:00Z",
        conversations: 0, prev_conversations: null, booked: 0, handed_off: 0, tags: {},
      }],
      trend: [],
    }),
    TZ,
    NOW,
  );
  assert.equal(view.topics[0].sharePct, null);
  assert.equal(view.topics[0].notCovered, true);
});

test("REVIEW: every week of the period shows, 0 when nothing was detected, partial ones marked", () => {
  const v = toInsightsView(
    raw({ trend: [{ topic_id: "t-price", week: "2026-08-31", conversations: 3 }] }),
    TZ,
    NOW,
    { fromDate: "2026-08-27", toDate: "2026-09-14", prevFromIso: "2026-08-08T04:00:00Z", },
  );
  // Thu 27 Aug .. Mon 14 Sep: weeks of 24 Aug, 31 Aug, 7 Sep and 14 Sep.
  assert.deepEqual(v.weeks, ["2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14"]);
  assert.deepEqual(v.partialWeeks.sort(), ["2026-08-24", "2026-09-14"]);
  assert.equal(v.trend["t-price"]["2026-09-07"], undefined, "the table shows ?? 0 for a week without detections");
});

test("REVIEW: no change vs. a previous period before the first customer message", () => {
  const period = { fromDate: "2026-09-01", toDate: "2026-09-14", prevFromIso: "2026-08-18T04:00:00Z" };
  const before = toInsightsView(raw({ data_from: "2026-08-25T15:00:00Z" }), TZ, NOW, period);
  assert.equal(before.universeChangePct, null, "the previous period started before any data");
  assert.equal(before.bookedDeltaPts, null);
  assert.equal(before.handedOffDeltaPts, null);
  const after = toInsightsView(raw({ data_from: "2026-07-01T15:00:00Z" }), TZ, NOW, period);
  assert.equal(after.universeChangePct, 25);
});

test("REVIEW LOW 9: the notice says why, and never promises 'the next hours' when something blocks the run", () => {
  const base = { conversations: 10, analyzed: 4, pending: 6, failed: 0, tooOld: 0 };
  const key = analysisNotice({ ...base, blocked: "key" }) ?? "";
  assert.match(key, /6 esperan: la clave de OpenRouter de este espacio está fallando/);
  assert.doesNotMatch(key, /próximas horas/);
  const cap = analysisNotice({ ...base, blocked: "cap" }) ?? "";
  assert.match(cap, /tope de hoy/);
  assert.doesNotMatch(cap, /próximas horas/);
  assert.match(analysisNotice({ ...base, blocked: null }) ?? "", /se analizarán en las próximas horas/);
  // No topic: nothing is being analysed, and the page already says why.
  assert.equal(analysisNotice({ ...base, blocked: null }, false), null);
  // From the payload.
  assert.equal(toInsightsView(raw({ blocked: "cap" }), TZ, NOW).analysis.blocked, "cap");
  assert.equal(toInsightsView(raw({ blocked: "platform_key" }), TZ, NOW).analysis.blocked, "platform_key");
  assert.equal(toInsightsView(raw({ blocked: "workspace" }), TZ, NOW).analysis.blocked, "workspace");
  assert.match(analysisNotice({ ...base, blocked: "workspace" }) ?? "", /este espacio está fallando/);
  const platform = analysisNotice({ ...base, blocked: "platform_key" }) ?? "";
  assert.match(platform, /no está respondiendo/);
  assert.doesNotMatch(platform, /próximas horas/);
  assert.equal(toInsightsView(raw({ blocked: "whatever" as never }), TZ, NOW).analysis.blocked, null);
});
