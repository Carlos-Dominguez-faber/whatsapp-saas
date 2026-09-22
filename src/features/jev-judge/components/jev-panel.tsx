"use client";

import { useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ruleCopy, type WithoutJevPreview } from "@/features/jev-judge/preview";
import { SAMPLE_MESSAGES } from "@/features/jev-judge/samples";
import type { JudgeView } from "@/features/jev-judge/schema";
import { JEV_USES_ON, type JevUses } from "@/features/jev-judge/uses";

interface JevPanelProps {
  workspaceId: string;
  initialEnabled: boolean;
  initialUses: JevUses;
  keyReady: boolean;
  judgmentsToday: number;
  canManage: boolean;
}

export interface JevSettings {
  enabled: boolean;
  uses: JevUses;
  keyReady: boolean;
  judgmentsToday: number;
}

const USES: Array<{ key: keyof JevUses; label: string; hint: string }> = [
  {
    key: "stage",
    label: "Etapa",
    hint: "El score mueve el contacto: interesado, calificado o perdido.",
  },
  {
    key: "reply",
    label: "Quién contesta",
    hint: "Noul decide si redacta la IA o pasa a una persona.",
  },
  {
    key: "optOut",
    label: "Baja",
    hint: "Si pide que dejen de escribirle, no se contesta y queda en perdido.",
  },
];

const DECISION_LABEL = {
  respond: "Contesta el redactor",
  handoff: "Pasa a una persona",
  abstain: "No contesta",
} as const;

export function JevPanel({
  workspaceId,
  initialEnabled,
  initialUses = JEV_USES_ON,
  keyReady,
  judgmentsToday,
  canManage,
}: JevPanelProps) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [uses, setUses] = useState<JevUses>(initialUses);
  const [saving, setSaving] = useState(false);
  const [text, setText] = useState(SAMPLE_MESSAGES[0]?.text ?? "");
  const [busy, setBusy] = useState(false);
  const [without, setWithout] = useState<WithoutJevPreview | null>(null);
  const [withJev, setWithJev] = useState<JudgeView | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean) {
    if (!canManage) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/jev`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast.error(json.error ?? "No se pudo guardar");
        return;
      }
      setEnabled(next);
      toast.success(next ? "Jev prendido para este workspace" : "Jev apagado");
    } catch {
      toast.error("Error de conexión");
    } finally {
      setSaving(false);
    }
  }

  async function saveUse(key: keyof JevUses, next: boolean) {
    if (!canManage) return;
    const previous = uses;
    setUses({ ...uses, [key]: next });
    setSaving(true);
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/jev`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: next }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) {
        setUses(previous);
        toast.error(json.error ?? "No se pudo guardar");
        return;
      }
    } catch {
      setUses(previous);
      toast.error("Error de conexión");
    } finally {
      setSaving(false);
    }
  }

  async function compare() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/jev/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const json = (await res.json()) as {
        without?: WithoutJevPreview;
        with?: JudgeView | null;
        error?: string | null;
      };
      if (json.without) setWithout(json.without);
      setWithJev(json.with ?? null);
      setError(json.error ?? null);
      if (!res.ok && !json.without) toast.error(json.error ?? "No se pudo comparar");
    } catch {
      toast.error("Error de conexión");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-5 rounded-lg border border-border/60 bg-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">Jev</h2>
          <p className="text-sm text-muted-foreground">
            {enabled
              ? "Jev juzga el texto. El código aplica solo los usos que dejaste prendidos."
              : "El CRM usa las reglas de hoy: keywords, rate limit y el redactor."}
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={toggle}
          disabled={!canManage || saving}
          aria-label="Prender o apagar Jev"
        />
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <StatusPill ok={keyReady} label={keyReady ? "Jev listo" : "Falta TYPESAFE_API_KEY"} />
        <StatusPill ok={enabled} label={enabled ? "Prendido en WhatsApp" : "Apagado en WhatsApp"} />
        <span className="rounded-full border border-border px-2 py-1 text-muted-foreground">
          Hoy: {judgmentsToday} juicios
        </span>
      </div>

      <div className="space-y-3 border-t border-border/60 pt-4">
        <div className="space-y-1">
          <p className="text-sm font-medium">Para qué usar Jev</p>
          <p className="text-xs text-muted-foreground">
            Jev siempre clasifica igual. Estos switches dicen qué escribe el código.
          </p>
        </div>
        {USES.map((use) => (
          <UseSwitch
            key={use.key}
            label={use.label}
            hint={use.hint}
            checked={uses[use.key]}
            disabled={!canManage || saving}
            onCheckedChange={(next) => void saveUse(use.key, next)}
          />
        ))}
      </div>

      {!canManage && (
        <p className="text-xs text-muted-foreground">
          Solo un admin o manager puede prender Jev o comparar mensajes.
        </p>
      )}

      <div className="space-y-2">
        <Label htmlFor="jev-bench-text">Probar un mensaje</Label>
        <div className="flex flex-wrap gap-2">
          {SAMPLE_MESSAGES.map((sample) => (
            <Button
              key={sample.id}
              type="button"
              size="sm"
              variant={text === sample.text ? "default" : "outline"}
              onClick={() => setText(sample.text)}
            >
              {sample.label}
            </Button>
          ))}
        </div>
        <Textarea
          id="jev-bench-text"
          rows={3}
          maxLength={2000}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          La comparación no escribe el CRM ni manda WhatsApp. En un mensaje real,
          si pide un humano por keyword, Jev no llega a correr.
        </p>
        <Button type="button" size="sm" onClick={compare} disabled={!canManage || busy || !text.trim()}>
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
          {busy ? "Comparando" : "Comparar"}
        </Button>
      </div>

      {(without || withJev || error) && (
        <div className="grid gap-3 md:grid-cols-2">
          <ResultCard title="Sin Jev">
            {without ? <WithoutBody result={without} /> : <p className="text-sm text-muted-foreground">Sin resultado.</p>}
          </ResultCard>
          <ResultCard title="Con Jev">
            {withJev ? <WithBody result={withJev} /> : <p className="text-sm text-muted-foreground">{error ?? "Sin resultado."}</p>}
          </ResultCard>
        </div>
      )}
    </section>
  );
}

function UseSwitch({
  label,
  hint,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-0.5">
        <Label className="text-sm">{label}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-label={label}
      />
    </div>
  );
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`rounded-full border px-2 py-1 ${
        ok
          ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
          : "border-border text-muted-foreground"
      }`}
    >
      {label}
    </span>
  );
}

function ResultCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2 rounded-md border border-border/60 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

function WithoutBody({ result }: { result: WithoutJevPreview }) {
  return (
    <>
      <p className="text-sm font-medium">{DECISION_LABEL[result.decision]}</p>
      <p className="text-xs text-muted-foreground">
        {result.reason === "keyword"
          ? "Una frase de humano dispara el handoff antes de cualquier modelo."
          : "No hay keyword. El redactor contestaría."}
      </p>
    </>
  );
}

function WithBody({ result }: { result: JudgeView }) {
  return (
    <>
      <p className="text-sm font-medium">{DECISION_LABEL[result.decision]}</p>
      <p className="text-xs text-muted-foreground">{ruleCopy(result.rule)}</p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <Stat label="Choice" value={`${result.action} · ${pct(result.actionConfidence)}`} />
        <Stat label="Score" value={result.intentScore.toFixed(2)} />
        <Stat label="Auto-reply" value={pct(result.autoReplyProbability)} />
        <Stat label="Opt-out" value={pct(result.optOutProbability)} />
      </dl>
      <p className="text-[11px] text-muted-foreground">Modelo {result.model}</p>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}
