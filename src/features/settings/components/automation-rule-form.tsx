"use client";

import { useState, useEffect } from "react";
import { X, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  saveAutomationRule,
  type AutomationRule,
  type TriggerType,
  type ActionType,
} from "../services/automation-actions";
import type { TemplateRow } from "@/features/inbox/services/templates";
import {
  EXECUTABLE_TRIGGER_TYPES,
  TEMPLATE_VARIABLES,
  AutomationRuleInputSchema,
  firstErrorMessage,
} from "@/features/automations/lib/rule-schema";

// ── Constants ─────────────────────────────────────────────────────────────────

const TRIGGER_LABELS: Record<TriggerType, string> = {
  first_message: "Primer mensaje del contacto",
  inactivity_24h: "Sin respuesta en 24h",
  window_closing: "Ventana de 24h cerrando (2h restantes)",
  handoff_requested: "IA solicita handoff",
  lead_qualified: "Lead calificado",
  keyword_match: "Palabra clave detectada",
  appointment_upcoming: "Cita próxima",
};

const ACTION_LABELS: Record<ActionType, string> = {
  send_template: "Enviar template",
  assign_agent: "Asignar a un miembro del equipo",
  add_tag: "Agregar etiqueta",
  close_conversation: "Cerrar conversación",
  handoff_human: "Transferir a humano",
};

const VARIABLE_LABELS: Record<string, string> = {
  "{{contact.name}}": "Nombre del contacto",
  "{{contact.phone}}": "Teléfono del contacto",
  "{{appointment.date}}": "Fecha de la cita",
  "{{appointment.time}}": "Hora de la cita",
  "{{business.name}}": "Nombre del negocio",
};

// Los marcadores que se ofrecen en el formulario. Los de cita existen en el
// schema pero no se ofrecen todavía: fuera de un run de appointment_upcoming
// resuelven a vacío, y ofrecerlos sería ofrecer un campo en blanco.
const OFFERED_VARIABLES = TEMPLATE_VARIABLES.filter(
  (v) => !v.startsWith("{{appointment."),
);

interface TeamMember {
  user_id: string;
  email: string;
  full_name: string | null;
  is_active: boolean;
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  workspaceId: string;
  rule?: AutomationRule;
  templates: TemplateRow[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function AutomationRuleForm({
  workspaceId,
  rule,
  templates,
  open,
  onOpenChange,
  onSaved,
}: Props) {
  const isEdit = Boolean(rule);
  const approvedTemplates = templates.filter((t) => t.status === "approved");

  const [name, setName] = useState(rule?.name ?? "");
  const [triggerType, setTriggerType] = useState<TriggerType>(
    rule?.trigger_type ?? "first_message",
  );
  const [actionType, setActionType] = useState<ActionType>(
    rule?.action_type ?? "send_template",
  );
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [keywords, setKeywords] = useState<string>(
    Array.isArray(rule?.trigger_config?.keywords)
      ? (rule.trigger_config.keywords as string[]).join(", ")
      : "",
  );
  const [hoursBefore, setHoursBefore] = useState<string>(
    typeof rule?.trigger_config?.hours_before === "number"
      ? String(rule.trigger_config.hours_before)
      : "",
  );
  const [quietStart, setQuietStart] = useState<string>(
    typeof rule?.trigger_config?.quiet_start === "number"
      ? String(rule.trigger_config.quiet_start)
      : "8",
  );
  const [quietEnd, setQuietEnd] = useState<string>(
    typeof rule?.trigger_config?.quiet_end === "number"
      ? String(rule.trigger_config.quiet_end)
      : "22",
  );
  const [selectedTemplate, setSelectedTemplate] = useState<string>(
    typeof rule?.action_config?.template_name === "string"
      ? rule.action_config.template_name
      : "",
  );
  const [tagName, setTagName] = useState<string>(
    typeof rule?.action_config?.tag === "string" ? rule.action_config.tag : "",
  );
  const [assignedUserId, setAssignedUserId] = useState<string>(
    typeof rule?.action_config?.user_id === "string"
      ? rule.action_config.user_id
      : "",
  );
  const [variables, setVariables] = useState<string[]>(
    Array.isArray(rule?.action_config?.variables)
      ? (rule.action_config.variables as string[])
      : [],
  );
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [membersLoaded, setMembersLoaded] = useState(false);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Reset state when the sheet opens for a different rule
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: sync form fields from props when the sheet opens
      setName(rule?.name ?? "");
      setTriggerType(rule?.trigger_type ?? "first_message");
      setActionType(rule?.action_type ?? "send_template");
      setEnabled(rule?.enabled ?? true);
      setKeywords(
        Array.isArray(rule?.trigger_config?.keywords)
          ? (rule.trigger_config.keywords as string[]).join(", ")
          : "",
      );
      setHoursBefore(
        typeof rule?.trigger_config?.hours_before === "number"
          ? String(rule.trigger_config.hours_before)
          : "",
      );
      setQuietStart(
        typeof rule?.trigger_config?.quiet_start === "number"
          ? String(rule.trigger_config.quiet_start)
          : "8",
      );
      setQuietEnd(
        typeof rule?.trigger_config?.quiet_end === "number"
          ? String(rule.trigger_config.quiet_end)
          : "22",
      );
      setSelectedTemplate(
        typeof rule?.action_config?.template_name === "string"
          ? rule.action_config.template_name
          : "",
      );
      setTagName(
        typeof rule?.action_config?.tag === "string"
          ? rule.action_config.tag
          : "",
      );
      setAssignedUserId(
        typeof rule?.action_config?.user_id === "string"
          ? rule.action_config.user_id
          : "",
      );
      setVariables(
        Array.isArray(rule?.action_config?.variables)
          ? (rule.action_config.variables as string[])
          : [],
      );
      setMembersLoaded(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rule?.id]);

  // Load the team roster lazily, only when assign_agent needs it
  useEffect(() => {
    if (!open || actionType !== "assign_agent") return;
    if (members.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: members already cached from a prior fetch, just flip the flag
      setMembersLoaded(true);
      return;
    }
    let cancelled = false;

    async function loadMembers() {
      try {
        const res = await fetch(`/api/workspace/${workspaceId}/team`);
        if (!res.ok) throw new Error("team");
        const json = (await res.json()) as { members?: TeamMember[] };
        if (cancelled) return;
        setMembers((json.members ?? []).filter((m) => m.is_active));
        setMembersLoaded(true);
        setOptionsError(null);
      } catch {
        if (!cancelled) {
          setOptionsError(
            "No se pudo cargar el equipo. Revisa tu conexión y vuelve a intentar.",
          );
        }
      }
    }

    void loadMembers();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, actionType, workspaceId]);

  // ── Derived ──────────────────────────────────────────────────────────────────

  const nameError =
    name.length > 0 && name.trim().length === 0
      ? "El nombre no puede estar vacío"
      : null;

  const assignedMemberInactive =
    actionType === "assign_agent" &&
    assignedUserId.length > 0 &&
    membersLoaded &&
    !members.some((m) => m.user_id === assignedUserId);

  const hoursBeforeNum = Number(hoursBefore);
  const hoursBeforeError =
    triggerType !== "appointment_upcoming"
      ? null
      : hoursBefore.trim() === "" ||
          !Number.isInteger(hoursBeforeNum) ||
          hoursBeforeNum < 1 ||
          hoursBeforeNum > 168
        ? "La anticipación debe ser un número entero entre 1 y 168 horas"
        : null;

  const quietStartNum = Number(quietStart);
  const quietEndNum = Number(quietEnd);
  const quietRangeError =
    triggerType !== "appointment_upcoming"
      ? null
      : !Number.isInteger(quietStartNum) ||
          quietStartNum < 0 ||
          quietStartNum > 23 ||
          !Number.isInteger(quietEndNum) ||
          quietEndNum < 0 ||
          quietEndNum > 23
        ? "La ventana horaria debe estar entre 0 y 23"
        : quietStartNum >= quietEndNum
          ? "La hora de inicio debe ser anterior a la de término"
          : null;

  const canSubmit =
    name.trim().length > 0 &&
    !nameError &&
    (triggerType !== "keyword_match" || keywords.trim().length > 0) &&
    (triggerType !== "appointment_upcoming" ||
      (!hoursBeforeError && !quietRangeError)) &&
    (actionType !== "send_template" || selectedTemplate.length > 0) &&
    (actionType !== "add_tag" || tagName.trim().length > 0) &&
    (actionType !== "assign_agent" || assignedUserId.length > 0) &&
    !assignedMemberInactive;

  // ── Build configs ─────────────────────────────────────────────────────────

  function buildTriggerConfig(): Record<string, unknown> {
    if (triggerType === "keyword_match") {
      return {
        keywords: keywords
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean),
      };
    }
    if (triggerType === "appointment_upcoming") {
      return {
        hours_before: hoursBeforeNum,
        quiet_start: quietStartNum,
        quiet_end: quietEndNum,
      };
    }
    return {};
  }

  function buildActionConfig(): Record<string, unknown> {
    switch (actionType) {
      case "send_template":
        return {
          template_name: selectedTemplate,
          ...(variables.length > 0 ? { variables } : {}),
        };
      case "add_tag":
        return { tag: tagName.trim() };
      case "assign_agent":
        return { user_id: assignedUserId };
      default:
        return {};
    }
  }

  // ── Submit ────────────────────────────────────────────────────────────────

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    const draft = {
      id: rule?.id ?? undefined,
      name: name.trim(),
      enabled,
      trigger_type: triggerType,
      trigger_config: buildTriggerConfig(),
      action_type: actionType,
      action_config: buildActionConfig(),
    };

    // Mismo schema que el servidor: el operador ve el error acá, en español,
    // antes de que viaje nada.
    const check = AutomationRuleInputSchema.safeParse(draft);
    if (!check.success) {
      toast.error(firstErrorMessage(check.error));
      return;
    }

    setIsLoading(true);
    const result = await saveAutomationRule(workspaceId, draft);
    setIsLoading(false);

    if (result.error) {
      toast.error(result.error);
      return;
    }

    toast.success(
      isEdit ? "Automatización actualizada" : "Automatización creada",
    );
    onSaved();
    onOpenChange(false);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader className="mb-6">
          <SheetTitle className="font-display">
            {isEdit ? "Editar automatización" : "Nueva automatización"}
          </SheetTitle>
          <SheetDescription>
            Define cuándo se activa y qué acción ejecuta automáticamente.
          </SheetDescription>
        </SheetHeader>

        {optionsError && (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {optionsError}
          </p>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Name */}
          <div className="space-y-1.5">
            <Label
              htmlFor="rule-name"
              className="text-sm font-medium text-foreground"
            >
              Nombre de la regla
            </Label>
            <Input
              id="rule-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ej. Bienvenida a nuevos contactos"
              maxLength={120}
              required
              className={cn(
                nameError
                  ? "border-destructive focus-visible:ring-destructive/30"
                  : "",
              )}
              aria-describedby={nameError ? "name-error" : undefined}
            />
            {nameError && (
              <p
                id="name-error"
                className="text-xs text-destructive flex items-center gap-1"
              >
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                {nameError}
              </p>
            )}
          </div>

          {/* Trigger */}
          <div className="space-y-1.5">
            <Label
              htmlFor="rule-trigger"
              className="text-sm font-medium text-foreground"
            >
              Disparador
            </Label>
            <Select
              value={triggerType}
              onValueChange={(v) => setTriggerType(v as TriggerType)}
            >
              <SelectTrigger id="rule-trigger">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXECUTABLE_TRIGGER_TYPES.map((key) => (
                  <SelectItem key={key} value={key}>
                    {TRIGGER_LABELS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Keyword input — only shown for keyword_match */}
            {triggerType === "keyword_match" && (
              <div className="pt-1 space-y-1.5">
                <Label
                  htmlFor="rule-keywords"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Palabras clave{" "}
                  <span className="font-normal">(separadas por coma)</span>
                </Label>
                <Input
                  id="rule-keywords"
                  value={keywords}
                  onChange={(e) => setKeywords(e.target.value)}
                  placeholder="ej. precio, info, cotización"
                  className="h-8 text-sm"
                  aria-required="true"
                />
              </div>
            )}

            {/* Appointment reminder inputs — only shown for appointment_upcoming */}
            {triggerType === "appointment_upcoming" && (
              <div className="pt-1 space-y-3">
                <div className="space-y-1.5">
                  <Label
                    htmlFor="rule-hours-before"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    Anticipación (horas antes de la cita)
                  </Label>
                  <Input
                    id="rule-hours-before"
                    type="number"
                    min={1}
                    max={168}
                    value={hoursBefore}
                    onChange={(e) => setHoursBefore(e.target.value)}
                    placeholder="ej. 24"
                    className="h-8 text-sm"
                    aria-required="true"
                    aria-describedby={
                      hoursBeforeError ? "hours-before-error" : undefined
                    }
                  />
                  {hoursBeforeError && (
                    <p
                      id="hours-before-error"
                      className="text-xs text-destructive flex items-center gap-1"
                    >
                      <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                      {hoursBeforeError}
                    </p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-muted-foreground">
                    Ventana horaria en que se puede enviar
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={0}
                      max={23}
                      value={quietStart}
                      onChange={(e) => setQuietStart(e.target.value)}
                      aria-label="Hora de inicio de la ventana"
                      className="h-8 text-sm"
                    />
                    <span className="text-xs text-muted-foreground">a</span>
                    <Input
                      type="number"
                      min={0}
                      max={23}
                      value={quietEnd}
                      onChange={(e) => setQuietEnd(e.target.value)}
                      aria-label="Hora de fin de la ventana"
                      className="h-8 text-sm"
                    />
                  </div>
                  {quietRangeError && (
                    <p className="text-xs text-destructive flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                      {quietRangeError}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Action */}
          <div className="space-y-1.5">
            <Label
              htmlFor="rule-action"
              className="text-sm font-medium text-foreground"
            >
              Acción
            </Label>
            <Select
              value={actionType}
              onValueChange={(v) => setActionType(v as ActionType)}
            >
              <SelectTrigger id="rule-action">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(ACTION_LABELS) as ActionType[]).map((key) => (
                  <SelectItem key={key} value={key}>
                    {ACTION_LABELS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Template selector */}
            {actionType === "send_template" && (
              <div className="pt-1 space-y-1.5">
                <Label
                  htmlFor="rule-template"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Template aprobado
                </Label>
                {approvedTemplates.length === 0 ? (
                  <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning flex items-center gap-1.5">
                    <AlertTriangle
                      className="h-3.5 w-3.5 shrink-0"
                      aria-hidden="true"
                    />
                    No hay templates aprobados por Meta. Sincroniza plantillas
                    primero.
                  </p>
                ) : (
                  <Select
                    value={selectedTemplate}
                    onValueChange={setSelectedTemplate}
                  >
                    <SelectTrigger id="rule-template">
                      <SelectValue placeholder="Selecciona un template" />
                    </SelectTrigger>
                    <SelectContent>
                      {approvedTemplates.map((t) => (
                        <SelectItem key={t.id} value={t.name}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}

                <div className="pt-2 space-y-1.5">
                  <Label className="text-xs font-medium text-muted-foreground">
                    Variables del mensaje (en orden)
                  </Label>
                  {variables.map((value, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <Select
                        value={value}
                        onValueChange={(v) =>
                          setVariables((prev) =>
                            prev.map((item, i) => (i === index ? v : item)),
                          )
                        }
                      >
                        <SelectTrigger
                          aria-label={`Variable ${index + 1}`}
                          className="h-8 text-sm"
                        >
                          <SelectValue placeholder="Elige un dato" />
                        </SelectTrigger>
                        <SelectContent>
                          {OFFERED_VARIABLES.map((marker) => (
                            <SelectItem key={marker} value={marker}>
                              {VARIABLE_LABELS[marker]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Quitar la variable ${index + 1}`}
                        onClick={() =>
                          setVariables((prev) => prev.filter((_, i) => i !== index))
                        }
                      >
                        <X className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-8 text-xs"
                    disabled={variables.length >= 10}
                    onClick={() =>
                      setVariables((prev) => [...prev, OFFERED_VARIABLES[0]])
                    }
                  >
                    Agregar variable
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Van en el mismo orden que los {"{{1}}"} de tu plantilla.
                  </p>
                </div>
              </div>
            )}

            {/* Assign agent */}
            {actionType === "assign_agent" && (
              <div className="pt-1 space-y-1.5">
                <Label
                  htmlFor="rule-member"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Miembro del equipo
                </Label>
                {members.length === 0 ? (
                  <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                    Todavía no hay miembros activos en el equipo.
                  </p>
                ) : (
                  <Select value={assignedUserId} onValueChange={setAssignedUserId}>
                    <SelectTrigger id="rule-member">
                      <SelectValue placeholder="Selecciona un miembro" />
                    </SelectTrigger>
                    <SelectContent>
                      {members.map((m) => (
                        <SelectItem key={m.user_id} value={m.user_id}>
                          {m.full_name ?? m.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {assignedMemberInactive && (
                  <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                    El miembro asignado ya no está activo. Elige otro para
                    poder guardar.
                  </p>
                )}
              </div>
            )}

            {/* Tag input */}
            {actionType === "add_tag" && (
              <div className="pt-1 space-y-1.5">
                <Label
                  htmlFor="rule-tag"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Nombre de la etiqueta
                </Label>
                <Input
                  id="rule-tag"
                  value={tagName}
                  onChange={(e) => setTagName(e.target.value)}
                  placeholder="ej. interesado, por-agendar"
                  className="h-8 text-sm"
                  aria-required="true"
                />
              </div>
            )}
          </div>

          {/* Enabled toggle */}
          <div className="flex items-center justify-between rounded-lg border border-border bg-muted/20 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-foreground">Habilitada</p>
              <p className="text-xs text-muted-foreground">
                Las reglas deshabilitadas no se ejecutan
              </p>
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label="Habilitar automatización"
            />
          </div>

          {/* Keyword and close/handoff descriptions */}
          {(actionType === "close_conversation" ||
            actionType === "handoff_human") && (
            <p className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
              {actionType === "close_conversation"
                ? "La conversación se marcará como cerrada automáticamente cuando se cumpla el disparador."
                : "Se iniciará un handoff al equipo humano cuando se cumpla el disparador."}
            </p>
          )}

          {/* Actions */}
          <div className="flex items-center gap-3 pt-2 border-t border-border">
            <Button
              type="submit"
              disabled={isLoading || !canSubmit}
              aria-busy={isLoading}
            >
              {isLoading
                ? "Guardando..."
                : isEdit
                  ? "Guardar cambios"
                  : "Crear automatización"}
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
        </form>
      </SheetContent>
    </Sheet>
  );
}
