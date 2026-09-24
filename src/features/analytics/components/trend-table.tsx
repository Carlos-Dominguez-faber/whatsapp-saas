import type { InsightsView } from "../lib/insights-view";

export function TrendTable({ view }: { view: InsightsView }) {
  if (view.weeks.length === 0) return null;
  return (
    <section aria-labelledby="trend-title" className="space-y-3">
      <h2 id="trend-title" className="text-lg font-semibold">
        Conversaciones por semana
      </h2>
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th scope="col" className="p-3">Tema</th>
              {view.weeks.map((w) => (
                <th key={w} scope="col" className="p-3 whitespace-nowrap">
                  Semana del {new Date(`${w}T12:00:00Z`).toLocaleDateString("es-CL", { day: "numeric", month: "short" })}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.topics.map((t) => (
              <tr key={t.id} className="border-t">
                <th scope="row" className="p-3 text-left font-medium">
                  {t.name}
                </th>
                {view.weeks.map((w) => (
                  <td key={w} className="p-3 tabular-nums">
                    {view.trend[t.id]?.[w] ?? 0}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
