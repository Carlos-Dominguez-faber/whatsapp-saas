import { formatPct, type InsightsView } from "../lib/insights-view";

function delta(pts: number | null) {
  if (pts === null) return null;
  const sign = pts > 0 ? "+" : "";
  return `${sign}${pts.toLocaleString("es-CL", { maximumFractionDigits: 1 })} pts`;
}

export function TopicRanking({ view }: { view: InsightsView }) {
  return (
    <section aria-labelledby="ranking-title" className="space-y-3">
      <h2 id="ranking-title" className="text-lg font-semibold">
        Temas más frecuentes
      </h2>
      <ul className="space-y-2">
        {view.topics.map((t) => (
          <li key={t.id} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-sm">
            <span className="truncate" title={t.name}>
              {t.name}
            </span>
            <div
              className="h-3 rounded-full bg-muted"
              role="img"
              aria-label={`${t.name}: ${t.conversations} conversaciones, ${formatPct(t.sharePct)}`}
            >
              <div className="h-3 rounded-full bg-primary" style={{ width: `${Math.min(t.sharePct ?? 0, 100)}%` }} />
            </div>
            <span className="tabular-nums text-muted-foreground">
              {formatPct(t.sharePct)}
              {delta(t.deltaPts) && <span className="ml-2 text-xs">{delta(t.deltaPts)}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
