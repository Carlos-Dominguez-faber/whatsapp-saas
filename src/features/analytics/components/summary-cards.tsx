import { formatPct, type InsightsView } from "../lib/insights-view";

function Card({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-xl border border-border/50 bg-card p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-display text-2xl font-semibold tabular-nums">{value}</p>
      {detail && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}

function change(pctValue: number | null): string | undefined {
  if (pctValue === null) return undefined;
  const sign = pctValue > 0 ? "+" : "";
  return `${sign}${formatPct(pctValue)} vs. período anterior`;
}

/**
 * Variación contra el período anterior en LAS TRES tarjetas. En las de porcentaje la variación se expresa en puntos
 * porcentuales, no en % de %, que no querría decir nada.
 */
function changePts(pts: number | null): string | undefined {
  if (pts === null) return undefined;
  const sign = pts > 0 ? "+" : "";
  return `${sign}${pts.toLocaleString("es-CL", { maximumFractionDigits: 1 })} pts vs. período anterior`;
}

export function SummaryCards({ view }: { view: InsightsView }) {
  return (
    <section aria-label="Resumen" className="grid gap-4 sm:grid-cols-3">
      <Card
        label="Conversaciones"
        value={view.universe.toLocaleString("es-CL")}
        detail={change(view.universeChangePct)}
      />
      <Card
        label="Agendaron cita"
        value={formatPct(view.bookedPct)}
        detail={changePts(view.bookedDeltaPts)}
      />
      <Card
        label="Derivadas a humano"
        value={formatPct(view.handedOffPct)}
        detail={changePts(view.handedOffDeltaPts)}
      />
    </section>
  );
}
