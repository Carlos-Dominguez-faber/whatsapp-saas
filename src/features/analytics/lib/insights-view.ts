import { zonedDayRange } from "@/features/tools/lib/slots";

type Num = number | string;

interface RawCounts {
  conversations: Num;
  booked: Num;
  handed_off: Num;
  tags: Record<string, Num>;
}

interface RawTopic extends RawCounts {
  id: string;
  name: string;
  /** null when the previous period wasn't covered for this topic. */
  prev_conversations: Num | null;
  /** Analysed conversations of the previous period (null: not covered). */
  prev_universe?: Num | null;
  /** Analysed conversations whose customer wrote while the topic was covered. */
  universe?: Num;
  /** The same, analysed or not. */
  in_coverage?: Num;
  /** Set only when the topic's coverage starts inside the range. */
  covered_from?: string | null;
}

interface RawTrend {
  topic_id: string;
  week: string;
  conversations: Num;
}

export interface RawInsights {
  base: RawCounts;
  prev_conversations: Num;
  prev_booked: Num;
  prev_handed_off: Num;
  topics: RawTopic[];
  trend: RawTrend[];
  /** Conversaciones del universo con texto que no llegó entero al LLM. */
  partial_conversations: Num;
  /** How many conversations of the period are analysed, and why not the rest. */
  analysis?: {
    conversations: Num;
    analyzed: Num;
    pending: Num;
    failed: Num;
    too_old: Num;
  };
  /** The customer's first message ever in the workspace. */
  data_from?: string | null;
}

export interface AnalysisView {
  conversations: number;
  analyzed: number;
  /** Waiting for the classifier (it reads them within the next hours). */
  pending: number;
  /** Failed three times; set aside until the customer writes again. */
  failed: number;
  /** Older than the classifier's 30 days: never read. */
  tooOld: number;
}

export interface TopicView {
  id: string;
  name: string;
  /**
   * When the topic started being analysed, if that falls inside the range
   * (formatted in the workspace's zone): its numbers only count from then.
   * null = the whole range is covered.
   */
  coveredFromLabel: string | null;
  /** Monday (YYYY-MM-DD) of the week coverage starts; earlier weeks show "—". */
  coveredFromWeek: string | null;
  /** The topic has no coverage at all in the range. */
  notCovered: boolean;
  /** Analysed conversations the share is over, and all of the covered part. */
  analyzed: number;
  inCoverage: number;
  conversations: number;
  sharePct: number | null;
  prevSharePct: number | null;
  deltaPts: number | null;
  bookedPct: number | null;
  handedOffPct: number | null;
  tagPcts: Record<string, number | null>;
}

export interface InsightsView {
  universe: number;
  universePrev: number;
  universeChangePct: number | null;
  bookedPct: number | null;
  handedOffPct: number | null;
  bookedDeltaPts: number | null;
  handedOffDeltaPts: number | null;
  tagPcts: Record<string, number | null>;
  topics: TopicView[];
  /** Every week of the period (Mondays), with or without detections. */
  weeks: string[];
  /** Weeks the period only covers part of. */
  partialWeeks: string[];
  trend: Record<string, Record<string, number>>;
  partialConversations: number;
  analysis: AnalysisView;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function pct(part: number, whole: number): number | null {
  // Un numerador NaN (clave ausente/renombrada en el payload de get_insights)
  // no debe filtrarse como "NaN%": se trata igual que universo 0, dato faltante.
  return Number.isFinite(part) && whole > 0 ? round1((part / whole) * 100) : null;
}

export function formatPct(value: number | null): string {
  return value === null ? "—" : `${value.toLocaleString("es-CL", { maximumFractionDigits: 1 })}%`;
}

/** Nombre accesible de una celda de evidencia clicable de la tabla de cruce. */
export function evidenceCellLabel(topicName: string, columnLabel: string): string {
  return `Ver conversaciones de ${topicName} — ${columnLabel}`;
}

/** Texto del estado vacío de temas: solo quien puede gestionar recibe una instrucción accionable. */
export function emptyTopicsMessage(canManage: boolean): string {
  return canManage
    ? "Aún no hay temas: crea el primero para empezar a medir."
    : "Aún no hay temas. Pídele a un manager que cree el primero.";
}

/**
 * Aviso de cobertura parcial (límite declarado: 60 mensajes y 800
 * caracteres por mensaje). null = no hay nada que avisar.
 */
export function partialCoverageMessage(n: number): string | null {
  if (!(n > 0)) return null;
  return n === 1
    ? "1 conversación se analizó parcialmente por su largo."
    : `${n.toLocaleString("es-CL")} conversaciones se analizaron parcialmente por su largo.`;
}

function tagPcts(tags: Record<string, Num>, whole: number): Record<string, number | null> {
  return Object.fromEntries(Object.entries(tags).map(([tag, n]) => [tag, pct(Number(n), whole)]));
}

function zonedDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** The Monday (YYYY-MM-DD) of the week `iso` falls in, in `tz` — Postgres's date_trunc('week'). */
function zonedWeekStart(iso: string, tz: string): string {
  const day = zonedDate(iso, tz);
  const d = new Date(`${day}T00:00:00Z`);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - sinceMonday * 86_400_000).toISOString().slice(0, 10);
}

function coveredLabel(iso: string, tz: string): string {
  return new Date(iso).toLocaleDateString("es-CL", { timeZone: tz, day: "numeric", month: "short" });
}


/** Diferencia en puntos porcentuales entre dos porcentajes; null si falta uno. */
function deltaPts(current: number | null, previous: number | null): number | null {
  return current !== null && previous !== null ? round1(current - previous) : null;
}

const DAY_MS = 86_400_000;

/** Monday (YYYY-MM-DD) of the week a YYYY-MM-DD day falls in. */
function mondayOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
}

/** The period's weeks, and which of them it covers only in part. */
function periodWeeks(fromDate: string, toDate: string): { weeks: string[]; partial: string[] } {
  const weeks: string[] = [];
  const last = mondayOf(toDate);
  for (let w = mondayOf(fromDate); w <= last; w = new Date(Date.parse(`${w}T00:00:00Z`) + 7 * DAY_MS).toISOString().slice(0, 10)) {
    weeks.push(w);
  }
  const partial = new Set<string>();
  if (fromDate !== weeks[0]) partial.add(weeks[0]);
  const sunday = new Date(Date.parse(`${last}T00:00:00Z`) + 6 * DAY_MS).toISOString().slice(0, 10);
  if (toDate !== sunday) partial.add(last);
  return { weeks, partial: [...partial] };
}

export interface InsightsPeriod {
  fromDate: string;
  toDate: string;
  prevFromIso: string;
}

export function toInsightsView(
  raw: RawInsights,
  tz: string,
  now: Date = new Date(),
  period?: InsightsPeriod,
): InsightsView {
  const universe = Number(raw.base.conversations);
  // The summary cards compare with the previous period only if the workspace
  // already had customers writing when it started; otherwise the "change" is
  // the install date ("+200 %").
  const comparable =
    !period || raw.data_from === undefined || (raw.data_from !== null && Date.parse(raw.data_from) <= Date.parse(period.prevFromIso));
  const universePrev = comparable ? Number(raw.prev_conversations) : 0;
  const bookedPct = pct(Number(raw.base.booked), universe);
  const handedOffPct = pct(Number(raw.base.handed_off), universe);

  const topics = raw.topics
    .map((t) => {
      const conversations = Number(t.conversations);
      // A topic is measured over the ANALYSED conversations whose customer
      // wrote while it was covered: one not read yet is neither a hit nor a
      // miss. A payload without `universe` (older SQL) falls back to the range.
      const topicUniverse = t.universe == null ? universe : Number(t.universe);
      const coveredFrom = t.covered_from ?? null;
      const sharePct = pct(conversations, topicUniverse);
      // No previous-period coverage → no comparison, not a comparison with 0.
      const prevSharePct =
        t.prev_conversations == null
          ? null
          : pct(Number(t.prev_conversations), t.prev_universe == null ? universePrev : Number(t.prev_universe));
      return {
        id: t.id,
        name: t.name,
        coveredFromLabel: coveredFrom ? coveredLabel(coveredFrom, tz) : null,
        coveredFromWeek: coveredFrom ? zonedWeekStart(coveredFrom, tz) : null,
        notCovered: coveredFrom !== null && (t.in_coverage == null ? topicUniverse : Number(t.in_coverage)) === 0,
        analyzed: topicUniverse,
        inCoverage: t.in_coverage == null ? topicUniverse : Number(t.in_coverage),
        conversations,
        sharePct,
        prevSharePct,
        deltaPts: deltaPts(sharePct, prevSharePct),
        bookedPct: pct(Number(t.booked), conversations),
        handedOffPct: pct(Number(t.handed_off), conversations),
        tagPcts: tagPcts(t.tags, conversations),
      };
    })
    .sort((a, b) => b.conversations - a.conversations || a.name.localeCompare(b.name, "es"));

  const trend: Record<string, Record<string, number>> = {};
  for (const row of raw.trend) {
    (trend[row.topic_id] ??= {})[row.week] = Number(row.conversations);
  }

  return {
    universe,
    universePrev,
    universeChangePct:
      Number.isFinite(universe) && universePrev > 0
        ? round1(((universe - universePrev) / universePrev) * 100)
        : null,
    bookedPct,
    handedOffPct,
    bookedDeltaPts: deltaPts(bookedPct, pct(Number(raw.prev_booked), universePrev)),
    handedOffDeltaPts: deltaPts(handedOffPct, pct(Number(raw.prev_handed_off), universePrev)),
    tagPcts: tagPcts(raw.base.tags, universe),
    topics,
    ...(period
      ? (({ weeks, partial }) => ({ weeks, partialWeeks: partial }))(periodWeeks(period.fromDate, period.toDate))
      : { weeks: [...new Set(raw.trend.map((r) => r.week))].sort(), partialWeeks: [] }),
    trend,
    // Un payload sin la clave no inventa un aviso.
    partialConversations: Number(raw.partial_conversations) || 0,
    analysis: {
      conversations: Number(raw.analysis?.conversations ?? universe) || 0,
      analyzed: Number(raw.analysis?.analyzed ?? universe) || 0,
      pending: Number(raw.analysis?.pending) || 0,
      failed: Number(raw.analysis?.failed) || 0,
      tooOld: Number(raw.analysis?.too_old) || 0,
    },
  };
}

/**
 * The notice when part of the period isn't analysed yet: how many, and why.
 * null = everything is analysed.
 */
export function analysisNotice(a: AnalysisView): string | null {
  if (a.conversations === 0 || a.analyzed >= a.conversations) return null;
  const n = (x: number) => x.toLocaleString("es-CL");
  const parts = [
    a.pending > 0 &&
      `${n(a.pending)} ${a.pending === 1 ? "se analizará" : "se analizarán"} en las próximas horas`,
    a.failed > 0 &&
      `${n(a.failed)} no se ${a.failed === 1 ? "pudo" : "pudieron"} analizar (se reintenta si el cliente vuelve a escribir)`,
    a.tooOld > 0 &&
      `${n(a.tooOld)} ${a.tooOld === 1 ? "tiene" : "tienen"} más de 30 días y ya no se ${a.tooOld === 1 ? "analizará" : "analizarán"}`,
  ].filter(Boolean);
  return (
    `Se han analizado ${n(a.analyzed)} de ${n(a.conversations)} conversaciones de este período; ` +
    `los temas se miden solo sobre las analizadas.` +
    (parts.length > 0 ? ` De las demás: ${parts.join("; ")}.` : "")
  );
}
