"use client";

import Link from "next/link";
import {
  MessageCircle,
  Users,
  AlertCircle,
  DollarSign,
  Send,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  WorkspaceMetrics,
  RecentConversation,
} from "@/features/dashboard/services/metrics";
import type { ConversationState } from "@/features/inbox/types";

interface DashboardMetricsProps {
  metrics: WorkspaceMetrics;
  recentConversations: RecentConversation[];
}

interface KpiCardProps {
  label: string;
  value: string;
  icon: React.ReactNode;
  accent?: boolean;
}

function KpiCard({ label, value, icon, accent = false }: KpiCardProps) {
  return (
    <div
      className={cn(
        "rounded-xl border p-5 flex items-start gap-4",
        "bg-card transition-colors",
        accent ? "border-primary/20 bg-primary/5" : "border-border/50",
      )}
    >
      <div
        className={cn(
          "shrink-0 rounded-lg p-2",
          accent
            ? "bg-primary/10 text-primary"
            : "bg-muted text-muted-foreground",
        )}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
          {label}
        </p>
        <p className="font-display text-2xl font-semibold text-foreground mt-0.5 tabular-nums">
          {value}
        </p>
      </div>
    </div>
  );
}

const STATE_LABELS: Record<ConversationState, string> = {
  ai_active: "IA activa",
  human_active: "Humano",
  handoff_pending: "Handoff",
  waiting_reply: "Esperando",
  paused: "Pausado",
  closed: "Cerrado",
};

const STATE_COLORS: Record<ConversationState, string> = {
  ai_active: "bg-primary/10 text-primary",
  human_active: "bg-info/10 text-info",
  handoff_pending: "bg-warning/10 text-warning",
  waiting_reply: "bg-muted text-muted-foreground",
  paused: "bg-muted text-muted-foreground",
  closed: "bg-muted text-muted-foreground",
};

function StateBadge({ state }: { state: ConversationState }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium shrink-0",
        STATE_COLORS[state] ?? "bg-muted text-muted-foreground",
      )}
    >
      {STATE_LABELS[state] ?? state}
    </span>
  );
}

function formatCost(usd: number): string {
  if (usd < 0.01) return "$0.00";
  return `$${usd.toFixed(2)}`;
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "ahora";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

export function DashboardMetrics({
  metrics,
  recentConversations,
}: DashboardMetricsProps) {
  return (
    <div className="p-6 space-y-8 max-w-5xl mx-auto">
      {/* Page heading */}
      <div>
        <h1 className="font-display text-xl font-semibold text-foreground">
          Dashboard
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Actividad del workspace hoy
        </p>
      </div>

      {/* KPI grid — 2x2 on mobile, 1x4 on lg */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Mensajes hoy"
          value={metrics.messagesToday.toLocaleString("es")}
          icon={<MessageCircle className="h-4 w-4" aria-hidden="true" />}
        />
        <KpiCard
          label="Conversaciones activas"
          value={metrics.activeConversations.toLocaleString("es")}
          icon={<Users className="h-4 w-4" aria-hidden="true" />}
          accent
        />
        <KpiCard
          label="Handoffs pendientes"
          value={metrics.handoffPending.toLocaleString("es")}
          icon={<AlertCircle className="h-4 w-4" aria-hidden="true" />}
        />
        {metrics.llmCostWeekUsd !== null && (
          <KpiCard
            label="Costo LLM esta semana"
            value={formatCost(metrics.llmCostWeekUsd)}
            icon={<DollarSign className="h-4 w-4" aria-hidden="true" />}
          />
        )}
        <KpiCard
          label="Templates enviados (semana)"
          value={metrics.templatesSentWeek.toLocaleString("es")}
          icon={<Send className="h-4 w-4" aria-hidden="true" />}
        />
      </div>

      {/* Recent conversations */}
      <div className="space-y-3">
        <h2 className="font-display text-sm font-semibold text-foreground">
          Actividad reciente hoy
        </h2>

        {recentConversations.length === 0 ? (
          <div className="rounded-xl border border-border/50 bg-card px-5 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              Sin actividad registrada hoy
            </p>
          </div>
        ) : (
          <ul
            role="list"
            className="rounded-xl border border-border/50 bg-card divide-y divide-border/30 overflow-hidden"
          >
            {recentConversations.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/inbox/${c.id}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors"
                >
                  {/* Contact name + preview */}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground truncate">
                      {c.contactName ?? c.contactPhone}
                    </p>
                    {c.lastMessagePreview && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {c.lastMessagePreview}
                      </p>
                    )}
                  </div>

                  {/* State badge + time */}
                  <div className="flex items-center gap-2 shrink-0">
                    <StateBadge state={c.state} />
                    <span className="font-mono text-[10px] text-muted-foreground/70">
                      {formatRelativeTime(c.lastMessageAt)}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
