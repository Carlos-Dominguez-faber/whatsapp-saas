"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  TrendingUp,
  HeadphonesIcon,
  CalendarDays,
  Sparkles,
  ChevronRight,
  ChevronLeft,
  Loader2,
  CheckCircle2,
  Copy,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { completeOnboarding } from "../services/onboarding-actions";
import type { OnboardingInput } from "../services/onboarding-actions";

// ─── Types ────────────────────────────────────────────────────────────────────

type UseCase = "setter" | "soporte" | "agendamiento" | "general";

interface WizardState {
  useCase: UseCase | null;
  businessName: string;
  industry: string;
  description: string;
  kapsoApiKey: string;
  kapsoPhone: string;
  kapsoPhoneNumberId: string;
  kapsoWabaId: string;
  kapsoSigningSecret: string;
}

// ─── Use case cards data ──────────────────────────────────────────────────────

const USE_CASES: {
  id: UseCase;
  label: string;
  description: string;
  icon: React.ReactNode;
}[] = [
  {
    id: "setter",
    label: "Setter / Ventas",
    description: "Califica leads, agenda citas y cierra ventas por WhatsApp.",
    icon: <TrendingUp className="h-5 w-5" aria-hidden />,
  },
  {
    id: "soporte",
    label: "Soporte al cliente",
    description:
      "Resuelve dudas, gestiona tickets y escala a humanos cuando es necesario.",
    icon: <HeadphonesIcon className="h-5 w-5" aria-hidden />,
  },
  {
    id: "agendamiento",
    label: "Agendamiento",
    description:
      "Reserva y confirma citas de forma automática con tus clientes.",
    icon: <CalendarDays className="h-5 w-5" aria-hidden />,
  },
  {
    id: "general",
    label: "General",
    description:
      "Asistente virtual flexible para responder preguntas y dar información.",
    icon: <Sparkles className="h-5 w-5" aria-hidden />,
  },
];

// ─── Progress bar ─────────────────────────────────────────────────────────────

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-2 mb-8">
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          className={[
            "h-1.5 flex-1 rounded-full transition-colors duration-300",
            i < current
              ? "bg-primary"
              : i === current
                ? "bg-primary/60"
                : "bg-muted",
          ].join(" ")}
          aria-hidden
        />
      ))}
      <span className="text-xs text-muted-foreground whitespace-nowrap ml-2">
        {current + 1} / {total}
      </span>
    </div>
  );
}

// ─── Step 1 — Use case selection ──────────────────────────────────────────────

function Step1({
  selected,
  onSelect,
}: {
  selected: UseCase | null;
  onSelect: (id: UseCase) => void;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold text-foreground">
          ¿Para qué usarás el agente?
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Esto configurará el prompt inicial de tu asistente. Podrás modificarlo
          después.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {USE_CASES.map((uc) => (
          <button
            key={uc.id}
            type="button"
            onClick={() => onSelect(uc.id)}
            className={[
              "flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition-all",
              "hover:border-primary/60 hover:bg-primary/5",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected === uc.id
                ? "border-primary bg-primary/10 ring-1 ring-primary"
                : "border-border bg-card",
            ].join(" ")}
            aria-pressed={selected === uc.id}
          >
            <span
              className={[
                "flex h-9 w-9 items-center justify-center rounded-lg",
                selected === uc.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground",
              ].join(" ")}
            >
              {uc.icon}
            </span>
            <span className="font-medium text-foreground text-sm">
              {uc.label}
            </span>
            <span className="text-xs text-muted-foreground leading-relaxed">
              {uc.description}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Step 2 — Business info ───────────────────────────────────────────────────

function Step2({
  state,
  onChange,
}: {
  state: WizardState;
  onChange: (patch: Partial<WizardState>) => void;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold text-foreground">
          Información del negocio
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          El agente usará estos datos para presentarse y responder con contexto.
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="business-name">
            Nombre del negocio <span className="text-destructive">*</span>
          </Label>
          <Input
            id="business-name"
            placeholder="Clínica Sonrisa Perfecta"
            value={state.businessName}
            onChange={(e) => onChange({ businessName: e.target.value })}
            autoFocus
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="industry">Industria / Giro</Label>
          <Input
            id="industry"
            placeholder="Salud dental, E-commerce, Bienes raíces..."
            value={state.industry}
            onChange={(e) => onChange({ industry: e.target.value })}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="description">Descripción breve</Label>
          <Textarea
            id="description"
            placeholder="Somos una clínica dental en Cancún especializada en ortodoncia y estética dental..."
            value={state.description}
            onChange={(e) => onChange({ description: e.target.value })}
            rows={4}
          />
          <p className="text-xs text-muted-foreground">
            Esta descripción enriquece el prompt base del agente.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Step 3 — Kapso connection ───────────────────────────────────────────────

function Step3({
  state,
  onChange,
  isTesting,
  onTest,
}: {
  state: WizardState;
  onChange: (patch: Partial<WizardState>) => void;
  isTesting: boolean;
  onTest: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const webhookPlaceholder =
    "[Se generará al guardar — podrás copiarlo desde Configuración]";

  function handleCopy() {
    navigator.clipboard.writeText(webhookPlaceholder).catch(() => null);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold text-foreground">
          Conectar Kapso
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Opcional. Podrás configurar esto más tarde desde Configuración →
          Integraciones.
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="kapso-key">API Key Kapso</Label>
          <Input
            id="kapso-key"
            type="password"
            placeholder="kapso_..."
            value={state.kapsoApiKey}
            onChange={(e) => onChange({ kapsoApiKey: e.target.value })}
            autoComplete="off"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="kapso-phone">Número de WhatsApp (E.164)</Label>
          <Input
            id="kapso-phone"
            type="tel"
            placeholder="+521234567890"
            value={state.kapsoPhone}
            onChange={(e) => onChange({ kapsoPhone: e.target.value })}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="kapso-phone-number-id">Phone Number ID (Meta)</Label>
          <Input
            id="kapso-phone-number-id"
            inputMode="numeric"
            placeholder="123456789012345"
            value={state.kapsoPhoneNumberId}
            onChange={(e) => onChange({ kapsoPhoneNumberId: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Se llena solo al pulsar «Probar conexión». Es el ID numérico de Meta,
            no el número de teléfono.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="kapso-waba-id">WABA ID</Label>
          <Input
            id="kapso-waba-id"
            inputMode="numeric"
            placeholder="123456789012345"
            value={state.kapsoWabaId}
            onChange={(e) => onChange({ kapsoWabaId: e.target.value })}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="kapso-secret">Webhook Signing Secret</Label>
          <Input
            id="kapso-secret"
            type="password"
            placeholder="whsec_..."
            value={state.kapsoSigningSecret}
            onChange={(e) => onChange({ kapsoSigningSecret: e.target.value })}
            autoComplete="off"
          />
        </div>

        <div className="space-y-2">
          <Label>Webhook URL</Label>
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={webhookPlaceholder}
              className="font-mono text-xs text-muted-foreground"
              aria-label="Webhook URL — se generará al finalizar"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCopy}
              aria-label="Copiar texto"
            >
              {copied ? (
                <CheckCircle2 className="h-4 w-4 text-green-500" aria-hidden />
              ) : (
                <Copy className="h-4 w-4" aria-hidden />
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            La URL real se mostrará en Configuración → Integraciones una vez
            creado el workspace.
          </p>
        </div>

        {state.kapsoApiKey && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onTest}
            disabled={isTesting}
            aria-busy={isTesting}
          >
            {isTesting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden />
            ) : null}
            Probar conexión
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── Step 4 — Summary ─────────────────────────────────────────────────────────

function Step4({
  state,
  workspaceId,
}: {
  state: WizardState;
  workspaceId: string;
}) {
  const useCaseLabel =
    USE_CASES.find((u) => u.id === state.useCase)?.label ?? state.useCase ?? "";

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center text-center gap-3 py-4">
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
          <CheckCircle2 className="h-8 w-8 text-primary" aria-hidden />
        </span>
        <h1 className="font-display text-2xl font-semibold text-foreground">
          ¡Todo listo!
        </h1>
        <p className="text-sm text-muted-foreground max-w-sm">
          Tu workspace ha sido creado. Aquí un resumen de lo configurado.
        </p>
      </div>

      <div className="rounded-xl border border-border bg-card divide-y divide-border">
        <Row label="Negocio" value={state.businessName} />
        {state.industry && <Row label="Industria" value={state.industry} />}
        <Row label="Tipo de agente" value={useCaseLabel} />
        <Row label="Prompt inicial" value="Generado automáticamente" />
        {state.kapsoApiKey && (
          <Row label="Kapso" value="Credenciales guardadas" />
        )}
        <Row
          label="Webhook URL"
          value={`/api/webhooks/kapso?wsid=${workspaceId}`}
          mono
        />
      </div>

      <p className="text-xs text-muted-foreground text-center">
        Puedes ajustar todo esto en Configuración → Integraciones y
        Configuración → Prompt.
      </p>
    </div>
  );
}

function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <span
        className={[
          "text-xs text-right text-foreground",
          mono ? "font-mono" : "",
        ].join(" ")}
      >
        {value}
      </span>
    </div>
  );
}

// ─── Main wizard ──────────────────────────────────────────────────────────────

const TOTAL_STEPS = 4;

export function OnboardingWizard() {
  const router = useRouter();

  const [step, setStep] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [completedWorkspaceId, setCompletedWorkspaceId] = useState<
    string | null
  >(null);

  const [state, setState] = useState<WizardState>({
    useCase: null,
    businessName: "",
    industry: "",
    description: "",
    kapsoApiKey: "",
    kapsoPhone: "",
    kapsoPhoneNumberId: "",
    kapsoWabaId: "",
    kapsoSigningSecret: "",
  });

  function patch(update: Partial<WizardState>) {
    setState((prev) => ({ ...prev, ...update }));
  }

  function canAdvance(): boolean {
    if (step === 0) return state.useCase !== null;
    if (step === 1) return state.businessName.trim().length > 0;
    return true;
  }

  async function handleNext() {
    if (step === 2) {
      // Finalize — call server action
      await handleFinalize();
      return;
    }
    setStep((s) => Math.min(s + 1, TOTAL_STEPS - 1));
  }

  function handleBack() {
    setStep((s) => Math.max(s - 1, 0));
  }

  async function handleFinalize() {
    setIsSubmitting(true);
    try {
      const input: OnboardingInput = {
        useCase: state.useCase!,
        businessName: state.businessName.trim(),
        industry: state.industry.trim() || undefined,
        description: state.description.trim() || undefined,
        kapsoApiKey: state.kapsoApiKey.trim() || undefined,
        kapsoPhone: state.kapsoPhone.trim() || undefined,
        kapsoPhoneNumberId: state.kapsoPhoneNumberId.trim() || undefined,
        kapsoWabaId: state.kapsoWabaId.trim() || undefined,
        kapsoSigningSecret: state.kapsoSigningSecret.trim() || undefined,
      };

      const result = await completeOnboarding(input);

      if (result.error) {
        toast.error(result.error);
        return;
      }

      setCompletedWorkspaceId(result.workspaceId ?? null);
      setStep(3);
    } catch (err) {
      console.error("[OnboardingWizard] handleFinalize error:", err);
      toast.error("Error inesperado al crear el workspace");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleTestKapso() {
    if (!state.kapsoApiKey) return;
    setIsTesting(true);
    try {
      // Proxy through the server so the API key isn't exposed to the browser
      // and the request isn't CORS-blocked.
      const res = await fetch("/api/integrations/kapso/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: state.kapsoApiKey }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        phoneNumbers?: Array<{
          phone_number_id?: string;
          waba_id?: string;
          display_phone_number?: string | null;
        }>;
        error?: string;
      };
      if (json.ok) {
        // Kapso has no balance endpoint — success means the project's numbers
        // came back. Fill both IDs from the first (production) one so they are
        // never copied by hand: a mistyped phone_number_id breaks every send.
        const first = json.phoneNumbers?.[0];
        if (first?.phone_number_id) {
          patch({
            kapsoPhoneNumberId: first.phone_number_id,
            ...(first.waba_id ? { kapsoWabaId: first.waba_id } : {}),
          });
        }
        const extra = (json.phoneNumbers?.length ?? 0) - 1;
        toast.success(
          `Kapso conectado${
            first?.display_phone_number ? ` — ${first.display_phone_number}` : ""
          }${extra > 0 ? ` (+${extra} número${extra > 1 ? "s" : ""} más)` : ""}`,
        );
      } else {
        toast.error(json.error ?? "API Key inválida o sin acceso");
      }
    } catch {
      toast.error("No se pudo conectar con Kapso");
    } finally {
      setIsTesting(false);
    }
  }

  const isLastDataStep = step === 2;
  const isComplete = step === 3;

  return (
    <div className="w-full max-w-lg mx-auto">
      <StepIndicator current={step} total={TOTAL_STEPS} />

      {step === 0 && (
        <Step1
          selected={state.useCase}
          onSelect={(id) => patch({ useCase: id })}
        />
      )}
      {step === 1 && <Step2 state={state} onChange={patch} />}
      {step === 2 && (
        <Step3
          state={state}
          onChange={patch}
          isTesting={isTesting}
          onTest={handleTestKapso}
        />
      )}
      {step === 3 && completedWorkspaceId && (
        <Step4 state={state} workspaceId={completedWorkspaceId} />
      )}

      <div className="flex items-center justify-between mt-8">
        {step > 0 && !isComplete ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleBack}
            disabled={isSubmitting}
          >
            <ChevronLeft className="h-4 w-4 mr-1" aria-hidden />
            Atrás
          </Button>
        ) : (
          <div />
        )}

        {!isComplete ? (
          <Button
            type="button"
            onClick={handleNext}
            disabled={!canAdvance() || isSubmitting}
            aria-busy={isSubmitting}
          >
            {isSubmitting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden />
            ) : null}
            {isLastDataStep ? "Finalizar" : "Continuar"}
            {!isLastDataStep && !isSubmitting && (
              <ChevronRight className="h-4 w-4 ml-1" aria-hidden />
            )}
          </Button>
        ) : (
          <Button
            type="button"
            onClick={() => router.push("/inbox")}
            className="w-full sm:w-auto"
          >
            Ir al inbox
            <ChevronRight className="h-4 w-4 ml-1" aria-hidden />
          </Button>
        )}
      </div>
    </div>
  );
}
