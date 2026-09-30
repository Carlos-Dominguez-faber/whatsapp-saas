"use client";

import { useState, useRef, useEffect } from "react";
import { Send, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { formatWhatsAppMarkdown } from "@/features/inbox/services/text-formatter";
import {
  probarHistory,
  PROBAR_MAX_MESSAGE_CHARS,
  type ProbarMsg,
} from "../lib/probar-history";

// The /probar chat — deliberately minimal: no model name, no prompt, no links
// into the app. The server picks the active agent and answers with text only.
export function ClientTestChat({
  workspaceId,
  agentName,
  businessName,
}: {
  workspaceId: string;
  agentName: string;
  businessName: string;
}) {
  const [messages, setMessages] = useState<ProbarMsg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    const next: ProbarMsg[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/probar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: probarHistory(next) }),
      });
      const json = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
      if (!res.ok) {
        setError(json.error ?? "No se pudo generar la respuesta.");
        // Give the message back so it can be sent again.
        setMessages((prev) => prev.slice(0, -1));
        setInput(text);
        return;
      }
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: formatWhatsAppMarkdown(json.text ?? "") },
      ]);
    } catch {
      setError("Error de conexión. Intenta de nuevo.");
      setMessages((prev) => prev.slice(0, -1));
      setInput(text);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card p-4 shadow-sm">
      <p className="text-sm text-muted-foreground">
        Escríbele a <span className="font-medium text-foreground">{agentName}</span>{" "}
        como si fueras un cliente que le escribe por primera vez a {businessName}.
        No se envía nada por WhatsApp.
      </p>

      <div
        className="h-96 space-y-2 overflow-y-auto rounded-md border border-border/60 bg-muted/20 p-3"
        aria-live="polite"
      >
        {messages.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Escribe un mensaje para empezar.
          </p>
        ) : (
          messages.map((m, i) => (
            <div
              key={`${i}-${m.role}`}
              className={cn(
                "max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
                m.role === "user"
                  ? "ml-auto bg-primary/15"
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

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="flex items-end gap-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={1}
          maxLength={PROBAR_MAX_MESSAGE_CHARS}
          placeholder="Escribe tu mensaje..."
          aria-label="Tu mensaje"
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
          aria-label="Enviar mensaje"
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
