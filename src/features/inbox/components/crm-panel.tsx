"use client";

/**
 * crm-panel.tsx — Collapsible CRM side panel for contact details.
 * Shows contact info, stage, tags, opt-in status with inline editing.
 */

import { useState, useTransition, KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { User, RefreshCw, Save, ChevronDown, ChevronUp, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { updateContact, syncContactCrm } from "../services/contact-actions";
import type { ContactRow } from "@/features/inbox/types";

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

type Stage = "new" | "engaged" | "qualified" | "customer" | "lost";

const STAGE_LABELS: Record<Stage, string> = {
  new: "Nuevo",
  engaged: "Interesado",
  qualified: "Calificado",
  customer: "Cliente",
  lost: "Perdido",
};

interface CrmPanelProps {
  contact: ContactRow;
  conversationId: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Avatar helper
// ──────────────────────────────────────────────────────────────────────────────

function Initials({ name }: { name: string | null }) {
  const letters = name
    ? name
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((w) => w[0]?.toUpperCase() ?? "")
        .join("")
    : "?";

  return (
    <div className="h-10 w-10 rounded-full bg-[hsl(var(--electric-lime)/0.15)] border border-[hsl(var(--electric-lime)/0.3)] flex items-center justify-center shrink-0">
      <span className="text-xs font-semibold text-[hsl(var(--electric-lime))] font-mono">
        {letters}
      </span>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// CrmPanel
// ──────────────────────────────────────────────────────────────────────────────

export function CrmPanel({
  contact,
  conversationId: _conversationId,
}: CrmPanelProps) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  // Local editable state
  const [name, setName] = useState(contact.name ?? "");
  const [email, setEmail] = useState(contact.email ?? "");
  const [stage, setStage] = useState<Stage>(
    (contact.stage as Stage | null) ?? "new",
  );
  const [tags, setTags] = useState<string[]>(contact.tags ?? []);
  const [tagInput, setTagInput] = useState("");
  const [optIn, setOptIn] = useState(contact.opt_in);

  // Section collapse
  const [contactOpen, setContactOpen] = useState(true);
  const [crmOpen, setCrmOpen] = useState(true);

  // ── Tag helpers ──────────────────────────────────────────────────────────────

  function addTag() {
    const trimmed = tagInput.trim();
    if (trimmed && !tags.includes(trimmed)) {
      setTags((prev) => [...prev, trimmed]);
    }
    setTagInput("");
  }

  function removeTag(tag: string) {
    setTags((prev) => prev.filter((t) => t !== tag));
  }

  function handleTagKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      addTag();
    }
  }

  // ── Save ──────────────────────────────────────────────────────────────────────

  function handleSave() {
    startTransition(async () => {
      const result = await updateContact(contact.id, {
        name: name || undefined,
        email: email || undefined,
        stage,
        tags,
        opt_in: optIn,
      });

      if (result.ok) {
        toast.success("Contacto actualizado");
      } else {
        toast.error(result.error ?? "Error al guardar");
      }
    });
  }

  // ── CRM Sync ─────────────────────────────────────────────────────────────────

  function handleSyncCrm() {
    startTransition(async () => {
      const result = await syncContactCrm(contact.id);
      if (result.ok) {
        toast.success(`Sincronizado con ${result.data.provider === "hubspot" ? "HubSpot" : "HighLevel"}`);
        // El pull de HubSpot puede rellenar nombre/email en el servidor; sin esto, el panel
        // seguía mostrando el snapshot viejo hasta recargar la página a mano.
        router.refresh();
      } else {
        toast.error(result.error ?? "Error al sincronizar");
      }
    });
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <aside className="w-72 shrink-0 flex flex-col gap-0 border-l border-border/50 glass overflow-y-auto text-sm">
      {/* ── Section: Contact info ── */}
      <section>
        <button
          type="button"
          onClick={() => setContactOpen((v) => !v)}
          className="w-full flex items-center justify-between px-4 py-2.5 border-b border-border/40 hover:bg-muted/20 transition-colors"
        >
          <span className="text-xs font-semibold text-[hsl(var(--electric-lime))] uppercase tracking-wider">
            Contacto
          </span>
          {contactOpen ? (
            <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </button>

        {contactOpen && (
          <div className="px-4 py-3 space-y-3">
            {/* Avatar + phone */}
            <div className="flex items-center gap-3">
              <Initials name={name || contact.name} />
              <div className="min-w-0 flex-1">
                <p className="text-[10px] text-muted-foreground font-mono truncate">
                  {contact.phone}
                </p>
              </div>
            </div>

            {/* Name */}
            <div className="space-y-1">
              <Label className="text-[10px] text-[hsl(var(--electric-lime))] uppercase tracking-wider">
                Nombre
              </Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Sin nombre"
                className="h-7 text-xs"
              />
            </div>

            {/* Email */}
            <div className="space-y-1">
              <Label className="text-[10px] text-[hsl(var(--electric-lime))] uppercase tracking-wider">
                Email
              </Label>
              <Input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="email@ejemplo.com"
                type="email"
                className="h-7 text-xs"
              />
            </div>

            {/* Opt-in switch */}
            <div className="flex items-center justify-between">
              <Label className="text-[10px] text-[hsl(var(--electric-lime))] uppercase tracking-wider">
                WhatsApp Opt-in
              </Label>
              <Switch
                checked={optIn}
                onCheckedChange={setOptIn}
                aria-label="WhatsApp Opt-in"
              />
            </div>
          </div>
        )}
      </section>

      {/* ── Section: CRM ── */}
      <section>
        <button
          type="button"
          onClick={() => setCrmOpen((v) => !v)}
          className="w-full flex items-center justify-between px-4 py-2.5 border-b border-border/40 hover:bg-muted/20 transition-colors"
        >
          <span className="text-xs font-semibold text-[hsl(var(--electric-lime))] uppercase tracking-wider">
            CRM
          </span>
          {crmOpen ? (
            <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </button>

        {crmOpen && (
          <div className="px-4 py-3 space-y-3">
            {/* Stage */}
            <div className="space-y-1">
              <Label className="text-[10px] text-[hsl(var(--electric-lime))] uppercase tracking-wider">
                Etapa
              </Label>
              <Select value={stage} onValueChange={(v) => setStage(v as Stage)}>
                <SelectTrigger className="h-7 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(STAGE_LABELS) as Stage[]).map((s) => (
                    <SelectItem key={s} value={s} className="text-xs">
                      {STAGE_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Tags */}
            <div className="space-y-1.5">
              <Label className="text-[10px] text-[hsl(var(--electric-lime))] uppercase tracking-wider">
                Etiquetas
              </Label>
              {tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {tags.map((tag) => (
                    <Badge
                      key={tag}
                      variant="secondary"
                      className="text-[10px] pr-1 gap-1"
                    >
                      {tag}
                      <button
                        type="button"
                        onClick={() => removeTag(tag)}
                        aria-label={`Eliminar etiqueta ${tag}`}
                        className="hover:text-destructive transition-colors"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
              <Input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={handleTagKeyDown}
                onBlur={addTag}
                placeholder="Agregar etiqueta..."
                className="h-7 text-xs"
              />
            </div>
          </div>
        )}
      </section>

      {/* ── Actions ── */}
      <div className="px-4 py-3 border-t border-border/40 flex flex-col gap-2 mt-auto">
        <Button
          size="sm"
          onClick={handleSave}
          disabled={isPending}
          className="w-full h-7 text-xs gap-1.5"
        >
          <Save className="h-3.5 w-3.5" />
          {isPending ? "Guardando..." : "Guardar cambios"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleSyncCrm}
          disabled={isPending}
          className="w-full h-7 text-xs gap-1.5"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Sincronizar CRM
        </Button>
      </div>

      {/* Opt-out warning */}
      {!optIn && (
        <div className="mx-4 mb-3 px-3 py-2 rounded-md bg-destructive/10 border border-destructive/30">
          <p className="text-[10px] text-destructive leading-snug">
            <strong>Opt-out activo.</strong> No se enviarán mensajes a este
            contacto.
          </p>
        </div>
      )}
    </aside>
  );
}

// Re-export User icon for the toggle button in chat-thread
export { User };
