"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, Send } from "lucide-react";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  getApprovedTemplates,
  sendTemplateAction,
} from "../services/template-actions";
import type { TemplateRow } from "../services/templates";

// This component takes a conversationId and NOTHING that names a workspace.
// That absence is the lock: the server actions resolve the workspace from the
// conversation themselves. If a `workspaceId` prop ever comes back here, the
// cross-tenant template hole (AVISO-SEGURIDAD-PLANTILLAS) comes back with it.
interface TemplatePickerProps {
  conversationId: string;
  onSent?: () => void;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function extractVariableCount(body: string): number {
  const matches = body.matchAll(/\{\{(\d+)\}\}/g);
  const seen = new Set<string>();
  for (const m of matches) {
    if (m[1]) seen.add(m[1]);
  }
  return seen.size;
}

function fillPreview(body: string, variables: string[]): string {
  let result = body;
  variables.forEach((value, index) => {
    result = result.replaceAll(`{{${index + 1}}}`, value || `...`);
  });
  return result;
}

// ── component ─────────────────────────────────────────────────────────────────

export function TemplatePicker({
  conversationId,
  onSent,
}: TemplatePickerProps) {
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateRow | null>(
    null,
  );
  const [variables, setVariables] = useState<string[]>([]);
  const [isPending, setIsPending] = useState(false);

  // Load on mount
  useEffect(() => {
    // `isLoading` is initialized to true; the fetch clears it in finally.
    let cancelled = false;
    getApprovedTemplates(conversationId)
      .then((rows) => {
        if (!cancelled) setTemplates(rows);
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  function handleSelectTemplate(template: TemplateRow) {
    const count = extractVariableCount(template.body_template);
    setSelectedTemplate(template);
    setVariables(Array.from({ length: count }, () => ""));
  }

  function handleBack() {
    setSelectedTemplate(null);
    setVariables([]);
  }

  function handleVariableChange(index: number, value: string) {
    setVariables((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  }

  async function handleSend() {
    if (!selectedTemplate) return;
    setIsPending(true);
    try {
      const result = await sendTemplateAction(
        conversationId,
        selectedTemplate.name,
        selectedTemplate.language,
        variables,
      );
      if (result.ok) {
        toast.success("Template enviado");
        setSelectedTemplate(null);
        setVariables([]);
        onSent?.();
      } else {
        toast.error(result.error ?? "Error al enviar el template");
      }
    } catch {
      toast.error("Error inesperado al enviar el template");
    } finally {
      setIsPending(false);
    }
  }

  // ── loading ────────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div
        className="space-y-2 p-1"
        aria-busy="true"
        aria-label="Cargando templates"
      >
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-12 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  // ── empty ──────────────────────────────────────────────────────────────────
  if (!isLoading && templates.length === 0) {
    return (
      <p className="py-3 text-center text-sm text-muted-foreground">
        Sin templates aprobados
      </p>
    );
  }

  // ── variable inputs ────────────────────────────────────────────────────────
  if (selectedTemplate) {
    const preview = fillPreview(selectedTemplate.body_template, variables);

    return (
      <div className="space-y-3">
        {/* Back + heading */}
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleBack}
            aria-label="Volver a lista de templates"
            className="h-7 w-7 shrink-0"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
          <p className="font-display text-sm font-semibold text-foreground truncate">
            {selectedTemplate.name}
          </p>
        </div>

        {/* Body preview */}
        <div className="rounded-lg bg-muted/50 border border-border/50 px-3 py-2 text-sm text-muted-foreground whitespace-pre-wrap">
          {preview}
        </div>

        {/* Variable inputs */}
        {variables.length > 0 && (
          <div className="space-y-2">
            {variables.map((value, index) => (
              <div key={index} className="space-y-1">
                <Label
                  htmlFor={`tpl-var-${index}`}
                  className="text-xs text-muted-foreground"
                >
                  Variable {`{{${index + 1}}}`}
                </Label>
                <Input
                  id={`tpl-var-${index}`}
                  value={value}
                  onChange={(e) => handleVariableChange(index, e.target.value)}
                  placeholder="Valor..."
                  className="h-8 text-sm"
                  disabled={isPending}
                />
              </div>
            ))}
          </div>
        )}

        {/* Send button */}
        <Button
          type="button"
          variant="default"
          className="w-full"
          onClick={handleSend}
          disabled={isPending}
          aria-busy={isPending}
        >
          <Send className="h-4 w-4 mr-2" aria-hidden="true" />
          {isPending ? "Enviando..." : "Enviar template"}
        </Button>
      </div>
    );
  }

  // ── template list ──────────────────────────────────────────────────────────
  return (
    <ScrollArea className="max-h-48">
      <div className="space-y-1 pr-1">
        {templates.map((template) => (
          <button
            key={template.id}
            type="button"
            onClick={() => handleSelectTemplate(template)}
            className={cn(
              "w-full text-left rounded-lg px-3 py-2 cursor-pointer",
              "bg-muted/50 hover:bg-muted transition-colors duration-150",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <div className="flex items-center justify-between gap-2 min-w-0">
              <span className="text-sm font-medium text-foreground truncate">
                {template.name}
              </span>
              <div className="flex items-center gap-1.5 shrink-0">
                <Badge
                  variant="outline"
                  className="text-[10px] px-1.5 py-0 font-mono"
                >
                  {template.language}
                </Badge>
                <Badge
                  variant="outline"
                  className="text-[10px] px-1.5 py-0 border-success/40 text-success"
                >
                  aprobado
                </Badge>
              </div>
            </div>
          </button>
        ))}
      </div>
    </ScrollArea>
  );
}
