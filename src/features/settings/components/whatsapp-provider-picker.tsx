"use client";

import { useRef } from "react";
import { Label } from "@/components/ui/label";

// Shared by Settings → Integraciones and the onboarding wizard.

export type WhatsAppProviderId = "ycloud" | "kapso";

const OPTIONS: readonly WhatsAppProviderId[] = ["ycloud", "kapso"];

export const WHATSAPP_LABEL: Record<WhatsAppProviderId, string> = {
  ycloud: "YCloud",
  kapso: "Kapso",
};

/**
 * YCloud / Kapso as a segmented radio group. Keyboard follows the ARIA radio
 * pattern: a single tab stop, and the arrow keys move to (and select) the
 * other option.
 */
export function WhatsAppProviderPicker({
  value,
  onChange,
  active = null,
  labelledBy,
}: {
  value: WhatsAppProviderId;
  onChange: (provider: WhatsAppProviderId) => void;
  /** The provider the workspace uses today, tagged "activo". */
  active?: WhatsAppProviderId | null;
  labelledBy: string;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  function handleKeyDown(e: React.KeyboardEvent, index: number) {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    e.preventDefault();
    const next = (index + step + OPTIONS.length) % OPTIONS.length;
    onChange(OPTIONS[next]);
    buttons.current[next]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      className="inline-flex w-fit rounded-md border border-input p-0.5"
    >
      {OPTIONS.map((p, i) => (
        <button
          key={p}
          ref={(el) => {
            buttons.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={value === p}
          tabIndex={value === p ? 0 : -1}
          onClick={() => onChange(p)}
          onKeyDown={(e) => handleKeyDown(e, i)}
          className={
            "rounded px-3 py-1.5 text-sm transition-colors " +
            (value === p
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground")
          }
        >
          {WHATSAPP_LABEL[p]}
          {active === p && (
            <span className="ml-1.5 text-[10px] uppercase tracking-wide opacity-80">
              activo
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

// ─── Kapso: pick the workspace's number from the project ──────────────────────

/** A number as the Kapso connection tests return it. */
export type KapsoNumberOption = {
  phone_number_id?: string;
  waba_id?: string;
  display_phone_number?: string | null;
  verified_name?: string | null;
  kind?: string | null;
};

/** "+1 555-000-0001 · Cliente A (sandbox)" — what a person recognises. */
export function describeKapsoNumber(n: KapsoNumberOption): string {
  const main = n.display_phone_number || n.phone_number_id || "número sin nombre";
  const name = n.verified_name ? ` · ${n.verified_name}` : "";
  const sandbox = n.kind === "sandbox" ? " (sandbox)" : "";
  return `${main}${name}${sandbox}`;
}

/** Meta's display number ("+1 555-000-0001") as E.164 ("+15550000001"). */
export function e164FromDisplay(display: string | null | undefined): string {
  const digits = (display ?? "").replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Shown when the Kapso project has more than one number (another client's, a
 * sandbox): the workspace's number is chosen, never assumed.
 */
export function KapsoNumberSelect({
  id,
  numbers,
  value,
  onPick,
}: {
  id: string;
  numbers: KapsoNumberOption[];
  value: string;
  onPick: (n: KapsoNumberOption) => void;
}) {
  const known = numbers.some((n) => n.phone_number_id === value);
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Números del proyecto de Kapso</Label>
      <select
        id={id}
        className={SELECT_CLASS}
        value={known ? value : ""}
        onChange={(e) => {
          const picked = numbers.find((n) => n.phone_number_id === e.target.value);
          if (picked) onPick(picked);
        }}
      >
        <option value="" disabled>
          Elige el número de este workspace…
        </option>
        {numbers.map((n) => (
          <option key={n.phone_number_id} value={n.phone_number_id}>
            {describeKapsoNumber(n)}
          </option>
        ))}
      </select>
    </div>
  );
}
