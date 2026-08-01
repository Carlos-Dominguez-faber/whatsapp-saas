"use client";

import { useState, useCallback, useEffect } from "react";
import { toast } from "sonner";
import {
  Copy,
  CheckCircle2,
  Loader2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_HANDOFF_ACK } from "@/features/inbox/types/handoff";
import { ModelPicker } from "@/features/agents/components/model-picker";

// ─── Types ────────────────────────────────────────────────────────────────────

type Provider = "kapso" | "openrouter" | "highlevel";

type IntegrationData = {
  provider: Provider;
  enabled: boolean;
  credentials: Record<string, string>;
  oauth_tokens: Record<string, string>;
  config: Record<string, unknown>;
  // HighLevel-only: inbound contact-sync webhook token (low-sensitivity,
  // returned unmasked by the integrations GET so the UI can show the URL).
  highlevel_webhook_secret?: string;
  highlevel_webhook_url?: string;
};

// HighLevel pipeline + stages, as returned by the pipelines endpoint.
type HLPipelineOption = {
  id: string;
  name: string;
  stages: { id: string; name: string }[];
};

// Native <select> styling, matching the setter advanced-config selects.
const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findIntegration(
  integrations: IntegrationData[],
  provider: Provider,
): IntegrationData | undefined {
  return integrations.find((i) => i.provider === provider);
}

// ─── Section wrapper ──────────────────────────────────────────────────────────

function Section({
  title,
  description,
  defaultOpen = false,
  children,
}: {
  title: string;
  description: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-left"
        aria-expanded={open}
      >
        <div>
          <h2 className="font-display text-base font-medium text-foreground">
            {title}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        </div>
        {open ? (
          <ChevronDown
            className="h-4 w-4 text-muted-foreground shrink-0"
            aria-hidden
          />
        ) : (
          <ChevronRight
            className="h-4 w-4 text-muted-foreground shrink-0"
            aria-hidden
          />
        )}
      </button>

      {open && <div className="space-y-4 pt-2">{children}</div>}
    </div>
  );
}

// ─── Kapso section ───────────────────────────────────────────────────────────

function KapsoSection({
  workspaceId,
  initial,
  onSaved,
}: {
  workspaceId: string;
  initial: IntegrationData | undefined;
  onSaved: () => void;
}) {
  const [apiKey, setApiKey] = useState(
    initial?.credentials?.kapso_api_key ?? "",
  );
  const [phone, setPhone] = useState(
    (initial?.config?.phone_number as string | undefined) ?? "",
  );
  // Meta's phone number ID — this is what actually sends. The E.164 number
  // above is kept for display and the CRM only.
  const [phoneNumberId, setPhoneNumberId] = useState(
    (initial?.config?.phone_number_id as string | undefined) ?? "",
  );
  const [wabaId, setWabaId] = useState(
    (initial?.config?.waba_id as string | undefined) ?? "",
  );
  const [secret, setSecret] = useState(
    initial?.credentials?.webhook_signing_secret ?? "",
  );
  const [bufferSeconds, setBufferSeconds] = useState<number>(
    (initial?.config?.buffer_silence_seconds as number | undefined) ?? 30,
  );
  const [messagesInMemory, setMessagesInMemory] = useState<number>(
    (initial?.config?.message_history_window as number | undefined) ?? 10,
  );
  // Handoff acknowledgement: defaults to on, so a workspace that never opens
  // this screen still replies to the contact instead of going silent.
  const [handoffAckEnabled, setHandoffAckEnabled] = useState<boolean>(
    (initial?.config?.handoff_ack_enabled as boolean | undefined) !== false,
  );
  const [handoffAckMessage, setHandoffAckMessage] = useState<string>(
    (initial?.config?.handoff_ack_message as string | undefined) ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [copied, setCopied] = useState(false);

  const webhookUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/webhooks/kapso?wsid=${workspaceId}`
      : `/api/webhooks/kapso?wsid=${workspaceId}`;

  function handleCopy() {
    navigator.clipboard.writeText(webhookUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  async function handleTest() {
    setTesting(true);
    try {
      const res = await fetch(
        `/api/workspace/${workspaceId}/integrations/test`,
        {
          method: "POST",
        },
      );
      const json = (await res.json()) as {
        ok: boolean;
        error?: string;
        warning?: string;
        phoneNumbers?: Array<{
          phone_number_id?: string;
          waba_id?: string;
          display_phone_number?: string | null;
        }>;
      };
      if (json.ok) {
        // Kapso has no balance endpoint; the test lists the project's numbers
        // and confirms the configured phone_number_id is one of them.
        const first = json.phoneNumbers?.[0];
        toast.success(
          `Kapso conectado${
            first?.display_phone_number ? ` — ${first.display_phone_number}` : ""
          }`,
        );
        if (json.warning) toast.warning(json.warning);
      } else {
        // A failed test still returns the project's numbers — offer to fill in
        // the right IDs rather than making them be hunted down by hand.
        const first = json.phoneNumbers?.[0];
        if (first?.phone_number_id && !phoneNumberId) {
          setPhoneNumberId(first.phone_number_id);
          if (first.waba_id && !wabaId) setWabaId(first.waba_id);
          toast.info("Rellené los IDs con el número del proyecto — revisa y guarda");
        }
        toast.error(json.error ?? "Error al probar la conexión");
      }
    } catch {
      toast.error("Error de red al probar la conexión");
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/integrations`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "kapso",
          credentials: {
            kapso_api_key: apiKey,
            webhook_signing_secret: secret,
          },
          config: {
            phone_number: phone,
            phone_number_id: phoneNumberId.trim(),
            waba_id: wabaId.trim(),
            buffer_silence_seconds: bufferSeconds,
            message_history_window: messagesInMemory,
            handoff_ack_enabled: handoffAckEnabled,
            handoff_ack_message: handoffAckMessage.trim(),
          },
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (json.ok) {
        toast.success("Configuración de Kapso guardada");
        onSaved();
      } else {
        toast.error(json.error ?? "Error al guardar");
      }
    } catch {
      toast.error("Error de red al guardar");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      title="Kapso (WhatsApp)"
      description="Conecta tu número de WhatsApp Business a través de Kapso."
      defaultOpen
    >
      <div className="grid gap-4">
        <div className="space-y-2">
          <Label htmlFor="kapso-api-key">API Key</Label>
          <Input
            id="kapso-api-key"
            type="password"
            placeholder="kapso_..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="kapso-phone">Número de WhatsApp (E.164)</Label>
          <Input
            id="kapso-phone"
            type="tel"
            placeholder="+521234567890"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="kapso-phone-number-id">Phone Number ID (Meta)</Label>
          <Input
            id="kapso-phone-number-id"
            inputMode="numeric"
            placeholder="123456789012345"
            value={phoneNumberId}
            onChange={(e) => setPhoneNumberId(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            El ID numérico del número en Meta, no el número en sí. Sin esto no
            se puede enviar ningún mensaje. Lo encuentras en el dashboard de
            Kapso.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="kapso-waba-id">WABA ID</Label>
          <Input
            id="kapso-waba-id"
            inputMode="numeric"
            placeholder="123456789012345"
            value={wabaId}
            onChange={(e) => setWabaId(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            ID de la cuenta de WhatsApp Business. Necesario para las plantillas
            y para probar la conexión.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="kapso-secret">Webhook Signing Secret</Label>
          <Input
            id="kapso-secret"
            type="password"
            placeholder="whsec_..."
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="off"
          />
        </div>

        <div className="space-y-2">
          <Label>Webhook URL</Label>
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={webhookUrl}
              className="font-mono text-xs text-muted-foreground"
              aria-label="Webhook URL (solo lectura)"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCopy}
              aria-label="Copiar URL del webhook"
            >
              {copied ? (
                <CheckCircle2 className="h-4 w-4 text-green-500" aria-hidden />
              ) : (
                <Copy className="h-4 w-4" aria-hidden />
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Pega esta URL en la configuración de webhooks de Kapso.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="kapso-buffer">
            Tiempo de espera del buffer (segundos)
          </Label>
          <Input
            id="kapso-buffer"
            type="number"
            min={3}
            max={120}
            step={1}
            value={bufferSeconds}
            onChange={(e) =>
              setBufferSeconds(
                Math.min(120, Math.max(3, Number(e.target.value) || 30)),
              )
            }
          />
          <p className="text-xs text-muted-foreground">
            La IA espera este tiempo de silencio tras el último mensaje antes de
            responder, para agrupar mensajes seguidos. Por defecto 30s.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="kapso-memory">Mensajes en memoria de la IA</Label>
          <Input
            id="kapso-memory"
            type="number"
            min={5}
            max={50}
            step={1}
            value={messagesInMemory}
            onChange={(e) =>
              setMessagesInMemory(
                Math.min(50, Math.max(5, Number(e.target.value) || 10)),
              )
            }
          />
          <p className="text-xs text-muted-foreground">
            Cuántos mensajes recientes recuerda la IA al responder (entre 5 y
            50). Por defecto 10.
          </p>
        </div>

        <div className="space-y-2 border-t border-border/60 pt-4">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="kapso-handoff-ack">
              Avisar al contacto cuando pasa a un humano
            </Label>
            <Switch
              id="kapso-handoff-ack"
              checked={handoffAckEnabled}
              onCheckedChange={setHandoffAckEnabled}
            />
          </div>
          <Textarea
            id="kapso-handoff-ack-message"
            rows={2}
            maxLength={500}
            disabled={!handoffAckEnabled}
            placeholder={DEFAULT_HANDOFF_ACK}
            value={handoffAckMessage}
            onChange={(e) => setHandoffAckMessage(e.target.value)}
            aria-label="Mensaje de aviso al contacto"
          />
          <p className="text-xs text-muted-foreground">
            Se envía en cuanto la conversación queda en espera de un asesor, para
            que el contacto no se quede sin respuesta. Si lo dejas vacío se usa:
            “{DEFAULT_HANDOFF_ACK}”
          </p>
        </div>

        <div className="flex items-center gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleTest}
            disabled={testing}
            aria-busy={testing}
          >
            {testing && (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden />
            )}
            Probar conexión
          </Button>

          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            disabled={saving}
            aria-busy={saving}
          >
            {saving && (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden />
            )}
            Guardar
          </Button>
        </div>
      </div>
    </Section>
  );
}

// ─── OpenRouter section ───────────────────────────────────────────────────────

function OpenRouterSection({
  workspaceId,
  initial,
  onSaved,
}: {
  workspaceId: string;
  initial: IntegrationData | undefined;
  onSaved: () => void;
}) {
  const [apiKey, setApiKey] = useState(
    initial?.credentials?.openrouter_api_key ?? "",
  );
  const [model, setModel] = useState(
    (initial?.config?.default_model as string | undefined) ??
      "anthropic/claude-sonnet-4.6",
  );
  const [fallbackModel, setFallbackModel] = useState(
    (initial?.config?.fallback_model as string | undefined) ?? "",
  );
  const [dailyBudget, setDailyBudget] = useState<number>(
    (initial?.config?.daily_budget_tokens as number | undefined) ?? 1_000_000,
  );
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/integrations`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "openrouter",
          credentials: { openrouter_api_key: apiKey },
          config: {
            default_model: model,
            fallback_model: fallbackModel,
            daily_budget_tokens: dailyBudget,
          },
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (json.ok) {
        toast.success("Configuración de OpenRouter guardada");
        onSaved();
      } else {
        toast.error(json.error ?? "Error al guardar");
      }
    } catch {
      toast.error("Error de red al guardar");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      title="OpenRouter"
      description="Gateway de modelos de lenguaje. Requerido para el agente de IA."
    >
      <div className="grid gap-4">
        <div className="space-y-2">
          <Label htmlFor="or-api-key">API Key</Label>
          <Input
            id="or-api-key"
            type="password"
            placeholder="sk-or-..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
          />
        </div>

        <div className="space-y-2">
          <Label>Modelo por defecto (fallback del workspace)</Label>
          <ModelPicker
            value={model}
            onChange={setModel}
            emptyHint="Modelo que se usa cuando un agente no define el suyo."
          />
        </div>

        <div className="space-y-2">
          <Label>Modelo de respaldo</Label>
          <ModelPicker
            value={fallbackModel || null}
            onChange={setFallbackModel}
            emptyHint="Opcional. Se usa si el modelo principal falla."
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="or-budget">Budget diario (tokens)</Label>
          <Input
            id="or-budget"
            type="number"
            min={0}
            step={100000}
            value={dailyBudget}
            onChange={(e) => setDailyBudget(Number(e.target.value))}
          />
          <p className="text-xs text-muted-foreground">
            El agente se detendrá cuando alcance este límite diario de tokens.
          </p>
        </div>

        <div className="pt-2">
          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            disabled={saving}
            aria-busy={saving}
          >
            {saving && (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden />
            )}
            Guardar
          </Button>
        </div>
      </div>
    </Section>
  );
}

// ─── HighLevel section ────────────────────────────────────────────────────────

function HighLevelSection({
  workspaceId,
  initial,
  onSaved,
}: {
  workspaceId: string;
  initial: IntegrationData | undefined;
  onSaved: () => void;
}) {
  const [pit, setPit] = useState(initial?.credentials?.highlevel_pit ?? "");
  const [locationId, setLocationId] = useState(
    (initial?.config?.location_id as string | undefined) ?? "",
  );
  const [calendarId, setCalendarId] = useState(
    (initial?.config?.calendar_id as string | undefined) ?? "",
  );
  const [pipelineId, setPipelineId] = useState(
    (initial?.config?.pipeline_id as string | undefined) ?? "",
  );
  const [stageId, setStageId] = useState(
    (initial?.config?.pipeline_stage_id as string | undefined) ?? "",
  );
  const isConnected = Boolean(
    initial?.credentials?.highlevel_pit && initial?.config?.location_id,
  );
  const [pipelines, setPipelines] = useState<HLPipelineOption[]>([]);
  // Seed the loading flag from isConnected so the mount fetch doesn't flash the
  // empty state before the effect runs.
  const [loadingPipelines, setLoadingPipelines] = useState(isConnected);
  const [pipelinesError, setPipelinesError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const loadPipelines = useCallback(async () => {
    setLoadingPipelines(true);
    setPipelinesError(null);
    try {
      const res = await fetch(
        `/api/workspace/${workspaceId}/integrations/highlevel/pipelines`,
      );
      const json = (await res.json()) as {
        ok: boolean;
        error?: string;
        pipelines?: HLPipelineOption[];
      };
      if (json.ok && json.pipelines) {
        setPipelines(json.pipelines);
      } else {
        setPipelinesError(json.error ?? "No se pudieron cargar los pipelines");
      }
    } catch {
      setPipelinesError("Error de red al cargar los pipelines");
    } finally {
      setLoadingPipelines(false);
    }
  }, [workspaceId]);

  // Auto-load pipelines on mount when HighLevel is already connected.
  useEffect(() => {
    if (!isConnected) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: loadPipelines resets loading/error before each (re)fetch
    loadPipelines();
  }, [isConnected, loadPipelines]);

  const selectedPipeline = pipelines.find((p) => p.id === pipelineId);
  const stages = selectedPipeline?.stages ?? [];

  function handlePipelineChange(nextPipelineId: string) {
    setPipelineId(nextPipelineId);
    // Reset the stage when it doesn't belong to the newly selected pipeline.
    const next = pipelines.find((p) => p.id === nextPipelineId);
    if (!next?.stages.some((s) => s.id === stageId)) {
      setStageId(next?.stages[0]?.id ?? "");
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/integrations`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "highlevel",
          enabled: true,
          credentials: { highlevel_pit: pit },
          config: {
            location_id: locationId,
            calendar_id: calendarId,
            pipeline_id: pipelineId,
            pipeline_stage_id: stageId,
          },
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (json.ok) {
        toast.success("Configuración de HighLevel guardada");
        onSaved();
        // Refresh pipelines in case the PIT/Location just changed.
        void loadPipelines();
      } else {
        toast.error(json.error ?? "Error al guardar");
      }
    } catch {
      toast.error("Error de red al guardar");
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    try {
      const res = await fetch(
        `/api/workspace/${workspaceId}/integrations/highlevel/test`,
        { method: "POST" },
      );
      const json = (await res.json()) as {
        ok: boolean;
        error?: string;
        locationName?: string | null;
        hasCalendar?: boolean;
      };
      if (json.ok) {
        const loc = json.locationName ? ` — ${json.locationName}` : "";
        const cal = json.hasCalendar ? "" : " (falta Calendar ID para agendar)";
        toast.success(`HighLevel conectado${loc}${cal}`);
      } else {
        toast.error(json.error ?? "Error al probar la conexión");
      }
    } catch {
      toast.error("Error de red al probar la conexión");
    } finally {
      setTesting(false);
    }
  }

  return (
    <Section
      title="HighLevel"
      description="Conecta tu CRM con un Private Integration Token (PIT). Requerido para sincronizar contactos y agendar en el calendario."
    >
      <div className="grid gap-4">
        <div className="space-y-2">
          <Label htmlFor="hl-pit">Private Integration Token (PIT)</Label>
          <Input
            id="hl-pit"
            type="password"
            placeholder="pit-..."
            value={pit}
            onChange={(e) => setPit(e.target.value)}
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            GHL → Settings → Private Integrations → crea un token con permisos
            de contactos y calendarios.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="hl-location">Location ID</Label>
          <Input
            id="hl-location"
            placeholder="bfilCH1kUaWjdh22WREh"
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            className="font-mono text-sm"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="hl-calendar">Calendar ID</Label>
          <Input
            id="hl-calendar"
            placeholder="ID del calendario donde se agendan las citas"
            value={calendarId}
            onChange={(e) => setCalendarId(e.target.value)}
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            GHL → Calendars → el calendario → Settings. Necesario para que el
            agente reserve citas.
          </p>
        </div>

        <Separator />

        <div className="space-y-3">
          <div>
            <Label>Pipeline de oportunidades (modo setter)</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Cuando un lead califica con la acción “Crear oportunidad en HL”,
              se crea en este pipeline y etapa.
            </p>
          </div>

          {loadingPipelines ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Cargando pipelines…
            </div>
          ) : pipelinesError ? (
            <div className="space-y-2">
              <p className="text-sm text-destructive">{pipelinesError}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void loadPipelines()}
              >
                Reintentar
              </Button>
            </div>
          ) : pipelines.length === 0 ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Guarda tu PIT y Location ID, luego carga los pipelines de tu
                cuenta de HighLevel.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void loadPipelines()}
              >
                Cargar pipelines
              </Button>
            </div>
          ) : (
            <div className="grid gap-4">
              <div className="space-y-2">
                <Label htmlFor="hl-pipeline">Pipeline</Label>
                <select
                  id="hl-pipeline"
                  value={pipelineId}
                  onChange={(e) => handlePipelineChange(e.target.value)}
                  className={SELECT_CLASS}
                >
                  <option value="">— Selecciona un pipeline —</option>
                  {pipelines.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="hl-stage">Etapa</Label>
                <select
                  id="hl-stage"
                  value={stageId}
                  onChange={(e) => setStageId(e.target.value)}
                  disabled={!selectedPipeline}
                  className={SELECT_CLASS}
                >
                  <option value="">— Selecciona una etapa —</option>
                  {stages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleTest}
            disabled={testing}
            aria-busy={testing}
          >
            {testing && (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden />
            )}
            Probar conexión
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            disabled={saving}
            aria-busy={saving}
          >
            {saving && (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden />
            )}
            Guardar
          </Button>
        </div>
      </div>
    </Section>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
  workspaceId: string;
  initialIntegrations: unknown[];
}

export function IntegrationsTab({ workspaceId, initialIntegrations }: Props) {
  const [integrations, setIntegrations] = useState<IntegrationData[]>(
    initialIntegrations as IntegrationData[],
  );

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/integrations`);
      const json = (await res.json()) as { integrations?: IntegrationData[] };
      if (json.integrations) setIntegrations(json.integrations);
    } catch {
      // Non-critical — stale data is fine after save
    }
  }, [workspaceId]);

  const kapso = findIntegration(integrations, "kapso");
  const openrouter = findIntegration(integrations, "openrouter");
  const highlevel = findIntegration(integrations, "highlevel");

  return (
    <div className="space-y-6">
      <KapsoSection
        workspaceId={workspaceId}
        initial={kapso}
        onSaved={refresh}
      />
      <Separator />
      <OpenRouterSection
        workspaceId={workspaceId}
        initial={openrouter}
        onSaved={refresh}
      />
      <Separator />
      <HighLevelSection
        workspaceId={workspaceId}
        initial={highlevel}
        onSaved={refresh}
      />
    </div>
  );
}
