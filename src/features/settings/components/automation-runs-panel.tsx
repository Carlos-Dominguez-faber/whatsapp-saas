"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { RUN_STATUS_LABELS, runReasonLabel } from "@/features/automations/lib/run-labels";
import type { RunCursor, RunFilter, RunListItem } from "@/features/automations/services/run-list";

const FILTERS: Array<{ value: RunFilter; label: string }> = [
  { value: "all", label: "Todas" },
  { value: "failed", label: "Fallidas" },
  { value: "skipped", label: "Omitidas" },
  { value: "done", label: "Ejecutadas" },
  { value: "pending", label: "En cola" },
];

const STATUS_CLASS: Record<string, string> = {
  done: "text-emerald-600 dark:text-emerald-400",
  failed: "text-destructive",
  skipped: "text-muted-foreground",
  pending: "text-warning",
  processing: "text-warning",
};

function when(iso: string): string {
  return new Date(iso).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" });
}

/**
 * Read-only list of the workspace's automation runs (the last 30 days: older
 * history is purged). For admins and managers: the route checks the role.
 */
export function AutomationRunsPanel({ workspaceId }: { workspaceId: string }) {
  const [filter, setFilter] = useState<RunFilter>("all");
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [next, setNext] = useState<RunCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (cursor: RunCursor | null) => {
      setLoading(true);
      setError(null);
      const q = new URLSearchParams({ status: filter });
      if (cursor) {
        q.set("before", cursor.at);
        q.set("beforeId", cursor.id);
      }
      try {
        const res = await fetch(`/api/workspace/${workspaceId}/automations/runs?${q}`);
        const json = (await res.json()) as { runs?: RunListItem[]; nextBefore?: RunCursor | null; error?: string };
        if (!res.ok) throw new Error(json.error ?? "No se pudieron cargar las ejecuciones.");
        setRuns((prev) => (cursor ? [...prev, ...(json.runs ?? [])] : (json.runs ?? [])));
        setNext(json.nextBefore ?? null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "No se pudieron cargar las ejecuciones.");
      } finally {
        setLoading(false);
      }
    },
    [workspaceId, filter],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: load resets loading/error before each (re)fetch
    void load(null);
  }, [load]);

  return (
    <section aria-labelledby="automation-runs-title" className="space-y-3 border-t border-border/60 pt-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 id="automation-runs-title" className="font-display text-sm font-medium text-foreground">
            Ejecuciones recientes
          </h3>
          <p className="text-xs text-muted-foreground">
            Qué hizo cada regla y con quién, en los últimos 30 días.
          </p>
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filtrar ejecuciones">
          {FILTERS.map((f) => (
            <Button
              key={f.value}
              type="button"
              size="sm"
              variant={filter === f.value ? "default" : "outline"}
              aria-pressed={filter === f.value}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </Button>
          ))}
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      {!error && !loading && runs.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
          No hay ejecuciones con este filtro.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-xs">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th scope="col" className="p-2 font-medium">Cuándo</th>
                <th scope="col" className="p-2 font-medium">Regla</th>
                <th scope="col" className="p-2 font-medium">Contacto</th>
                <th scope="col" className="p-2 font-medium">Resultado</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-t align-top">
                  <td className="whitespace-nowrap p-2 tabular-nums text-muted-foreground">
                    {when(r.finished_at ?? r.created_at)}
                  </td>
                  <td className="p-2">{r.rule?.name ?? "—"}</td>
                  <td className="p-2">
                    {r.conversation_id ? (
                      <Link href={`/inbox/${r.conversation_id}`} className="underline underline-offset-2">
                        {r.contact?.name || r.contact?.phone || "Conversación"}
                      </Link>
                    ) : (
                      (r.contact?.name || r.contact?.phone) ?? "—"
                    )}
                  </td>
                  <td className="p-2">
                    <span className={cn("font-medium", STATUS_CLASS[r.status])}>
                      {RUN_STATUS_LABELS[r.status] ?? r.status}
                    </span>
                    {r.error && r.status !== "done" && (
                      <span className="text-muted-foreground"> · {runReasonLabel(r.error)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex justify-center">
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Cargando ejecuciones" />
        ) : (
          next && (
            <Button type="button" size="sm" variant="outline" onClick={() => void load(next)}>
              Cargar más
            </Button>
          )
        )}
      </div>
    </section>
  );
}
