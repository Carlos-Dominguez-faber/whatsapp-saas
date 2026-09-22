"use client";

// F8-D2: Observability panel — shows KPI tiles + event log for a conversation.

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type {
  ConversationMetrics,
  EventLogEntry,
} from "@/features/inbox/services/observability";

interface ObservabilityPanelProps {
  conversationId: string;
}

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

interface EventTypeStyle {
  label: string;
  variant: BadgeVariant;
  className: string;
}

const EVENT_TYPE_STYLES: Record<string, EventTypeStyle> = {
  llm_usage: {
    label: "LLM",
    variant: "default",
    className: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  },
  tool_call: {
    label: "Tool",
    variant: "default",
    className: "bg-green-500/20 text-green-300 border-green-500/30",
  },
  state_change: {
    label: "State",
    variant: "default",
    className: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  },
  error: {
    label: "Error",
    variant: "destructive",
    className: "bg-red-500/20 text-red-300 border-red-500/30",
  },
  cost_alert: {
    label: "Cost",
    variant: "default",
    className: "bg-orange-500/20 text-orange-300 border-orange-500/30",
  },
  jev_judgment: {
    label: "Jev",
    variant: "default",
    className: "bg-amber-500/20 text-amber-200 border-amber-500/30",
  },
};

const LEVEL_INDICATOR: Record<string, string> = {
  error: "bg-red-500",
  warn: "bg-amber-500",
  info: "bg-blue-500",
  debug: "bg-zinc-500",
};

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("es-MX", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function truncatePayload(payload: Record<string, unknown>): string {
  try {
    const str = JSON.stringify(payload);
    return str.length > 80 ? str.slice(0, 77) + "…" : str;
  } catch {
    return "";
  }
}

function formatCost(usd: number): string {
  if (usd === 0) return "$0.000000";
  return `$${usd.toFixed(6)}`;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

interface ApiResponse {
  metrics: ConversationMetrics;
  events: EventLogEntry[];
}

export function ObservabilityPanel({
  conversationId,
}: ObservabilityPanelProps) {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/events`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as ApiResponse;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al cargar métricas");
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: fetchData resets loading/error before each (re)fetch
    void fetchData();
  }, [fetchData]);

  const metrics = data?.metrics;
  const events = data?.events ?? [];

  return (
    <div className="glass flex flex-col gap-3 rounded-xl border border-border bg-muted/30 p-4 backdrop-blur-md">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="font-display text-sm font-semibold text-foreground">
          Observabilidad
        </h3>
        <Button
          size="sm"
          variant="outline"
          className="h-6 border-border px-2 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => void fetchData()}
          disabled={loading}
        >
          {loading ? "Cargando…" : "Actualizar"}
        </Button>
      </div>

      {/* Error state */}
      {error && (
        <p className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-xs text-red-300">
          {error}
        </p>
      )}

      {/* KPI tiles — 4 metrics */}
      <div className="grid grid-cols-2 gap-2">
        <KpiTile
          label="Tokens"
          value={
            metrics
              ? `${formatTokens(metrics.totalInputTokens + metrics.totalOutputTokens)}`
              : "—"
          }
          sub={
            metrics
              ? `${formatTokens(metrics.totalInputTokens)} in / ${formatTokens(metrics.totalOutputTokens)} out`
              : undefined
          }
          loading={loading}
        />
        <KpiTile
          label="LLM calls"
          value={metrics ? String(metrics.totalLlmCalls) : "—"}
          loading={loading}
        />
        <KpiTile
          label="Tool calls"
          value={metrics ? String(metrics.toolCallCount) : "—"}
          loading={loading}
        />
        <KpiTile
          label="Costo est."
          value={metrics ? formatCost(metrics.estimatedCostUsd) : "—"}
          loading={loading}
        />
      </div>

      {/* Event log */}
      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium text-muted-foreground">
          Últimos {events.length} eventos
        </p>
        <ScrollArea className="max-h-96 rounded-lg border border-border bg-background/40">
          {loading && events.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              Cargando eventos…
            </div>
          ) : events.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              Sin eventos registrados
            </div>
          ) : (
            <div className="divide-y divide-border">
              {events.map((event) => {
                const style = EVENT_TYPE_STYLES[event.type] ?? {
                  label: event.type,
                  variant: "outline" as BadgeVariant,
                  className: "bg-zinc-500/20 text-zinc-300 border-zinc-500/30",
                };
                const dotColor =
                  LEVEL_INDICATOR[event.level] ?? LEVEL_INDICATOR.info;
                const payloadPreview = truncatePayload(event.payload);

                return (
                  <div
                    key={event.id}
                    className="flex items-start gap-2 px-3 py-2"
                  >
                    {/* Level dot */}
                    <span
                      className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${dotColor}`}
                    />

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <Badge
                          variant={style.variant}
                          className={`h-4 px-1 text-[10px] leading-none ${style.className}`}
                        >
                          {style.label}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground">
                          {formatTimestamp(event.created_at)}
                        </span>
                      </div>
                      {payloadPreview && (
                        <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                          {payloadPreview}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}

// Internal KPI tile component
function KpiTile({
  label,
  value,
  sub,
  loading,
}: {
  label: string;
  value: string;
  sub?: string;
  loading: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-muted/30 px-3 py-2">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {loading ? (
        <span className="h-4 w-12 animate-pulse rounded bg-muted" />
      ) : (
        <>
          <span className="font-mono text-sm font-semibold text-foreground">
            {value}
          </span>
          {sub && (
            <span className="text-[10px] text-muted-foreground">{sub}</span>
          )}
        </>
      )}
    </div>
  );
}
