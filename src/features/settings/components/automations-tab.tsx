"use client";

import { useState, useEffect, useCallback, useTransition } from "react";
import {
  MessageCircle,
  Clock,
  CalendarClock,
  AlertTriangle,
  Users,
  Star,
  Search,
  Plus,
  Pencil,
  Trash2,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  deleteAutomationRule,
  toggleAutomationRule,
  type AutomationRule,
  type TriggerType,
  type ActionType,
} from "../services/automation-actions";
import { AutomationRuleForm } from "./automation-rule-form";
import type { TemplateRow } from "@/features/inbox/services/templates";

// ── Trigger metadata ──────────────────────────────────────────────────────────

const TRIGGER_META: Record<
  TriggerType,
  { label: string; Icon: React.ElementType; className: string }
> = {
  first_message: {
    label: "Primer mensaje",
    Icon: MessageCircle,
    className: "text-info bg-info/10",
  },
  inactivity_24h: {
    label: "Sin respuesta 24h",
    Icon: Clock,
    className: "text-warning bg-warning/10",
  },
  window_closing: {
    label: "Ventana cerrando",
    Icon: AlertTriangle,
    className: "text-orange-400 bg-orange-400/10",
  },
  handoff_requested: {
    label: "IA solicita handoff",
    Icon: Users,
    className: "text-secondary bg-secondary/10",
  },
  lead_qualified: {
    label: "Lead calificado",
    Icon: Star,
    className: "text-primary bg-primary/10",
  },
  keyword_match: {
    label: "Palabra clave",
    Icon: Search,
    className: "text-muted-foreground bg-muted",
  },
  appointment_upcoming: {
    label: "Antes de una cita",
    Icon: CalendarClock,
    className: "text-emerald-400 bg-emerald-400/10",
  },
};

// ── Action metadata ───────────────────────────────────────────────────────────

const ACTION_LABELS: Record<ActionType, string> = {
  send_template: "Enviar template",
  assign_agent: "Asignar agente",
  add_tag: "Agregar etiqueta",
  close_conversation: "Cerrar conversación",
  handoff_human: "Transferir a humano",
};

// ── Loading skeleton ──────────────────────────────────────────────────────────

function AutomationsSkeleton() {
  return (
    <div
      className="space-y-3"
      aria-busy="true"
      aria-label="Cargando automatizaciones..."
    >
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="h-20 w-full rounded-lg" />
      ))}
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Zap className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
      </div>
      <div>
        <p className="text-sm font-medium text-foreground">
          No hay automatizaciones configuradas
        </p>
        <p className="mt-1 max-w-xs text-xs text-muted-foreground">
          Las automatizaciones envían mensajes y realizan acciones
          automáticamente cuando ocurren eventos en tus conversaciones.
        </p>
      </div>
      <Button size="sm" onClick={onNew}>
        <Plus className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
        Nueva automatización
      </Button>
    </div>
  );
}

// ── Rule card ─────────────────────────────────────────────────────────────────

interface RuleCardProps {
  rule: AutomationRule;
  onEdit: (rule: AutomationRule) => void;
  onDelete: (rule: AutomationRule) => void;
  onToggle: (rule: AutomationRule, enabled: boolean) => void;
  isToggling: boolean;
}

function RuleCard({
  rule,
  onEdit,
  onDelete,
  onToggle,
  isToggling,
}: RuleCardProps) {
  const trigger = TRIGGER_META[rule.trigger_type];
  const { Icon } = trigger;
  const actionLabel = ACTION_LABELS[rule.action_type];

  const actionDetail =
    rule.action_type === "send_template" &&
    typeof rule.action_config?.template_name === "string"
      ? ` · ${rule.action_config.template_name}`
      : rule.action_type === "add_tag" &&
          typeof rule.action_config?.tag === "string"
        ? ` · ${rule.action_config.tag}`
        : "";

  return (
    <div
      className={cn(
        "rounded-lg border bg-card px-4 py-3 transition-colors",
        rule.enabled ? "border-border" : "border-border/50 opacity-60",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        {/* Left: info */}
        <div className="flex-1 min-w-0 space-y-1.5">
          <p className="text-sm font-medium text-foreground truncate">
            {rule.name}
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Trigger badge */}
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
                trigger.className,
              )}
            >
              <Icon className="h-3 w-3" aria-hidden="true" />
              {trigger.label}
            </span>

            <span className="text-xs text-muted-foreground" aria-hidden="true">
              →
            </span>

            {/* Action badge */}
            <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
              {actionLabel}
              {actionDetail && (
                <span className="ml-0.5 font-mono">{actionDetail}</span>
              )}
            </span>

            {/* Keyword hint */}
            {rule.trigger_type === "keyword_match" &&
              Array.isArray(rule.trigger_config?.keywords) &&
              (rule.trigger_config.keywords as string[]).length > 0 && (
                <span className="text-xs text-muted-foreground truncate max-w-[160px]">
                  {(rule.trigger_config.keywords as string[]).join(", ")}
                </span>
              )}
          </div>
        </div>

        {/* Right: controls */}
        <div className="flex items-center gap-1 shrink-0">
          <Switch
            checked={rule.enabled}
            onCheckedChange={(v) => onToggle(rule, v)}
            disabled={isToggling}
            aria-label={
              rule.enabled
                ? "Deshabilitar automatización"
                : "Habilitar automatización"
            }
            className="mr-1"
          />
          <button
            type="button"
            onClick={() => onEdit(rule)}
            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            aria-label={`Editar automatización ${rule.name}`}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => onDelete(rule)}
            className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
            aria-label={`Eliminar automatización ${rule.name}`}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  workspaceId: string;
}

export function AutomationsTab({ workspaceId }: Props) {
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // Sheet state
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<AutomationRule | undefined>(
    undefined,
  );

  const [, startTransition] = useTransition();

  // ── Fetch rules + templates ─────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const [rulesRes, templatesRes] = await Promise.all([
        fetch(`/api/workspace/${workspaceId}/automations`),
        fetch(`/api/workspace/${workspaceId}/templates`),
      ]);

      const rulesJson = (await rulesRes.json()) as {
        data?: AutomationRule[];
        error?: string;
      };
      const templatesJson = (await templatesRes.json()) as {
        data?: TemplateRow[];
        error?: string;
      };

      if (!rulesRes.ok) {
        throw new Error(rulesJson.error ?? "Error al cargar automatizaciones");
      }

      setRules(rulesJson.data ?? []);
      setTemplates(templatesJson.data ?? []);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Error al cargar automatizaciones";
      setLoadError(msg);
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: fetchData resets loading/error before each (re)fetch
    fetchData();
  }, [fetchData]);

  // ── Handlers ────────────────────────────────────────────────────────────────

  function openNew() {
    setEditingRule(undefined);
    setSheetOpen(true);
  }

  function openEdit(rule: AutomationRule) {
    setEditingRule(rule);
    setSheetOpen(true);
  }

  async function handleDelete(rule: AutomationRule) {
    if (
      !window.confirm(
        `¿Eliminar la automatización "${rule.name}"? Esta acción no se puede deshacer.`,
      )
    )
      return;

    startTransition(async () => {
      const result = await deleteAutomationRule(workspaceId, rule.id);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success("Automatización eliminada");
      setRules((prev) => prev.filter((r) => r.id !== rule.id));
    });
  }

  async function handleToggle(rule: AutomationRule, enabled: boolean) {
    setTogglingId(rule.id);
    // Optimistic update
    setRules((prev) =>
      prev.map((r) => (r.id === rule.id ? { ...r, enabled } : r)),
    );

    const result = await toggleAutomationRule(workspaceId, rule.id, enabled);
    setTogglingId(null);

    if (result.error) {
      toast.error(result.error);
      // Rollback
      setRules((prev) =>
        prev.map((r) => (r.id === rule.id ? { ...r, enabled: !enabled } : r)),
      );
      return;
    }

    toast.success(
      enabled ? "Automatización habilitada" : "Automatización deshabilitada",
    );
  }

  function handleSaved() {
    fetchData();
  }

  // ── Derived ──────────────────────────────────────────────────────────────────

  const enabledCount = rules.filter((r) => r.enabled).length;

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="space-y-5">
        {/* Header */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-display text-base font-medium text-foreground">
              Automatizaciones
            </h2>
            {!isLoading && !loadError && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {rules.length} regla{rules.length !== 1 ? "s" : ""}
                {enabledCount > 0 &&
                  ` · ${enabledCount} activa${enabledCount !== 1 ? "s" : ""}`}
              </p>
            )}
          </div>
          <Button size="sm" onClick={openNew}>
            <Plus className="h-4 w-4 mr-2" aria-hidden="true" />
            Nueva automatización
          </Button>
        </div>

        {/* Content — 4 states */}
        {isLoading ? (
          <AutomationsSkeleton />
        ) : loadError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive flex items-center justify-between gap-4">
            <span>{loadError}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={fetchData}
              className="shrink-0"
            >
              Reintentar
            </Button>
          </div>
        ) : rules.length === 0 ? (
          <EmptyState onNew={openNew} />
        ) : (
          <div className="space-y-2">
            {rules.map((rule) => (
              <RuleCard
                key={rule.id}
                rule={rule}
                onEdit={openEdit}
                onDelete={handleDelete}
                onToggle={handleToggle}
                isToggling={togglingId === rule.id}
              />
            ))}
          </div>
        )}
      </div>

      {/* Form sheet */}
      <AutomationRuleForm
        workspaceId={workspaceId}
        rule={editingRule}
        templates={templates}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        onSaved={handleSaved}
      />
    </>
  );
}
