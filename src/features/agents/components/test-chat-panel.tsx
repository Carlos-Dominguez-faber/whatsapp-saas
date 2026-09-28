"use client";

import { useState, useRef, useEffect } from "react";
import { Send, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { findCatalogModel } from "@/features/agents/lib/model-catalog";
import { formatWhatsAppMarkdown } from "@/features/inbox/services/text-formatter";
import type { AgentDto } from "@/features/agents/types";
import {
  afterFailure,
  historyToSend,
  type PlaygroundMsg as Msg,
} from "@/features/agents/lib/playground-history";

export function TestChatPanel({
  workspaceId,
  agent,
  isAdmin = false,
}: {
  workspaceId: string;
  agent: AgentDto;
  /** An admin's test runs write tools too; the server decides by role. */
  isAdmin?: boolean;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const cat = findCatalogModel(agent.model);
  const modelLabel = cat
    ? cat.model.label
    : (agent.model ?? "Modelo del workspace");

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    const next: Msg[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch(
        `/api/workspace/${workspaceId}/agents/${agent.id}/test-chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Error bubbles stay in the panel: the model never sees them.
          body: JSON.stringify({ messages: historyToSend(next) }),
        },
      );
      const json = (await res.json()) as {
        text?: string;
        error?: string;
        wroteSomething?: boolean;
      };
      setMessages((prev) => [
        ...prev,
        ...(res.ok
          ? [{ role: "assistant" as const, content: formatWhatsAppMarkdown(json.text ?? "") }]
          : afterFailure({
              errorText: json.error ?? "Error al generar la respuesta",
              wroteSomething: json.wroteSomething === true,
              connectionLost: false,
              isAdmin,
            })),
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        ...afterFailure({
          errorText: "Error de conexión",
          wroteSomething: false,
          connectionLost: true,
          isAdmin,
        }),
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Prueba a{" "}
        <span className="font-medium text-foreground">{agent.name}</span> con el
        modelo <span className="font-medium text-foreground">{modelLabel}</span>
        . Usa el prompt publicado. No se envía nada por WhatsApp.
      </p>
      {isAdmin ? (
        <p className="text-xs text-warning">
          Como admin, aquí corren también las herramientas de escritura que estén
          activas: una cita agendada en la prueba es real (en HighLevel aparece
          como &ldquo;[Prueba]&rdquo;, en el teléfono que escribas aquí).
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          En tu prueba solo corren las herramientas de lectura; las de escritura
          (agendar, tools de n8n que escriben) solo corren para admins.
        </p>
      )}

      <div className="h-72 space-y-2 overflow-y-auto rounded-md border border-border/60 bg-muted/20 p-3">
        {messages.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">
            Escribe un mensaje para empezar la prueba.
          </p>
        ) : (
          messages.map((m, i) => (
            <div
              key={`${i}-${m.role}`}
              className={cn(
                "max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
                m.role === "user"
                  ? "ml-auto bg-primary/15"
                  : m.note
                    ? "mr-auto border border-dashed border-border/60 text-xs text-muted-foreground"
                    : "mr-auto border border-border/60 bg-card",
              )}
            >
              {m.content}
            </div>
          ))
        )}
        {loading && (
          <div className="mr-auto flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            Escribiendo...
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="flex items-end gap-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={1}
          placeholder="Escribe un mensaje de prueba..."
          className="min-h-0 resize-none"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <Button
          onClick={send}
          disabled={loading || !input.trim()}
          size="icon"
          aria-label="Enviar mensaje de prueba"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Send className="h-4 w-4" aria-hidden="true" />
          )}
        </Button>
      </div>
    </div>
  );
}
