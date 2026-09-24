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
  prev_conversations: Num;
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
  oldest_pending: string | null;
}

export interface TopicView {
  id: string;
  name: string;
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
  weeks: string[];
  trend: Record<string, Record<string, number>>;
  partialConversations: number;
  stalePending: boolean;
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

function todayStartMs(tz: string, now: Date): number {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return zonedDayRange(today, today, tz)?.startMs ?? now.getTime();
}

/** Diferencia en puntos porcentuales entre dos porcentajes; null si falta uno. */
function deltaPts(current: number | null, previous: number | null): number | null {
  return current !== null && previous !== null ? round1(current - previous) : null;
}

export function toInsightsView(raw: RawInsights, tz: string, now: Date = new Date()): InsightsView {
  const universe = Number(raw.base.conversations);
  const universePrev = Number(raw.prev_conversations);
  const bookedPct = pct(Number(raw.base.booked), universe);
  const handedOffPct = pct(Number(raw.base.handed_off), universe);

  const topics = raw.topics
    .map((t) => {
      const conversations = Number(t.conversations);
      const sharePct = pct(conversations, universe);
      const prevSharePct = pct(Number(t.prev_conversations), universePrev);
      return {
        id: t.id,
        name: t.name,
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
    weeks: [...new Set(raw.trend.map((r) => r.week))].sort(),
    trend,
    // Un payload sin la clave no inventa un aviso.
    partialConversations: Number(raw.partial_conversations) || 0,
    stalePending:
      raw.oldest_pending !== null && Date.parse(raw.oldest_pending) < todayStartMs(tz, now),
  };
}
