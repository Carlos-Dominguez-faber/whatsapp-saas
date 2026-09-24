"use client";

import { useState } from "react";
import { Sparkles, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CATEGORY_LABELS,
  TEMPLATE_CATEGORIES,
  type TemplateCategory,
} from "@/features/settings/lib/template-form";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  workspaceId: string;
  onGenerated: (body: string) => void;
}

type UseCase = "ventas" | "soporte" | "agendamiento" | "notificacion";

const USE_CASE_LABELS: Record<UseCase, string> = {
  ventas: "Ventas / Conversión",
  soporte: "Soporte al cliente",
  agendamiento: "Agendamiento / Citas",
  notificacion: "Notificación / Aviso",
};

// ── Skeleton ──────────────────────────────────────────────────────────────────

function GeneratingSkeleton() {
  return (
    <div
      className="space-y-2 animate-pulse"
      aria-busy="true"
      aria-label="Generando plantilla..."
    >
      <div className="h-3.5 bg-muted rounded w-4/5" />
      <div className="h-3.5 bg-muted rounded w-full" />
      <div className="h-3.5 bg-muted rounded w-3/4" />
      <div className="h-3.5 bg-muted rounded w-full" />
      <div className="h-3.5 bg-muted rounded w-2/3" />
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function AiTemplateGenerator({ workspaceId, onGenerated }: Props) {
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<TemplateCategory>("utility");
  const [useCase, setUseCase] = useState<UseCase>("notificacion");
  const [isLoading, setIsLoading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  async function handleGenerate() {
    if (!description.trim()) return;

    setIsLoading(true);
    setPreview(null);

    try {
      const res = await fetch(
        `/api/workspace/${workspaceId}/templates/generate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            description: description.trim(),
            category,
            useCase,
          }),
        },
      );

      const json = (await res.json()) as { body?: string; error?: string };

      if (!res.ok || !json.body) {
        throw new Error(
          typeof json.error === "string"
            ? json.error
            : "No se pudo generar la plantilla",
        );
      }

      setPreview(json.body);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Error al generar la plantilla";
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  }

  function handleUseTemplate() {
    if (!preview) return;
    onGenerated(preview);
    toast.success("Plantilla aplicada al cuerpo del mensaje");
  }

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
        <p className="text-sm font-semibold text-foreground">Generar con IA</p>
      </div>

      {/* Description */}
      <div className="space-y-1.5">
        <Label
          htmlFor="ai-description"
          className="text-xs font-medium text-muted-foreground uppercase tracking-wide"
        >
          Objetivo de la plantilla
        </Label>
        <Textarea
          id="ai-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Ej: Recordatorio de cita médica para el día siguiente con dirección y hora"
          rows={2}
          className="resize-none text-sm"
          disabled={isLoading}
          aria-required="true"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        {/* Category */}
        <div className="space-y-1.5">
          <Label
            htmlFor="ai-category"
            className="text-xs font-medium text-muted-foreground uppercase tracking-wide"
          >
            Categoría
          </Label>
          <Select
            value={category}
            onValueChange={(v) => setCategory(v as TemplateCategory)}
            disabled={isLoading}
          >
            <SelectTrigger id="ai-category" className="h-9 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TEMPLATE_CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Use case */}
        <div className="space-y-1.5">
          <Label
            htmlFor="ai-use-case"
            className="text-xs font-medium text-muted-foreground uppercase tracking-wide"
          >
            Caso de uso
          </Label>
          <Select
            value={useCase}
            onValueChange={(v) => setUseCase(v as UseCase)}
            disabled={isLoading}
          >
            <SelectTrigger id="ai-use-case" className="h-9 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(USE_CASE_LABELS) as UseCase[]).map((u) => (
                <SelectItem key={u} value={u}>
                  {USE_CASE_LABELS[u]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Generate button */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleGenerate}
        disabled={isLoading || !description.trim()}
        aria-busy={isLoading}
        className="w-full gap-2"
      >
        <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
        {isLoading ? "Generando..." : "Generar plantilla"}
      </Button>

      {/* Loading skeleton */}
      {isLoading && (
        <div className="pt-1">
          <GeneratingSkeleton />
        </div>
      )}

      {/* Preview + apply */}
      {preview && !isLoading && (
        <div className="space-y-3 pt-1 border-t border-border">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Vista previa
            </p>
            <button
              type="button"
              onClick={handleGenerate}
              className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded"
              aria-label="Regenerar plantilla"
              disabled={isLoading}
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
          <div className="rounded-md bg-muted/40 border border-border px-3 py-2.5">
            <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
              {preview}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={handleUseTemplate}
            className="w-full"
          >
            Usar esta plantilla
          </Button>
        </div>
      )}
    </div>
  );
}
