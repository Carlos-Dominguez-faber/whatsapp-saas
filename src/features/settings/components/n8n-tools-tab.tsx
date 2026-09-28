"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, Pencil, Trash2, Webhook } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { N8nToolForm, type N8nToolRowForm } from "./n8n-tool-form";

interface Props {
  workspaceId: string;
}

function N8nToolsSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Cargando herramientas n8n...">
      {Array.from({ length: 2 }).map((_, i) => (
        <Skeleton key={i} className="h-16 w-full rounded-lg" />
      ))}
    </div>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Webhook className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
      </div>
      <div>
        <p className="text-sm font-medium text-foreground">
          No hay herramientas de n8n configuradas
        </p>
        <p className="mt-1 max-w-xs text-xs text-muted-foreground">
          Conecta un workflow de n8n para que el agente pueda consultarlo o
          dispararlo durante una conversación.
        </p>
      </div>
      <Button size="sm" onClick={onNew}>
        <Plus className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
        Nueva herramienta
      </Button>
    </div>
  );
}

export function N8nToolsTab({ workspaceId }: Props) {
  const [tools, setTools] = useState<N8nToolRowForm[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingTool, setEditingTool] = useState<N8nToolRowForm | undefined>(undefined);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/n8n-tools`);
      const json = (await res.json()) as { data?: N8nToolRowForm[]; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Error al cargar herramientas");
      setTools(json.data ?? []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Error al cargar herramientas");
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: fetchData resets loading/error before each (re)fetch
    fetchData();
  }, [fetchData]);

  function openNew() {
    setEditingTool(undefined);
    setSheetOpen(true);
  }

  function openEdit(tool: N8nToolRowForm) {
    setEditingTool(tool);
    setSheetOpen(true);
  }

  async function handleDelete(tool: N8nToolRowForm) {
    if (!window.confirm(`¿Eliminar la herramienta "${tool.name}"? Esta acción no se puede deshacer.`)) return;

    const res = await fetch(`/api/workspace/${workspaceId}/n8n-tools/${tool.id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const json = (await res.json()) as { error?: string };
      toast.error(json.error ?? "Error al eliminar la herramienta");
      return;
    }
    toast.success("Herramienta eliminada");
    setTools((prev) => prev.filter((t) => t.id !== tool.id));
  }

  async function handleToggle(tool: N8nToolRowForm, enabled: boolean) {
    setTogglingId(tool.id);
    setTools((prev) => prev.map((t) => (t.id === tool.id ? { ...t, enabled } : t)));

    const res = await fetch(`/api/workspace/${workspaceId}/n8n-tools/${tool.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    setTogglingId(null);

    if (!res.ok) {
      const json = (await res.json()) as { error?: string };
      toast.error(json.error ?? "Error al actualizar la herramienta");
      setTools((prev) => prev.map((t) => (t.id === tool.id ? { ...t, enabled: !enabled } : t)));
      return;
    }
    toast.success(enabled ? "Herramienta habilitada" : "Herramienta deshabilitada");
  }

  return (
    <>
      <div className="space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-display text-base font-medium text-foreground">
              Herramientas n8n
            </h2>
            {!isLoading && !loadError && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {tools.length} herramienta{tools.length !== 1 ? "s" : ""}
              </p>
            )}
          </div>
          <Button size="sm" onClick={openNew}>
            <Plus className="h-4 w-4 mr-2" aria-hidden="true" />
            Nueva herramienta
          </Button>
        </div>

        {isLoading ? (
          <N8nToolsSkeleton />
        ) : loadError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive flex items-center justify-between gap-4">
            <span>{loadError}</span>
            <Button variant="outline" size="sm" onClick={fetchData} className="shrink-0">
              Reintentar
            </Button>
          </div>
        ) : tools.length === 0 ? (
          <EmptyState onNew={openNew} />
        ) : (
          <div className="space-y-2">
            {tools.map((tool) => (
              <div
                key={tool.id}
                className={cn(
                  "rounded-lg border bg-card px-4 py-3 transition-colors",
                  tool.enabled ? "border-border" : "border-border/50 opacity-60",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <p className="text-sm font-medium text-foreground truncate">{tool.name}</p>
                    <p className="text-xs text-muted-foreground line-clamp-1">
                      {tool.description}
                    </p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="text-xs font-normal">
                        {tool.mode === "sync" ? "sincrónico" : "asíncrono"}
                      </Badge>
                      <Badge variant="outline" className="text-xs font-normal">
                        {tool.sensitivity === "read" ? "lectura" : "escritura"}
                      </Badge>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Switch
                      checked={tool.enabled}
                      onCheckedChange={(v) => handleToggle(tool, v)}
                      disabled={togglingId === tool.id}
                      aria-label={tool.enabled ? "Deshabilitar herramienta" : "Habilitar herramienta"}
                      className="mr-1"
                    />
                    <button
                      type="button"
                      onClick={() => openEdit(tool)}
                      className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                      aria-label={`Editar herramienta ${tool.name}`}
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(tool)}
                      className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                      aria-label={`Eliminar herramienta ${tool.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <N8nToolForm
        workspaceId={workspaceId}
        tool={editingTool}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        onSaved={fetchData}
      />
    </>
  );
}
