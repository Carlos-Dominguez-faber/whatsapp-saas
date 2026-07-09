"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { AvatarGalleryPicker } from "./avatar-gallery-picker";
import { ModelPicker } from "./model-picker";
import { AgentAvatar } from "./agent-avatar";
import { GuidedPromptEditor } from "./guided-prompt-editor";
import { TestChatPanel } from "./test-chat-panel";
import { SetterAdvancedConfig } from "./setter-advanced-config";
import { AGENT_TYPE_META } from "@/features/agents/lib/agent-meta";
import { cn } from "@/lib/utils";
import type { AgentDto } from "@/features/agents/types";
import type { ResponseStyle } from "@/features/inbox/services/prompt-builder";

const STYLE_OPTIONS: { value: ResponseStyle; label: string; hint: string }[] = [
  { value: "concise", label: "Conciso", hint: "Breve y directo" },
  { value: "balanced", label: "Equilibrado", hint: "Por defecto" },
  { value: "detailed", label: "Detallado", hint: "Más contexto" },
];

interface Props {
  workspaceId: string;
  agent: AgentDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (agent: Partial<AgentDto> & { id: string }) => void;
}

export function AgentConfigSheet({
  workspaceId,
  agent,
  open,
  onOpenChange,
  onSaved,
}: Props) {
  const meta = AGENT_TYPE_META[agent.type];
  const [name, setName] = useState(agent.name);
  const [avatarKey, setAvatarKey] = useState(agent.avatarKey);
  const [model, setModel] = useState<string | null>(agent.model);
  const [autoTag, setAutoTag] = useState(Boolean(agent.config.autoTag));
  const [tagTaxonomy, setTagTaxonomy] = useState(
    Array.isArray(agent.config.tagTaxonomy)
      ? agent.config.tagTaxonomy.join(", ")
      : "",
  );
  const [summarize, setSummarize] = useState(Boolean(agent.config.summarize));
  const [responseStyle, setResponseStyle] = useState<ResponseStyle>(
    agent.config.responseStyle ?? "balanced",
  );
  const [sleepOnManual, setSleepOnManual] = useState(
    agent.config.sleepOnManualMessage !== false,
  );
  const [saving, setSaving] = useState(false);
  const router = useRouter();

  async function handleSaveIdentity() {
    if (!name.trim()) {
      toast.error("El agente necesita un nombre");
      return;
    }
    setSaving(true);
    const taxonomyList = Array.from(
      new Set(
        tagTaxonomy
          .split(",")
          .map((t) => t.toLowerCase().trim())
          .filter(Boolean),
      ),
    );
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/agents`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: agent.id,
          name: name.trim(),
          avatarKey,
          model,
          config: {
            ...agent.config,
            autoTag,
            summarize,
            responseStyle,
            sleepOnManualMessage: sleepOnManual,
            // undefined is dropped by JSON.stringify → clears the key.
            tagTaxonomy: taxonomyList.length > 0 ? taxonomyList : undefined,
          },
        }),
      });
      const json = (await res.json()) as { agent?: AgentDto; error?: string };
      if (!res.ok || !json.agent) {
        toast.error(json.error ?? "Error al guardar");
        return;
      }
      toast.success("Agente guardado");
      onSaved(json.agent);
      router.refresh();
    } catch {
      toast.error("Error de conexión");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <div className="flex items-center gap-3">
            <AgentAvatar
              avatarKey={avatarKey}
              name={name}
              className="h-12 w-12"
            />
            <div>
              <SheetTitle>Configurar agente</SheetTitle>
              <SheetDescription>
                {meta.label} — {meta.tagline}
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <Tabs defaultValue="identidad" className="px-4 py-2">
          <TabsList className="mb-4">
            <TabsTrigger value="identidad">Identidad</TabsTrigger>
            <TabsTrigger value="prompt">Prompt</TabsTrigger>
            {agent.type === "setter" && (
              <TabsTrigger value="avanzado">Avanzado</TabsTrigger>
            )}
            <TabsTrigger value="prueba">Prueba</TabsTrigger>
          </TabsList>

          <TabsContent value="identidad" className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="agent-name">Nombre del agente</Label>
              <Input
                id="agent-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ej: Carlos"
                maxLength={60}
              />
            </div>

            <div className="space-y-2">
              <Label>Avatar</Label>
              <AvatarGalleryPicker value={avatarKey} onChange={setAvatarKey} />
            </div>

            <div className="space-y-2">
              <Label>Modelo de IA</Label>
              <ModelPicker value={model} onChange={setModel} />
            </div>

            <div className="space-y-3 rounded-md border border-border/60 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    Auto-etiquetado
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Etiqueta contactos por intención con IA.
                  </p>
                </div>
                <Switch
                  checked={autoTag}
                  onCheckedChange={setAutoTag}
                  aria-label="Auto-etiquetado"
                />
              </div>
              {autoTag && (
                <div className="space-y-1.5">
                  <Label htmlFor="tag-taxonomy" className="text-xs">
                    Temas permitidos (separados por coma)
                  </Label>
                  <Textarea
                    id="tag-taxonomy"
                    value={tagTaxonomy}
                    onChange={(e) => setTagTaxonomy(e.target.value)}
                    placeholder="Ej: chasis, motor, cerámico, precio, horario"
                    rows={3}
                    className="text-xs"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    La IA etiqueta solo con estos temas; lo que no encaje llega
                    como &quot;nuevo:&quot; para detectar gaps. Vacío = etiquetas
                    libres.
                  </p>
                </div>
              )}
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    Resúmenes automáticos
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Genera un resumen de cada conversación.
                  </p>
                </div>
                <Switch
                  checked={summarize}
                  onCheckedChange={setSummarize}
                  aria-label="Resúmenes automáticos"
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    Pausar IA con mensaje manual
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Si un humano responde en el inbox, la IA deja de responder
                    esa conversación.
                  </p>
                </div>
                <Switch
                  checked={sleepOnManual}
                  onCheckedChange={setSleepOnManual}
                  aria-label="Pausar IA con mensaje manual"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Estilo de respuesta</Label>
              <div className="grid grid-cols-3 gap-2">
                {STYLE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setResponseStyle(opt.value)}
                    aria-pressed={responseStyle === opt.value}
                    className={cn(
                      "rounded-md border p-2 text-center transition-colors",
                      responseStyle === opt.value
                        ? "border-primary bg-primary/10"
                        : "border-border/60 hover:bg-muted/40",
                    )}
                  >
                    <span className="block text-xs font-medium text-foreground">
                      {opt.label}
                    </span>
                    <span className="block text-[10px] text-muted-foreground">
                      {opt.hint}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <Button
              onClick={handleSaveIdentity}
              disabled={saving}
              aria-busy={saving}
            >
              {saving ? (
                <>
                  <Loader2
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                  Guardando...
                </>
              ) : (
                "Guardar"
              )}
            </Button>
          </TabsContent>

          <TabsContent value="prompt">
            <GuidedPromptEditor
              workspaceId={workspaceId}
              agent={agent}
              onPublished={(body) =>
                onSaved({ id: agent.id, promptBody: body })
              }
            />
          </TabsContent>

          {agent.type === "setter" && (
            <TabsContent value="avanzado">
              <div className="mb-4">
                <p className="text-sm text-muted-foreground">
                  Califica prospectos con preguntas estructuradas, reglas de
                  knockout y scoring antes del handoff.
                </p>
              </div>
              <SetterAdvancedConfig workspaceId={workspaceId} />
            </TabsContent>
          )}

          <TabsContent value="prueba">
            <TestChatPanel workspaceId={workspaceId} agent={agent} />
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
