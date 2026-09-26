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
import {
  describeKapsoNumber,
  e164FromDisplay,
  KapsoNumberSelect,
  WhatsAppProviderPicker,
  WHATSAPP_LABEL,
  type KapsoNumberOption,
  type WhatsAppProviderId,
} from "./whatsapp-provider-picker";

// ─── Types ────────────────────────────────────────────────────────────────────

type Provider = "ycloud" | "kapso" | "openrouter" | "highlevel";

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

// ─── WhatsApp section (provider per workspace: YCloud or Kapso) ───────────────

function WhatsAppSection({
  workspaceId,
  ycloud,
  kapso,
  onSaved,
}: {
  workspaceId: string;
  ycloud: IntegrationData | undefined;
  kapso: IntegrationData | undefined;
  onSaved: () => void;
}) {
  // The provider this workspace talks through today (at most one is enabled).
  const active: WhatsAppProviderId | null = kapso?.enabled
    ? "kapso"
    : ycloud?.enabled
      ? "ycloud"
      : null;
  const [selected, setSelected] = useState<WhatsAppProviderId>(
    active ?? (kapso && !ycloud ? "kapso" : "ycloud"),
  );
  // Workspace-level settings live in the active row (the server carries them
  // over when the provider changes).
  const settings = (active === "kapso" ? kapso : ycloud)?.config ?? {};

  // YCloud credentials
  const [ycApiKey, setYcApiKey] = useState(
    ycloud?.credentials?.ycloud_api_key ?? "",
  );
  const [ycPhone, setYcPhone] = useState(
    (ycloud?.config?.phone_number as string | undefined) ?? "",
  );
  const [ycSecret, setYcSecret] = useState(
    ycloud?.credentials?.webhook_signing_secret ?? "",
  );
  // Kapso credentials — Kapso sends by Meta's phone_number_id (the E.164
  // number is kept for display and the CRM) and needs the WABA id for
  // templates.
  const [kpApiKey, setKpApiKey] = useState(
    kapso?.credentials?.kapso_api_key ?? "",
  );
  const [kpPhone, setKpPhone] = useState(
    (kapso?.config?.phone_number as string | undefined) ?? "",
  );
  const [kpPhoneNumberId, setKpPhoneNumberId] = useState(
    (kapso?.config?.phone_number_id as string | undefined) ?? "",
  );
  const [kpWabaId, setKpWabaId] = useState(
    (kapso?.config?.waba_id as string | undefined) ?? "",
  );
  const [kpSecret, setKpSecret] = useState(
    kapso?.credentials?.webhook_signing_secret ?? "",
  );

  const [bufferSeconds, setBufferSeconds] = useState<number>(
    (settings.buffer_silence_seconds as number | undefined) ?? 30,
  );
  const [messagesInMemory, setMessagesInMemory] = useState<number>(
    (settings.message_history_window as number | undefined) ?? 10,
  );
  // Handoff acknowledgement: defaults to on, so a workspace that never opens
  // this screen still replies to the contact instead of going silent.
  const [handoffAckEnabled, setHandoffAckEnabled] = useState<boolean>(
    (settings.handoff_ack_enabled as boolean | undefined) !== false,
  );
  const [handoffAckMessage, setHandoffAckMessage] = useState<string>(
    (settings.handoff_ack_message as string | undefined) ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [copied, setCopied] = useState(false);
  // Kapso numbers to choose from, when a test with a typed key found several.
  const [kapsoChoices, setKapsoChoices] = useState<KapsoNumberOption[]>([]);

  const label = WHATSAPP_LABEL[selected];
  const webhookPath = `/api/webhooks/${selected}?wsid=${workspaceId}`;
  const webhookUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}${webhookPath}`
      : webhookPath;
  const switching = active !== null && active !== selected;

  // Same rule as the server (422): without key, secret and sender id the
  // provider cannot talk. "••••••" means stored, which counts.
  const missing = (
    selected === "kapso"
      ? [
          [kpApiKey, "la API Key"],
          [kpSecret, "el Webhook Signing Secret"],
          [kpPhoneNumberId, "el Phone Number ID"],
        ]
      : [
          [ycApiKey, "la API Key"],
          [ycSecret, "el Webhook Signing Secret"],
          [ycPhone, "el número de WhatsApp"],
        ]
  )
    .filter(([value]) => !value.trim())
    .map(([, what]) => what);

  function pickKapsoNumber(n: KapsoNumberOption, how: "filled" | "picked") {
    setKpPhoneNumberId(n.phone_number_id ?? "");
    setKpWabaId(n.waba_id ?? "");
    const e164 = e164FromDisplay(n.display_phone_number);
    if (e164) setKpPhone(e164);
    setKapsoChoices([]);
    toast.info(
      how === "filled"
        ? `Rellené los datos con ${describeKapsoNumber(n)} — revisa y guarda`
        : `Elegiste ${describeKapsoNumber(n)} — prueba la conexión y guarda`,
    );
  }

  function handleCopy() {
    navigator.clipboard.writeText(webhookUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  async function handleTest() {
    setTesting(true);
    try {
      // What is on screen, saved or not: the server falls back to the stored
      // value for anything masked ("••••••") or left out.
      const res = await fetch(
        `/api/workspace/${workspaceId}/integrations/test`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            selected === "kapso"
              ? {
                  provider: "kapso",
                  apiKey: kpApiKey,
                  config: {
                    phone_number_id: kpPhoneNumberId.trim(),
                    waba_id: kpWabaId.trim(),
                  },
                }
              : { provider: "ycloud", apiKey: ycApiKey },
          ),
        },
      );
      const json = (await res.json()) as {
        ok: boolean;
        error?: string;
        warnings?: string[];
        balance?: { balance?: unknown; currency?: unknown };
        phoneNumbers?: KapsoNumberOption[];
      };
      if (json.ok) {
        const detail =
          selected === "ycloud"
            ? json.balance
              ? ` — Saldo: ${json.balance.balance ?? "?"} ${json.balance.currency ?? ""}`
              : ""
            : json.phoneNumbers?.[0]
              ? ` — ${describeKapsoNumber(json.phoneNumbers[0])}`
              : "";
        setKapsoChoices([]);
        toast.success(`${label} conectado${detail}`);
        for (const warning of json.warnings ?? []) toast.warning(warning);
      } else {
        // Kapso with a typed key: a failed test lists the project's numbers
        // (connected production first). One and nothing filled in → fill it;
        // otherwise let them choose — never assume which client's number it is.
        const numbers = json.phoneNumbers ?? [];
        if (selected === "kapso" && numbers.length > 0) {
          if (numbers.length === 1 && !kpPhoneNumberId.trim()) {
            pickKapsoNumber(numbers[0], "filled");
          } else {
            setKapsoChoices(numbers);
          }
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
    const shared = {
      buffer_silence_seconds: bufferSeconds,
      message_history_window: messagesInMemory,
      handoff_ack_enabled: handoffAckEnabled,
      handoff_ack_message: handoffAckMessage.trim(),
    };
    const payload =
      selected === "kapso"
        ? {
            provider: "kapso",
            credentials: {
              kapso_api_key: kpApiKey,
              webhook_signing_secret: kpSecret,
            },
            config: {
              phone_number: kpPhone,
              phone_number_id: kpPhoneNumberId.trim(),
              waba_id: kpWabaId.trim(),
              ...shared,
            },
          }
        : {
            provider: "ycloud",
            credentials: {
              ycloud_api_key: ycApiKey,
              webhook_signing_secret: ycSecret,
            },
            config: { phone_number: ycPhone, ...shared },
          };
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/integrations`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        switchedFrom?: string;
      };
      if (json.ok) {
        toast.success(
          json.switchedFrom
            ? `Listo: este workspace ahora usa ${label}`
            : `Configuración de ${label} guardada`,
        );
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
      title="WhatsApp"
      description="Conecta tu número de WhatsApp Business con YCloud o con Kapso (Kapso funciona en Estados Unidos)."
      defaultOpen
    >
      <div className="grid gap-4">
        <div className="space-y-2">
          <Label id="whatsapp-provider-label">Proveedor</Label>
          <WhatsAppProviderPicker
            value={selected}
            onChange={setSelected}
            active={active}
            labelledBy="whatsapp-provider-label"
          />
          {switching && (
            <p className="text-xs text-amber-500">
              Al guardar, este workspace deja de usar {WHATSAPP_LABEL[active]} y
              pasa a {label}. La configuración de {WHATSAPP_LABEL[active]} queda
              guardada por si vuelves, y sus webhooks dejan de aceptarse: los
              mensajes que ya envió dejan de actualizar su estado (entregado,
              leído), y una respuesta que la IA esté preparando en ese momento
              sale por {label}. Prueba la conexión antes de guardar.
            </p>
          )}
        </div>

        {selected === "ycloud" ? (
          <>
            <div className="space-y-2">
              <Label htmlFor="ycloud-api-key">API Key</Label>
              <Input
                id="ycloud-api-key"
                type="password"
                placeholder="yk_..."
                value={ycApiKey}
                onChange={(e) => setYcApiKey(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ycloud-phone">Número de WhatsApp (E.164)</Label>
              <Input
                id="ycloud-phone"
                type="tel"
                placeholder="+521234567890"
                value={ycPhone}
                onChange={(e) => setYcPhone(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ycloud-secret">Webhook Signing Secret</Label>
              <Input
                id="ycloud-secret"
                type="password"
                placeholder="whsec_..."
                value={ycSecret}
                onChange={(e) => setYcSecret(e.target.value)}
                autoComplete="off"
              />
            </div>
          </>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="kapso-api-key">API Key</Label>
              <Input
                id="kapso-api-key"
                type="password"
                placeholder="kapso_..."
                value={kpApiKey}
                onChange={(e) => {
                  setKpApiKey(e.target.value);
                  setKapsoChoices([]);
                }}
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="kapso-phone">Número de WhatsApp (E.164)</Label>
              <Input
                id="kapso-phone"
                type="tel"
                placeholder="+15551234567"
                value={kpPhone}
                onChange={(e) => setKpPhone(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="kapso-phone-number-id">Phone Number ID (Meta)</Label>
              <Input
                id="kapso-phone-number-id"
                inputMode="numeric"
                placeholder="123456789012345"
                value={kpPhoneNumberId}
                onChange={(e) => setKpPhoneNumberId(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                El ID numérico del número en Meta, no el número en sí. Sin esto
                no se puede enviar ningún mensaje. Lo encuentras en el dashboard
                de Kapso, o escribe la API Key y prueba la conexión para elegirlo.
              </p>
            </div>
            {kapsoChoices.length > 0 && (
              <KapsoNumberSelect
                id="kapso-number-choice"
                numbers={kapsoChoices}
                value={kpPhoneNumberId}
                onPick={(n) => pickKapsoNumber(n, "picked")}
              />
            )}
            <div className="space-y-2">
              <Label htmlFor="kapso-waba-id">WABA ID</Label>
              <Input
                id="kapso-waba-id"
                inputMode="numeric"
                placeholder="123456789012345"
                value={kpWabaId}
                onChange={(e) => setKpWabaId(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                ID de la cuenta de WhatsApp Business. Necesario para las
                plantillas.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="kapso-secret">Webhook Signing Secret</Label>
              <Input
                id="kapso-secret"
                type="password"
                placeholder="whsec_..."
                value={kpSecret}
                onChange={(e) => setKpSecret(e.target.value)}
                autoComplete="off"
              />
            </div>
          </>
        )}

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
            Pega esta URL en la configuración de webhooks de {label}.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="whatsapp-buffer">
            Tiempo de espera del buffer (segundos)
          </Label>
          <Input
            id="whatsapp-buffer"
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
          <Label htmlFor="whatsapp-memory">Mensajes en memoria de la IA</Label>
          <Input
            id="whatsapp-memory"
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
            <Label htmlFor="whatsapp-handoff-ack">
              Avisar al contacto cuando pasa a un humano
            </Label>
            <Switch
              id="whatsapp-handoff-ack"
              checked={handoffAckEnabled}
              onCheckedChange={setHandoffAckEnabled}
            />
          </div>
          <Textarea
            id="whatsapp-handoff-ack-message"
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
            disabled={saving || missing.length > 0}
            aria-busy={saving}
            aria-describedby={missing.length > 0 ? "whatsapp-missing" : undefined}
          >
            {saving && (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden />
            )}
            {switching ? `Guardar y cambiar a ${label}` : "Guardar"}
          </Button>
        </div>
        {missing.length > 0 && (
          <p id="whatsapp-missing" className="text-xs text-muted-foreground">
            Para guardar {label} falta {missing.join(", ")}.
          </p>
        )}
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

  const ycloud = findIntegration(integrations, "ycloud");
  const kapso = findIntegration(integrations, "kapso");
  const openrouter = findIntegration(integrations, "openrouter");
  const highlevel = findIntegration(integrations, "highlevel");

  return (
    <div className="space-y-6">
      <WhatsAppSection
        // Remount when the active provider changes so the form reloads it.
        key={`${ycloud?.enabled ?? "-"}:${kapso?.enabled ?? "-"}`}
        workspaceId={workspaceId}
        ycloud={ycloud}
        kapso={kapso}
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
