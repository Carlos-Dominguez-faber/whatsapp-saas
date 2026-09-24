"use client";

import { useState, useEffect } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";

export interface N8nToolParamForm {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "enum";
  required: boolean;
  description: string;
  enum_options?: string[];
  sensitive?: boolean;
}

export interface N8nToolRowForm {
  id: string;
  name: string;
  description: string;
  mode: "sync" | "async";
  sensitivity: "read" | "write";
  webhook_url: string;
  auth_header_name: string | null;
  has_auth: boolean;
  parameters: N8nToolParamForm[];
  timeout_ms: number;
  enabled: boolean;
}

interface Props {
  workspaceId: string;
  tool?: N8nToolRowForm;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

// Must match the CHECK in supabase/migrations/20260830000000_n8n_tools.sql and
// the Zod schema in src/app/api/workspace/[id]/n8n-tools/**.
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 15000;
const DEFAULT_TIMEOUT_MS = 8000;

function emptyParam(): N8nToolParamForm {
  return { key: "", label: "", type: "string", required: true, description: "" };
}

export function N8nToolForm({ workspaceId, tool, open, onOpenChange, onSaved }: Props) {
  const isEdit = Boolean(tool);

  const [name, setName] = useState(tool?.name ?? "");
  const [description, setDescription] = useState(tool?.description ?? "");
  const [mode, setMode] = useState<"sync" | "async">(tool?.mode ?? "sync");
  const [sensitivity, setSensitivity] = useState<"read" | "write">(
    tool?.sensitivity ?? "read",
  );
  const [webhookUrl, setWebhookUrl] = useState(tool?.webhook_url ?? "");
  const [authHeaderName, setAuthHeaderName] = useState(tool?.auth_header_name ?? "");
  const [authHeaderValue, setAuthHeaderValue] = useState("");
  const [parameters, setParameters] = useState<N8nToolParamForm[]>(
    tool?.parameters ?? [],
  );
  // String, not number: an empty field must stay empty while typing instead of
  // snapping back to 0 (and canSubmit rejects anything outside the DB CHECK).
  const [timeoutMs, setTimeoutMs] = useState(String(tool?.timeout_ms ?? DEFAULT_TIMEOUT_MS));
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: sync form fields from props when the sheet opens
      setName(tool?.name ?? "");
      setDescription(tool?.description ?? "");
      setMode(tool?.mode ?? "sync");
      setSensitivity(tool?.sensitivity ?? "read");
      setWebhookUrl(tool?.webhook_url ?? "");
      setAuthHeaderName(tool?.auth_header_name ?? "");
      setAuthHeaderValue("");
      setParameters(tool?.parameters ?? []);
      setTimeoutMs(String(tool?.timeout_ms ?? DEFAULT_TIMEOUT_MS));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tool?.id]);

  const timeoutValue = Number(timeoutMs);
  const timeoutIsValid =
    Number.isInteger(timeoutValue) &&
    timeoutValue >= MIN_TIMEOUT_MS &&
    timeoutValue <= MAX_TIMEOUT_MS;

  const canSubmit =
    name.trim().length > 0 &&
    /^[a-zA-Z0-9_-]+$/.test(name.trim()) &&
    description.trim().length > 0 &&
    webhookUrl.trim().length > 0 &&
    timeoutIsValid &&
    parameters.every(
      (p) =>
        p.key.trim().length > 0 &&
        p.label.trim().length > 0 &&
        p.description.trim().length > 0 &&
        (p.type !== "enum" || (p.enum_options?.length ?? 0) > 0),
    );

  function addParam() {
    setParameters((prev) => [...prev, emptyParam()]);
  }

  function updateParam(index: number, patch: Partial<N8nToolParamForm>) {
    setParameters((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }

  function removeParam(index: number) {
    setParameters((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    setIsLoading(true);

    const body: Record<string, unknown> = {
      name: name.trim(),
      description: description.trim(),
      mode,
      sensitivity,
      webhook_url: webhookUrl.trim(),
      timeout_ms: timeoutValue,
      parameters: parameters.map((p) => ({
        key: p.key.trim(),
        label: p.label.trim(),
        type: p.type,
        required: p.required,
        description: p.description.trim(),
        ...(p.type === "enum" ? { enum_options: p.enum_options ?? [] } : {}),
        ...(p.sensitive ? { sensitive: true } : {}),
      })),
    };
    if (authHeaderName.trim()) body.auth_header_name = authHeaderName.trim();
    if (authHeaderValue.trim()) body.auth_header_value = authHeaderValue.trim();

    const url = isEdit
      ? `/api/workspace/${workspaceId}/n8n-tools/${tool!.id}`
      : `/api/workspace/${workspaceId}/n8n-tools`;

    const res = await fetch(url, {
      method: isEdit ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    setIsLoading(false);

    if (!res.ok) {
      const data = (await res.json()) as { error?: unknown };
      toast.error(
        typeof data.error === "string" ? data.error : "Error al guardar la herramienta",
      );
      return;
    }

    toast.success(isEdit ? "Herramienta actualizada" : "Herramienta creada");
    onSaved();
    onOpenChange(false);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader className="mb-6">
          <SheetTitle className="font-display">
            {isEdit ? "Editar herramienta n8n" : "Nueva herramienta n8n"}
          </SheetTitle>
          <SheetDescription>
            Conecta un workflow de n8n como herramienta que el agente puede invocar.
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="n8n-name">Nombre (identificador para el agente)</Label>
            <Input
              id="n8n-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ej. n8n_catalogo_productos"
              maxLength={60}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="n8n-description">Descripción (para el agente)</Label>
            <Textarea
              id="n8n-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Cuándo debe usar esta herramienta el agente"
              maxLength={500}
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="n8n-mode">Modo</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as "sync" | "async")}>
                <SelectTrigger id="n8n-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sync">Sincrónico (espera respuesta)</SelectItem>
                  <SelectItem value="async">Asíncrono (dispara y olvida)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="n8n-sensitivity">Tipo</Label>
              <Select
                value={sensitivity}
                onValueChange={(v) => setSensitivity(v as "read" | "write")}
              >
                <SelectTrigger id="n8n-sensitivity">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="read">Lectura (consulta)</SelectItem>
                  <SelectItem value="write">Escritura (acción)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="n8n-url">URL del webhook (HTTPS)</Label>
            <Input
              id="n8n-url"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://tu-n8n.com/webhook/..."
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="n8n-timeout">Timeout (ms)</Label>
            <Input
              id="n8n-timeout"
              type="number"
              className="sm:max-w-[12rem]"
              value={timeoutMs}
              onChange={(e) => setTimeoutMs(e.target.value)}
              min={MIN_TIMEOUT_MS}
              max={MAX_TIMEOUT_MS}
              step={500}
              required
            />
            <p className="text-xs text-muted-foreground">
              Cuánto espera el agente la respuesta del workflow, entre{" "}
              {MIN_TIMEOUT_MS} y {MAX_TIMEOUT_MS} ms (por defecto{" "}
              {DEFAULT_TIMEOUT_MS}).
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="n8n-auth-name">Header de autenticación (opcional)</Label>
              <Input
                id="n8n-auth-name"
                value={authHeaderName}
                onChange={(e) => setAuthHeaderName(e.target.value)}
                placeholder="Authorization"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="n8n-auth-value">
                Valor {isEdit && tool?.has_auth ? "(dejar vacío para no cambiarlo)" : ""}
              </Label>
              <Input
                id="n8n-auth-value"
                type="password"
                value={authHeaderValue}
                onChange={(e) => setAuthHeaderValue(e.target.value)}
                placeholder={isEdit && tool?.has_auth ? "••••••••" : "Bearer ..."}
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Parámetros que llena el agente</Label>
              <Button type="button" variant="outline" size="sm" onClick={addParam}>
                <Plus className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
                Agregar
              </Button>
            </div>

            {parameters.map((param, i) => (
              <div key={i} className="rounded-md border border-border p-3 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    value={param.key}
                    onChange={(e) => updateParam(i, { key: e.target.value })}
                    placeholder="clave (ej. query)"
                    maxLength={60}
                  />
                  <Input
                    value={param.label}
                    onChange={(e) => updateParam(i, { label: e.target.value })}
                    placeholder="etiqueta visible"
                    maxLength={120}
                  />
                </div>
                <Input
                  value={param.description}
                  onChange={(e) => updateParam(i, { description: e.target.value })}
                  placeholder="descripción para el agente"
                  maxLength={500}
                />
                <div className="flex items-center gap-3">
                  <Select
                    value={param.type}
                    onValueChange={(v) =>
                      updateParam(i, { type: v as N8nToolParamForm["type"] })
                    }
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="string">Texto</SelectItem>
                      <SelectItem value="number">Número</SelectItem>
                      <SelectItem value="boolean">Booleano</SelectItem>
                      <SelectItem value="enum">Opciones</SelectItem>
                    </SelectContent>
                  </Select>

                  {param.type === "enum" && (
                    <Input
                      className="flex-1"
                      value={(param.enum_options ?? []).join(", ")}
                      onChange={(e) =>
                        updateParam(i, {
                          enum_options: e.target.value
                            .split(",")
                            .map((v) => v.trim())
                            .filter(Boolean),
                        })
                      }
                      placeholder="opción1, opción2, opción3"
                    />
                  )}

                  <div className="flex items-center gap-1.5">
                    <Switch
                      checked={param.required}
                      onCheckedChange={(v) => updateParam(i, { required: v })}
                      aria-label="Requerido"
                    />
                    <span className="text-xs text-muted-foreground">Requerido</span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <Switch
                      checked={Boolean(param.sensitive)}
                      onCheckedChange={(v) => updateParam(i, { sensitive: v })}
                      aria-label="Sensible"
                    />
                    <span className="text-xs text-muted-foreground">Sensible</span>
                  </div>

                  <button
                    type="button"
                    onClick={() => removeParam(i)}
                    className="ml-auto p-1.5 rounded text-muted-foreground hover:text-destructive"
                    aria-label="Eliminar parámetro"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-3 pt-2 border-t border-border">
            <Button type="submit" disabled={isLoading || !canSubmit} aria-busy={isLoading}>
              {isLoading ? "Guardando..." : isEdit ? "Guardar cambios" : "Crear herramienta"}
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
