"use client";

import { useState } from "react";
import { Save, Link as LinkIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { scheduleLinkConfigSchema } from "@/features/tools/lib/tool-config";

// ── Shared save helper ──────────────────────────────────────────────────────────

async function saveToolConfig(
  workspaceId: string,
  toolKey: string,
  config: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`/api/tools/${workspaceId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ toolKey, config }),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(
      typeof json.error === "string" ? json.error : "Error al guardar",
    );
  }
}

/** Small "unsaved changes" hint shown next to a save button. */
function DirtyHint({ dirty }: { dirty: boolean }) {
  if (!dirty) return null;
  return <span className="text-xs text-amber-400">• cambios sin guardar</span>;
}

// ── schedule_link ───────────────────────────────────────────────────────────────

function ScheduleLinkForm({
  workspaceId,
  initialConfig,
}: {
  workspaceId: string;
  initialConfig: Record<string, unknown> | null;
}) {
  const initialLink = (initialConfig?.scheduling_link as string) ?? "";
  const [link, setLink] = useState(initialLink);
  const [baseline, setBaseline] = useState(initialLink);
  const [saving, setSaving] = useState(false);

  const dirty = link.trim() !== baseline.trim();

  async function save() {
    const parsed = scheduleLinkConfigSchema.safeParse({
      scheduling_link: link,
    });
    if (!parsed.success) {
      toast.error("Pon una URL válida que empiece con https://");
      return;
    }
    setSaving(true);
    try {
      await saveToolConfig(workspaceId, "schedule_link", parsed.data);
      setBaseline(parsed.data.scheduling_link);
      toast.success("Link de agendamiento guardado");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error al guardar");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5 rounded-lg border border-border bg-muted/20 p-3">
        <Label
          htmlFor="sched-link"
          className="text-sm font-medium text-foreground"
        >
          Link de agendamiento
        </Label>
        <div className="relative">
          <LinkIcon
            className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id="sched-link"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://calendly.com/tu-negocio/cita"
            type="url"
            className="pl-9"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          El agente enviará este enlace cuando alguien quiera agendar (Calendly,
          el booking de HighLevel, etc.).
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          onClick={save}
          disabled={saving || !dirty}
          aria-busy={saving}
        >
          <Save className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {saving ? "Guardando…" : "Guardar link"}
        </Button>
        <DirtyHint dirty={dirty} />
      </div>
    </div>
  );
}

// ── Dispatcher ──────────────────────────────────────────────────────────────────

export function ToolConfigPanel({
  workspaceId,
  toolKey,
  initialConfig,
}: {
  workspaceId: string;
  toolKey: string;
  initialConfig: Record<string, unknown> | null;
}) {
  if (toolKey === "schedule_link") {
    return (
      <ScheduleLinkForm
        workspaceId={workspaceId}
        initialConfig={initialConfig}
      />
    );
  }
  return null;
}

/** Tool keys that expose a config panel. */
export const CONFIGURABLE_TOOLS = new Set(["schedule_link"]);
