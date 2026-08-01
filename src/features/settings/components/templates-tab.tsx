"use client";

import { useState, useCallback, useEffect } from "react";
import {
  RefreshCw,
  Plus,
  CheckCircle2,
  Clock,
  XCircle,
  PauseCircle,
  FileText,
  Copy,
  Pencil,
  Trash2,
  Send,
  BookOpen,
  ArrowRight,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TemplateRow } from "@/features/inbox/services/templates";
import {
  sanitizeTemplateName,
  type TemplateButton,
  type TemplateVariable,
} from "@/features/settings/lib/template-form";
import { TemplateFormSheet, type TemplatePrefill } from "./template-form-sheet";
import { CostCalculator } from "./cost-calculator";

// ── Status config ─────────────────────────────────────────────────────────────

type StatusKey = TemplateRow["status"];

const STATUS_CONFIG: Record<
  StatusKey,
  { label: string; className: string; Icon: React.ElementType }
> = {
  approved: {
    label: "Aprobado",
    className: "text-emerald-400 bg-emerald-400/10",
    Icon: CheckCircle2,
  },
  submitted: {
    label: "Pendiente",
    className: "text-amber-400 bg-amber-400/10",
    Icon: Clock,
  },
  draft: {
    label: "Borrador",
    className: "text-muted-foreground bg-muted",
    Icon: FileText,
  },
  rejected: {
    label: "Rechazado",
    className: "text-destructive bg-destructive/10",
    Icon: XCircle,
  },
  paused: {
    label: "Pausado",
    className: "text-orange-400 bg-orange-400/10",
    Icon: PauseCircle,
  },
};

// ── Filter tabs ───────────────────────────────────────────────────────────────

type FilterKey = "all" | StatusKey;

const FILTERS: { value: FilterKey; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "approved", label: "Aprobados" },
  { value: "submitted", label: "Pendientes" },
  { value: "rejected", label: "Rechazados" },
];

// ── Library types ─────────────────────────────────────────────────────────────

interface LibraryItem {
  id: string;
  title: string;
  description: string | null;
  use_case: string | null;
  category: string;
  language: string;
  header_type: "none" | "text";
  header_text: string | null;
  body_template: string;
  footer_text: string | null;
  buttons: unknown[];
  variables: unknown[];
  sort_order: number;
}

function libraryToPrefill(item: LibraryItem): TemplatePrefill {
  return {
    name: sanitizeTemplateName(item.title),
    category: item.category === "marketing" ? "marketing" : "utility",
    header_type: item.header_type === "text" ? "text" : "none",
    header_text: item.header_text ?? "",
    body_template: item.body_template,
    body_variables: Array.isArray(item.variables)
      ? (item.variables as TemplateVariable[])
      : [],
    footer_text: item.footer_text ?? "",
    buttons: Array.isArray(item.buttons)
      ? (item.buttons as TemplateButton[])
      : [],
  };
}

// ── Skeleton / empty ──────────────────────────────────────────────────────────

function TemplatesSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Cargando…">
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className="h-20 animate-pulse rounded-lg border border-border bg-muted/30"
        />
      ))}
    </div>
  );
}

function EmptyState({
  filtered,
  onNew,
}: {
  filtered: boolean;
  onNew: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-14 text-center">
      <FileText className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
      <div>
        <p className="text-sm font-medium text-foreground">
          {filtered ? "Sin resultados" : "Sin plantillas"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {filtered
            ? "Prueba con otro filtro."
            : "Crea una nueva, usa la biblioteca o sincroniza desde Kapso."}
        </p>
      </div>
      {!filtered && (
        <Button size="sm" onClick={onNew}>
          <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Nueva plantilla
        </Button>
      )}
    </div>
  );
}

// ── Template list item ────────────────────────────────────────────────────────

function TemplateItem({
  template,
  onEdit,
  onDelete,
  onSubmit,
  submitting,
}: {
  template: TemplateRow;
  onEdit: (t: TemplateRow) => void;
  onDelete: (t: TemplateRow) => void;
  onSubmit: (t: TemplateRow) => void;
  submitting: boolean;
}) {
  const cfg = STATUS_CONFIG[template.status] ?? STATUS_CONFIG.draft;
  const { Icon } = cfg;
  const canSubmit =
    template.status === "draft" || template.status === "rejected";
  const canDelete = canSubmit;
  const variableCount = Array.isArray(template.variables)
    ? template.variables.length
    : 0;
  const bodyPreview = template.body_template
    ? template.body_template.slice(0, 80) +
      (template.body_template.length > 80 ? "…" : "")
    : "";

  function handleCopy() {
    navigator.clipboard.writeText(template.body_template ?? "");
    toast.success("Cuerpo copiado al portapapeles");
  }

  return (
    <div className="space-y-2 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-border/80">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-sm font-medium text-foreground">
            {template.name}
          </span>
          <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
            {template.language}
          </span>
          <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs capitalize text-muted-foreground">
            {template.category}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <span
            className={cn(
              "flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
              cfg.className,
            )}
          >
            <Icon className="h-3 w-3" aria-hidden="true" />
            {cfg.label}
          </span>

          <button
            type="button"
            onClick={() => onEdit(template)}
            className="ml-1 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={`Editar ${template.name}`}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={`Copiar cuerpo de ${template.name}`}
          >
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          {canDelete && (
            <button
              type="button"
              onClick={() => onDelete(template)}
              className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              aria-label={`Eliminar ${template.name}`}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {bodyPreview && (
        <p className="whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
          {bodyPreview}
        </p>
      )}

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {variableCount > 0 && (
            <span className="text-xs text-muted-foreground">
              {variableCount} variable{variableCount !== 1 ? "s" : ""}
            </span>
          )}
          {template.rejection_reason && (
            <span className="text-xs text-destructive">
              Motivo: {template.rejection_reason}
            </span>
          )}
        </div>
        {canSubmit && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onSubmit(template)}
            disabled={submitting}
            aria-busy={submitting}
            className="h-7"
          >
            <Send className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {submitting ? "Enviando…" : "Enviar a aprobación"}
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Library card ──────────────────────────────────────────────────────────────

function LibraryCard({
  item,
  onUse,
}: {
  item: LibraryItem;
  onUse: (item: LibraryItem) => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">
          {item.title}
        </span>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
            item.category === "utility"
              ? "bg-emerald-400/10 text-emerald-400"
              : "bg-amber-400/10 text-amber-400",
          )}
        >
          {item.category === "utility" ? "Utilidad" : "Marketing"}
        </span>
      </div>
      {item.description && (
        <p className="text-xs text-muted-foreground">{item.description}</p>
      )}
      <p className="line-clamp-3 whitespace-pre-line rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        {item.body_template}
      </p>
      <Button
        size="sm"
        variant="outline"
        onClick={() => onUse(item)}
        className="mt-1 self-start"
      >
        Usar esta plantilla
        <ArrowRight className="ml-1.5 h-3.5 w-3.5" aria-hidden="true" />
      </Button>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

type View = "mine" | "library";

interface Props {
  workspaceId: string;
  initialTemplates: unknown[];
}

export function TemplatesTab({ workspaceId, initialTemplates }: Props) {
  const [view, setView] = useState<View>("mine");
  const [templates, setTemplates] = useState<TemplateRow[]>(
    (initialTemplates ?? []) as TemplateRow[],
  );
  const [isLoadingTemplates, setIsLoadingTemplates] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [submittingId, setSubmittingId] = useState<string | null>(null);

  // Library state
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryLoaded, setLibraryLoaded] = useState(false);

  // Sheet state
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<
    TemplateRow | undefined
  >(undefined);
  const [prefill, setPrefill] = useState<TemplatePrefill | null>(null);

  // ── Fetch templates ───────────────────────────────────────────────────────
  const fetchTemplates = useCallback(async () => {
    setIsLoadingTemplates(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/templates`);
      const json = (await res.json()) as {
        data?: TemplateRow[];
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? "Error al cargar plantillas");
      setTemplates(json.data ?? []);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Error al cargar plantillas",
      );
    } finally {
      setIsLoadingTemplates(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetchTemplates resets loading/error before each (re)fetch
    fetchTemplates();
  }, [fetchTemplates]);

  // ── Fetch library (lazy, once) ────────────────────────────────────────────
  const fetchLibrary = useCallback(async () => {
    if (libraryLoaded) return;
    setLibraryLoading(true);
    try {
      const res = await fetch(
        `/api/workspace/${workspaceId}/templates/library`,
      );
      const json = (await res.json()) as {
        data?: LibraryItem[];
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? "Error al cargar biblioteca");
      setLibrary(json.data ?? []);
      setLibraryLoaded(true);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Error al cargar biblioteca",
      );
    } finally {
      setLibraryLoading(false);
    }
  }, [workspaceId, libraryLoaded]);

  function switchView(next: View) {
    setView(next);
    if (next === "library") fetchLibrary();
  }

  // ── Sync ──────────────────────────────────────────────────────────────────
  async function handleSync() {
    setIsSyncing(true);
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/templates/sync`, {
        method: "POST",
      });
      const json = (await res.json()) as {
        synced?: number;
        errors?: number;
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? "Error al sincronizar");
      toast.success(
        `Sincronizadas ${json.synced ?? 0} plantillas${json.errors ? ` · ${json.errors} errores` : ""}`,
      );
      await fetchTemplates();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error al sincronizar");
    } finally {
      setIsSyncing(false);
    }
  }

  // ── Submit to Kapso ──────────────────────────────────────────────────────
  async function handleSubmitTemplate(t: TemplateRow) {
    setSubmittingId(t.id);
    try {
      const res = await fetch(
        `/api/workspace/${workspaceId}/templates/submit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: t.id }),
        },
      );
      const json = (await res.json()) as { warning?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Error al enviar");
      toast.success("Plantilla enviada a aprobación");
      if (json.warning) toast(json.warning);
      await fetchTemplates();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error al enviar");
    } finally {
      setSubmittingId(null);
    }
  }

  // ── Delete ────────────────────────────────────────────────────────────────
  async function handleDelete(t: TemplateRow) {
    if (
      !window.confirm(
        `¿Eliminar la plantilla "${t.name}"? Esta acción no se puede deshacer.`,
      )
    )
      return;
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/templates`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: t.id }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Error al eliminar");
      toast.success("Plantilla eliminada");
      setTemplates((prev) => prev.filter((x) => x.id !== t.id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error al eliminar");
    }
  }

  // ── Sheet openers ─────────────────────────────────────────────────────────
  function openNew() {
    setEditingTemplate(undefined);
    setPrefill(null);
    setSheetOpen(true);
  }

  function openEdit(t: TemplateRow) {
    setEditingTemplate(t);
    setPrefill(null);
    setSheetOpen(true);
  }

  function openFromLibrary(item: LibraryItem) {
    setEditingTemplate(undefined);
    setPrefill(libraryToPrefill(item));
    setSheetOpen(true);
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const approvedCount = templates.filter((t) => t.status === "approved").length;
  const pendingCount = templates.filter((t) => t.status === "submitted").length;
  const filtered =
    filter === "all" ? templates : templates.filter((t) => t.status === filter);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <div className="space-y-5">
        {/* Header */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-display text-base font-medium text-foreground">
              Plantillas de WhatsApp
            </h2>
            {view === "mine" && !isLoadingTemplates && !loadError && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {templates.length} plantilla{templates.length !== 1 ? "s" : ""}
                {approvedCount > 0 &&
                  ` · ${approvedCount} aprobada${approvedCount !== 1 ? "s" : ""}`}
                {pendingCount > 0 &&
                  ` · ${pendingCount} pendiente${pendingCount !== 1 ? "s" : ""}`}
              </p>
            )}
          </div>

          {view === "mine" && (
            <div className="flex flex-wrap items-center gap-2">
              <CostCalculator />
              <Button
                variant="outline"
                size="sm"
                onClick={handleSync}
                disabled={isSyncing}
                aria-busy={isSyncing}
              >
                <RefreshCw
                  className={cn("mr-2 h-4 w-4", isSyncing && "animate-spin")}
                  aria-hidden="true"
                />
                {isSyncing ? "Sincronizando…" : "Sincronizar desde Kapso"}
              </Button>
              <Button size="sm" onClick={openNew}>
                <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
                Nueva plantilla
              </Button>
            </div>
          )}
        </div>

        {/* View toggle */}
        <div className="flex gap-1 border-b border-border pb-0.5">
          {(
            [
              { value: "mine", label: "Mis plantillas", Icon: FileText },
              { value: "library", label: "Biblioteca", Icon: BookOpen },
            ] as const
          ).map((v) => (
            <button
              key={v.value}
              type="button"
              onClick={() => switchView(v.value)}
              className={cn(
                "flex items-center gap-1.5 rounded-t px-3 py-1.5 text-xs font-medium transition-colors",
                view === v.value
                  ? "border-b-2 border-primary text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              aria-pressed={view === v.value}
            >
              <v.Icon className="h-3.5 w-3.5" aria-hidden="true" />
              {v.label}
            </button>
          ))}
        </div>

        {/* ── Mine ──────────────────────────────────────────────────────── */}
        {view === "mine" && (
          <>
            <div className="flex gap-1">
              {FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setFilter(f.value)}
                  className={cn(
                    "rounded px-3 py-1.5 text-xs font-medium transition-colors",
                    filter === f.value
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  aria-pressed={filter === f.value}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {isLoadingTemplates ? (
              <TemplatesSkeleton />
            ) : loadError ? (
              <div className="flex items-center justify-between gap-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                <span>{loadError}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={fetchTemplates}
                  className="shrink-0"
                >
                  Reintentar
                </Button>
              </div>
            ) : filtered.length === 0 ? (
              <EmptyState filtered={filter !== "all"} onNew={openNew} />
            ) : (
              <div className="space-y-2">
                {filtered.map((t) => (
                  <TemplateItem
                    key={t.id}
                    template={t}
                    onEdit={openEdit}
                    onDelete={handleDelete}
                    onSubmit={handleSubmitTemplate}
                    submitting={submittingId === t.id}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* ── Library ───────────────────────────────────────────────────── */}
        {view === "library" && (
          <>
            {libraryLoading ? (
              <TemplatesSkeleton />
            ) : library.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border py-14 text-center text-sm text-muted-foreground">
                La biblioteca está vacía.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {library.map((item) => (
                  <LibraryCard
                    key={item.id}
                    item={item}
                    onUse={openFromLibrary}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <TemplateFormSheet
        workspaceId={workspaceId}
        template={editingTemplate}
        prefill={prefill}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        onSaved={fetchTemplates}
      />
    </>
  );
}
