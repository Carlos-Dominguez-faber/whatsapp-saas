"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Plus, Trash2, AlertTriangle, Info, Hash, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { TemplateRow } from "@/features/inbox/services/templates";
import {
  CATEGORY_LABELS,
  TEMPLATE_CATEGORIES,
  detectBodyVariables,
  normalizeCategory,
  type TemplateButton,
  type TemplateCategory,
  type TemplateVariable,
} from "@/features/settings/lib/template-form";
import { AiTemplateGenerator } from "./ai-template-generator";
import { WhatsAppPreview } from "./whatsapp-preview";

// ── Prefill (used by the Biblioteca tab) ────────────────────────────────────────

export interface TemplatePrefill {
  name?: string;
  category?: TemplateCategory;
  header_type?: "none" | "text";
  header_text?: string;
  body_template?: string;
  body_variables?: TemplateVariable[];
  footer_text?: string;
  buttons?: TemplateButton[];
}

const STANDARD_OPT_OUT = "Responde STOP para no recibir más mensajes";

const CATEGORY_HINT: Record<TemplateCategory, string> = {
  utility: "Aprobación rápida",
  marketing: "Requiere opt-in",
};

const QUICK_VARIABLES = [
  { label: "Nombre", example: "María" },
  { label: "Negocio", example: "Clínica Sonrisa" },
  { label: "Fecha", example: "martes 18 de junio" },
  { label: "Hora", example: "10:00 a. m." },
] as const;

type FormButton = TemplateButton & { _key: string };

function makeKey() {
  return Math.random().toString(36).slice(2, 9);
}

interface Props {
  workspaceId: string;
  template?: TemplateRow;
  prefill?: TemplatePrefill | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function TemplateFormSheet({
  workspaceId,
  template,
  prefill,
  open,
  onOpenChange,
  onSaved,
}: Props) {
  const isEdit = Boolean(template);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const [name, setName] = useState("");
  const [category, setCategory] = useState<TemplateCategory>("utility");
  const [headerType, setHeaderType] = useState<"none" | "text">("none");
  const [headerText, setHeaderText] = useState("");
  const [body, setBody] = useState("");
  const [bodyVariables, setBodyVariables] = useState<TemplateVariable[]>([]);
  const [footerText, setFooterText] = useState("");
  const [buttons, setButtons] = useState<FormButton[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // ── (Re)initialise when the sheet opens ──────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    /* eslint-disable react-hooks/set-state-in-effect -- sync form from props on open */
    if (template) {
      setName(template.name ?? "");
      // Las filas viejas del sync pueden traer la categoría en MAYÚSCULAS.
      setCategory(
        normalizeCategory(template.category) === "marketing"
          ? "marketing"
          : "utility",
      );
      setHeaderType(template.header_type === "text" ? "text" : "none");
      setHeaderText(template.header_text ?? "");
      setBody(template.body_template ?? "");
      setBodyVariables(
        Array.isArray(template.variables)
          ? (template.variables.filter(
              (v) => typeof v === "object" && v !== null && "index" in v,
            ) as TemplateVariable[])
          : [],
      );
      setFooterText(template.footer_text ?? "");
      setButtons(
        (Array.isArray(template.buttons) ? template.buttons : []).map((b) => ({
          ...(b as TemplateButton),
          _key: makeKey(),
        })),
      );
    } else {
      setName(prefill?.name ?? "");
      setCategory(prefill?.category ?? "utility");
      setHeaderType(prefill?.header_type ?? "none");
      setHeaderText(prefill?.header_text ?? "");
      setBody(prefill?.body_template ?? "");
      setBodyVariables(prefill?.body_variables ?? []);
      setFooterText(prefill?.footer_text ?? "");
      setButtons(
        (prefill?.buttons ?? []).map((b) => ({ ...b, _key: makeKey() })),
      );
    }
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, template?.id]);

  // ── Derived ──────────────────────────────────────────────────────────────────
  const nameError =
    name && !/^[a-z0-9_]+$/.test(name)
      ? "Solo minúsculas, números y guiones bajos. Sin espacios."
      : null;

  const detectedIndices = detectBodyVariables(body);
  const syncedVariables: TemplateVariable[] = detectedIndices.map((idx) => {
    const existing = bodyVariables.find((v) => v.index === idx);
    return existing ?? { index: idx, example: "" };
  });

  const cleanButtons: TemplateButton[] = buttons.map(
    ({ _key, ...rest }) => rest as TemplateButton,
  );

  // ── Body / variables ──────────────────────────────────────────────────────────
  const insertToken = useCallback(
    (token: string) => {
      const textarea = bodyRef.current;
      if (!textarea) {
        setBody((t) => t + token);
        return;
      }
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      setBody(body.slice(0, start) + token + body.slice(end));
      setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(start + token.length, start + token.length);
      }, 0);
    },
    [body],
  );

  function handleAddVariable(example = "") {
    const nextIdx =
      detectedIndices.length > 0 ? Math.max(...detectedIndices) + 1 : 1;
    setBodyVariables((prev) => [
      ...prev.filter((v) => v.index !== nextIdx),
      { index: nextIdx, example },
    ]);
    insertToken(`{{${nextIdx}}}`);
  }

  function handleRemoveVariable(idx: number) {
    setBody((t) => t.replace(new RegExp(`\\{\\{${idx}\\}\\}`, "g"), ""));
    setBodyVariables((prev) => prev.filter((v) => v.index !== idx));
  }

  function handleVariableExample(idx: number, example: string) {
    setBodyVariables((prev) => {
      const exists = prev.some((v) => v.index === idx);
      return exists
        ? prev.map((v) => (v.index === idx ? { ...v, example } : v))
        : [...prev, { index: idx, example }];
    });
  }

  // ── Buttons ───────────────────────────────────────────────────────────────────
  function addButton() {
    if (buttons.length >= 3) return;
    setButtons((prev) => [
      ...prev,
      { _key: makeKey(), type: "quick_reply", text: "" },
    ]);
  }

  function removeButton(key: string) {
    setButtons((prev) => prev.filter((b) => b._key !== key));
  }

  function updateButton(key: string, updates: Partial<FormButton>) {
    setButtons((prev) =>
      prev.map((b) => {
        if (b._key !== key) return b;
        if (updates.type && updates.type !== b.type) {
          if (updates.type === "quick_reply") {
            return { _key: b._key, type: "quick_reply", text: b.text };
          }
          return { _key: b._key, type: updates.type, text: b.text, value: "" };
        }
        return { ...b, ...updates } as FormButton;
      }),
    );
  }

  // ── AI generator ──────────────────────────────────────────────────────────────
  function handleAiGenerated(generatedBody: string) {
    setBody(generatedBody);
    const indices = detectBodyVariables(generatedBody);
    setBodyVariables((prev) =>
      indices.map(
        (idx) =>
          prev.find((v) => v.index === idx) ?? { index: idx, example: "" },
      ),
    );
  }

  // ── Submit (save draft) ─────────────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (nameError || !name || !body) return;
    setIsLoading(true);

    const payload = {
      name,
      language: "es" as const,
      category,
      header_type: headerType,
      header_text: headerType === "text" ? headerText : "",
      body_template: body,
      variables: syncedVariables,
      footer_text: footerText,
      buttons: cleanButtons,
    };

    try {
      const url = `/api/workspace/${workspaceId}/templates`;
      const method = isEdit ? "PATCH" : "POST";
      const reqBody = isEdit ? { id: template!.id, ...payload } : payload;

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
      });
      const json = (await res.json()) as { error?: unknown };
      if (!res.ok) {
        throw new Error(
          typeof json.error === "string" ? json.error : "Error al guardar",
        );
      }

      toast.success(isEdit ? "Plantilla actualizada" : "Borrador creado");
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error al guardar");
    } finally {
      setIsLoading(false);
    }
  }

  const canSave = Boolean(name) && Boolean(body) && !nameError && !isLoading;

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full overflow-y-auto sm:max-w-3xl lg:max-w-4xl"
      >
        <SheetHeader className="mb-6">
          <SheetTitle className="font-display">
            {isEdit ? "Editar plantilla" : "Nueva plantilla"}
          </SheetTitle>
          <SheetDescription>
            Se guarda como borrador. Envíala a aprobación desde la lista cuando
            esté lista.
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={handleSubmit}>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* ── Left: form ──────────────────────────────────────────────── */}
            <div className="space-y-5">
              {/* Name */}
              <div className="space-y-1.5">
                <Label
                  htmlFor="tpl-name"
                  className="text-sm font-medium text-foreground"
                >
                  Nombre{" "}
                  <span className="font-normal text-xs text-muted-foreground">
                    (minúsculas, números y guion bajo)
                  </span>
                </Label>
                <div className="relative">
                  <Input
                    id="tpl-name"
                    value={name}
                    onChange={(e) =>
                      setName(
                        e.target.value
                          .toLowerCase()
                          .replace(/[^a-z0-9_]/g, "_"),
                      )
                    }
                    placeholder="ej. recordatorio_cita"
                    maxLength={512}
                    required
                    className={cn(
                      "pr-12",
                      nameError &&
                        "border-destructive focus-visible:ring-destructive/30",
                    )}
                    aria-describedby={nameError ? "name-error" : undefined}
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs tabular-nums text-muted-foreground">
                    {name.length}
                  </span>
                </div>
                {nameError && (
                  <p
                    id="name-error"
                    className="flex items-center gap-1 text-xs text-destructive"
                  >
                    <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                    {nameError}
                  </p>
                )}
              </div>

              {/* Category */}
              <div className="space-y-2">
                <Label className="text-sm font-medium text-foreground">
                  Categoría
                </Label>
                <div className="grid grid-cols-2 gap-3">
                  {TEMPLATE_CATEGORIES.map((cat) => (
                    <label
                      key={cat}
                      className={cn(
                        "flex cursor-pointer flex-col gap-1.5 rounded-lg border p-3 transition-colors",
                        category === cat
                          ? "border-primary bg-primary/5"
                          : "border-border hover:border-border/80",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="tpl-category"
                          value={cat}
                          checked={category === cat}
                          onChange={() => setCategory(cat)}
                          className="accent-primary"
                        />
                        <span className="text-sm font-medium text-foreground">
                          {CATEGORY_LABELS[cat]}
                        </span>
                      </div>
                      <span
                        className={cn(
                          "w-fit rounded-full px-2 py-0.5 text-xs font-medium",
                          cat === "utility"
                            ? "bg-emerald-400/10 text-emerald-400"
                            : "bg-amber-400/10 text-amber-400",
                        )}
                      >
                        {CATEGORY_HINT[cat]}
                      </span>
                    </label>
                  ))}
                </div>
                {category === "marketing" && (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 py-2.5">
                    <Info
                      className="mt-0.5 h-4 w-4 shrink-0 text-amber-400"
                      aria-hidden="true"
                    />
                    <p className="text-xs leading-relaxed text-amber-300">
                      Las plantillas de marketing deben ofrecer una opción para
                      dejar de recibir mensajes (usa el pie estándar).
                    </p>
                  </div>
                )}
              </div>

              {/* Header */}
              <div className="space-y-2">
                <Label className="text-sm font-medium text-foreground">
                  Encabezado{" "}
                  <span className="font-normal text-xs text-muted-foreground">
                    (opcional, solo texto)
                  </span>
                </Label>
                <div className="flex gap-2">
                  {(["none", "text"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setHeaderType(t)}
                      className={cn(
                        "rounded-lg border px-3 py-1.5 text-sm transition-colors",
                        headerType === t
                          ? "border-primary bg-primary/5 text-foreground"
                          : "border-border text-muted-foreground hover:text-foreground",
                      )}
                      aria-pressed={headerType === t}
                    >
                      {t === "none" ? "Ninguno" : "Texto"}
                    </button>
                  ))}
                </div>
                {headerType === "text" && (
                  <div className="relative">
                    <Input
                      value={headerText}
                      onChange={(e) => setHeaderText(e.target.value)}
                      placeholder="Texto del encabezado"
                      maxLength={60}
                      className="pr-12"
                      aria-label="Texto del encabezado"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs tabular-nums text-muted-foreground">
                      {headerText.length}/60
                    </span>
                  </div>
                )}
              </div>

              {/* Body */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label
                    htmlFor="tpl-body"
                    className="text-sm font-medium text-foreground"
                  >
                    Cuerpo del mensaje
                  </Label>
                  {detectedIndices.length > 0 && (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Hash className="h-3 w-3" aria-hidden="true" />
                      {detectedIndices.length} variable
                      {detectedIndices.length !== 1 ? "s" : ""}
                    </span>
                  )}
                </div>
                <div className="relative">
                  <Textarea
                    id="tpl-body"
                    ref={bodyRef}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    placeholder={
                      "Hola {{1}}, tu cita del {{2}} está confirmada.\n\nResponde SI para confirmar o NO para reagendar."
                    }
                    rows={5}
                    maxLength={1024}
                    required
                    className="resize-none pr-2"
                    aria-label="Cuerpo del mensaje"
                  />
                  <span className="absolute bottom-2 right-3 text-xs tabular-nums text-muted-foreground">
                    {body.length}/1024
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => handleAddVariable()}
                  >
                    <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                    Agregar variable
                  </Button>
                  {QUICK_VARIABLES.map((v) => (
                    <Button
                      key={v.label}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8"
                      onClick={() => handleAddVariable(v.example)}
                    >
                      <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                      {v.label}
                    </Button>
                  ))}
                </div>

                {/* Variable examples */}
                {syncedVariables.length > 0 && (
                  <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Ejemplos de variables (requeridos por Meta)
                    </p>
                    {syncedVariables.map((v) => (
                      <div key={v.index} className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => insertToken(`{{${v.index}}}`)}
                          title={`Insertar {{${v.index}}}`}
                          className="w-14 shrink-0 rounded border border-border bg-muted px-1.5 py-1 text-center font-mono text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                        >
                          {`{{${v.index}}}`}
                        </button>
                        <Input
                          value={
                            bodyVariables.find((bv) => bv.index === v.index)
                              ?.example ?? ""
                          }
                          onChange={(e) =>
                            handleVariableExample(v.index, e.target.value)
                          }
                          placeholder={`Ejemplo para {{${v.index}}}`}
                          className="h-8 text-sm"
                          aria-label={`Ejemplo para variable ${v.index}`}
                        />
                        <button
                          type="button"
                          onClick={() => handleRemoveVariable(v.index)}
                          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-destructive"
                          aria-label={`Eliminar variable ${v.index}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="space-y-2">
                <Label className="text-sm font-medium text-foreground">
                  Pie{" "}
                  <span className="font-normal text-xs text-muted-foreground">
                    (opcional)
                  </span>
                </Label>
                <div className="relative">
                  <Input
                    value={footerText}
                    onChange={(e) => setFooterText(e.target.value)}
                    placeholder="Texto del pie"
                    maxLength={60}
                    className="pr-12"
                    aria-label="Texto del pie"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs tabular-nums text-muted-foreground">
                    {footerText.length}/60
                  </span>
                </div>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={footerText === STANDARD_OPT_OUT}
                    onChange={(e) =>
                      setFooterText(e.target.checked ? STANDARD_OPT_OUT : "")
                    }
                    className="accent-primary"
                  />
                  <span className="text-sm text-muted-foreground">
                    Usar pie estándar de baja (&quot;{STANDARD_OPT_OUT}&quot;)
                  </span>
                </label>
              </div>

              {/* Buttons */}
              <div className="space-y-2">
                <Label className="text-sm font-medium text-foreground">
                  Botones{" "}
                  <span className="font-normal text-xs text-muted-foreground">
                    (máx 3)
                  </span>
                </Label>
                {buttons.map((btn) => (
                  <div
                    key={btn._key}
                    className="space-y-2 rounded-lg border border-border bg-card p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <select
                        value={btn.type}
                        onChange={(e) =>
                          updateButton(btn._key, {
                            type: e.target.value as TemplateButton["type"],
                          })
                        }
                        className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                        aria-label="Tipo de botón"
                      >
                        <option value="quick_reply">Respuesta rápida</option>
                        <option value="url">URL</option>
                        <option value="phone">Teléfono</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => removeButton(btn._key)}
                        className="rounded p-1.5 text-muted-foreground transition-colors hover:text-destructive"
                        aria-label="Eliminar botón"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </div>
                    <Input
                      value={btn.text}
                      onChange={(e) =>
                        updateButton(btn._key, { text: e.target.value })
                      }
                      placeholder="Texto del botón"
                      maxLength={25}
                      aria-label="Texto del botón"
                    />
                    {btn.type === "url" && (
                      <Input
                        value={"value" in btn ? btn.value : ""}
                        onChange={(e) =>
                          updateButton(btn._key, { value: e.target.value })
                        }
                        placeholder="https://ejemplo.com"
                        type="url"
                        aria-label="URL del botón"
                      />
                    )}
                    {btn.type === "phone" && (
                      <Input
                        value={"value" in btn ? btn.value : ""}
                        onChange={(e) =>
                          updateButton(btn._key, { value: e.target.value })
                        }
                        placeholder="+52 55 1234 5678"
                        type="tel"
                        aria-label="Teléfono del botón"
                      />
                    )}
                  </div>
                ))}
                {buttons.length < 3 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addButton}
                  >
                    <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                    Agregar botón ({buttons.length}/3)
                  </Button>
                )}
              </div>

              {/* AI generator */}
              <AiTemplateGenerator
                workspaceId={workspaceId}
                onGenerated={handleAiGenerated}
              />

              {/* Actions */}
              <div className="flex items-center gap-3 border-t border-border pt-4">
                <Button type="submit" disabled={!canSave} aria-busy={isLoading}>
                  {isLoading
                    ? "Guardando…"
                    : isEdit
                      ? "Guardar cambios"
                      : "Crear borrador"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                  disabled={isLoading}
                >
                  Cancelar
                </Button>
              </div>
            </div>

            {/* ── Right: preview ──────────────────────────────────────────── */}
            <div>
              <WhatsAppPreview
                businessName=""
                headerType={headerType}
                headerText={headerType === "text" ? headerText : ""}
                bodyText={body}
                footerText={footerText}
                buttons={cleanButtons}
                variables={syncedVariables}
              />
              <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Send className="h-3 w-3" aria-hidden="true" />
                Tras guardar, envíala a aprobación desde la lista. Meta tarda
                24–48 h.
              </p>
            </div>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
