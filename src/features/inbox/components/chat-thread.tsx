"use client";

import { useEffect, useRef, useState } from "react";
import {
  Send,
  StickyNote,
  User,
  AlertCircle,
  UserCheck,
  BarChart2,
  Bot,
} from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useRealtimeMessages } from "@/features/inbox/hooks/use-realtime-messages";
import type { WorkspaceRole } from "@/features/inbox/hooks/use-role";
import {
  canHandoff,
  canSendMessages,
  canTakeConversation,
  canViewObservability,
} from "@/features/inbox/hooks/use-role";
import { AiToggleButton } from "./ai-toggle-button";
import { ChatMessage } from "./chat-message";
import { WindowBanner } from "./window-banner";
import { TemplatePicker } from "./template-picker";
import { CrmPanel } from "./crm-panel";
import { ObservabilityPanel } from "./observability-panel";
import { RoleGate } from "./role-gate";
import type {
  ConversationWithContact,
  MessageRow,
} from "@/features/inbox/types";

interface ChatThreadProps {
  conversation: ConversationWithContact;
  initialMessages: MessageRow[];
  currentUserId: string;
  role?: WorkspaceRole;
}

export function ChatThread({
  conversation,
  initialMessages,
  currentUserId: _currentUserId,
  role = "agent",
}: ChatThreadProps) {
  const messages = useRealtimeMessages(conversation.id, initialMessages);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [showCrm, setShowCrm] = useState(false);
  const [showObservability, setShowObservability] = useState(false);
  const [handoffLoading, setHandoffLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [noteMode, setNoteMode] = useState(false);
  const [note, setNote] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const router = useRouter();

  const isWindowExpired =
    conversation.window_expires_at != null &&
    new Date(conversation.window_expires_at) < new Date();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    const trimmed = draft.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      const res = await fetch(
        `/api/conversations/${conversation.id}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: trimmed }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error((data as { error?: string }).error ?? "Error al enviar");
        return;
      }
      setDraft("");
    } catch {
      toast.error("Error al enviar");
    } finally {
      setSending(false);
    }
  };

  const handleHandoffRequest = async () => {
    setHandoffLoading(true);
    try {
      const res = await fetch(`/api/conversations/${conversation.id}/handoff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "request" }),
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error ?? "Error al solicitar handoff");
        return;
      }
      toast.success("Handoff solicitado");
      router.refresh();
    } catch {
      toast.error("Error de conexión");
    } finally {
      setHandoffLoading(false);
    }
  };

  const handleReturnToAi = async () => {
    setHandoffLoading(true);
    try {
      const res = await fetch(`/api/conversations/${conversation.id}/handoff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error ?? "Error al devolver a IA");
        return;
      }
      toast.success("Conversación devuelta a la IA");
      router.refresh();
    } catch {
      toast.error("Error de conexión");
    } finally {
      setHandoffLoading(false);
    }
  };

  const handleSaveNote = async () => {
    const trimmed = note.trim();
    if (!trimmed || savingNote) return;
    setSavingNote(true);
    try {
      const res = await fetch(`/api/conversations/${conversation.id}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: trimmed }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(
          (data as { error?: string }).error ?? "Error al guardar nota",
        );
        return;
      }
      setNote("");
      setNoteMode(false);
      toast.success("Nota guardada");
    } catch {
      toast.error("Error de conexión");
    } finally {
      setSavingNote(false);
    }
  };

  const handleTakeConversation = async () => {
    setHandoffLoading(true);
    try {
      const res = await fetch(`/api/conversations/${conversation.id}/take`, {
        method: "POST",
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error ?? "Error al tomar la conversación");
        return;
      }
      toast.success("Conversación tomada");
      router.refresh();
    } catch {
      toast.error("Error de conexión");
    } finally {
      setHandoffLoading(false);
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col md:flex-row">
      {/* Left: thread */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Sticky header */}
        <header
          className={cn(
            "glass-strong shrink-0 flex items-center justify-between",
            "px-4 py-3 border-b border-border/50",
          )}
        >
          <div className="space-y-0.5 min-w-0">
            <h2 className="font-display text-sm font-semibold text-foreground truncate">
              {conversation.contact.name ?? conversation.contact.phone}
            </h2>
            <p className="font-mono text-[10px] text-muted-foreground">
              {conversation.contact.phone}
            </p>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {/* Handoff button — gated by role */}
            {conversation.state === "ai_active" && (
              <RoleGate role={role} check={canHandoff}>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleHandoffRequest}
                  disabled={handoffLoading}
                  aria-label="Solicitar handoff a humano"
                  className="h-8 gap-1.5 text-xs text-amber-400 border-amber-400/30 hover:bg-amber-400/10"
                >
                  <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
                  Handoff
                </Button>
              </RoleGate>
            )}

            {/* Take conversation button — gated by role */}
            {conversation.state === "handoff_pending" && (
              <RoleGate role={role} check={canTakeConversation}>
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  onClick={handleTakeConversation}
                  disabled={handoffLoading}
                  aria-label="Tomar conversación"
                  className="h-8 gap-1.5 text-xs"
                >
                  <UserCheck className="h-3.5 w-3.5" aria-hidden="true" />
                  Tomar
                </Button>
              </RoleGate>
            )}

            {/* Return to AI — gated by role (human_active only) */}
            {conversation.state === "human_active" && (
              <RoleGate role={role} check={canTakeConversation}>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleReturnToAi}
                  disabled={handoffLoading}
                  aria-label="Devolver conversación a la IA"
                  className="h-8 gap-1.5 text-xs"
                >
                  <Bot className="h-3.5 w-3.5" aria-hidden="true" />
                  Devolver a IA
                </Button>
              </RoleGate>
            )}

            {/* Observability toggle — gated by role */}
            <RoleGate role={role} check={canViewObservability}>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() => setShowObservability((v) => !v)}
                aria-label="Ver observabilidad"
                aria-pressed={showObservability}
                className={cn(
                  "h-8 w-8",
                  showObservability &&
                    "bg-[hsl(var(--electric-lime)/0.1)] text-[hsl(var(--electric-lime))]",
                )}
              >
                <BarChart2 className="h-4 w-4" aria-hidden="true" />
              </Button>
            </RoleGate>

            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={() => setShowCrm((v) => !v)}
              aria-label="Ver contacto"
              aria-pressed={showCrm}
              className={cn(
                "h-8 w-8",
                showCrm &&
                  "bg-[hsl(var(--electric-lime)/0.1)] text-[hsl(var(--electric-lime))]",
              )}
            >
              <User className="h-4 w-4" aria-hidden="true" />
            </Button>
            <AiToggleButton
              conversationId={conversation.id}
              initialEnabled={conversation.ai_enabled}
            />
          </div>
        </header>

        <WindowBanner
          windowExpiresAt={conversation.window_expires_at ?? null}
        />

        {/* Message list */}
        <ScrollArea className="flex-1 px-4">
          <div className="py-4 space-y-2">
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <p className="text-sm text-muted-foreground">
                  No hay mensajes aún
                </p>
                <p className="text-xs text-muted-foreground/60 mt-1">
                  Los mensajes entrantes aparecerán aquí en tiempo real
                </p>
              </div>
            ) : (
              messages.map((message) => (
                <ChatMessage key={message.id} message={message} />
              ))
            )}
            <div ref={bottomRef} aria-hidden="true" />
          </div>
        </ScrollArea>

        {/* Footer composer */}
        <footer
          className={cn(
            "shrink-0 border-t border-border/50 p-3 transition-colors duration-200",
            noteMode && "bg-warning/5 border-warning/20",
          )}
        >
          {/* Permissions first: with the 24h window closed, a viewer must still
              see "read only", not a template picker offering to send. */}
          {!canSendMessages(role) ? (
            <p className="py-2 text-center text-xs text-muted-foreground/60 select-none">
              Solo lectura — sin permisos para enviar mensajes
            </p>
          ) : isWindowExpired ? (
            <TemplatePicker conversationId={conversation.id} />
          ) : noteMode ? (
            /* ── Note mode composer ───────────────────────────── */
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-warning">
                  <StickyNote className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="text-[11px] font-medium">
                    Nota interna — no visible para el contacto
                  </span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setNoteMode(false);
                    setNote("");
                  }}
                  className="h-6 px-2 text-[11px] text-muted-foreground"
                  aria-label="Cancelar nota interna"
                >
                  Cancelar
                </Button>
              </div>
              <div className="flex items-end gap-2">
                <Textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Nota interna (no visible para el contacto)..."
                  className="min-h-[40px] max-h-32 resize-none flex-1 text-sm border-warning/30 focus-visible:ring-warning/40"
                  rows={2}
                  aria-label="Nota interna"
                  disabled={savingNote}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void handleSaveNote();
                    }
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void handleSaveNote()}
                  disabled={savingNote || note.trim().length === 0}
                  aria-label="Guardar nota interna"
                  aria-busy={savingNote}
                  className="shrink-0 h-10 border-warning/30 text-warning hover:bg-warning/10"
                >
                  {savingNote ? "Guardando..." : "Guardar nota"}
                </Button>
              </div>
            </div>
          ) : (
            /* ── Normal message composer ──────────────────────── */
            <div className="flex items-end gap-2">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() => setNoteMode(true)}
                aria-label="Agregar nota interna"
                aria-pressed={noteMode}
                className="shrink-0 h-10 w-10 text-muted-foreground hover:text-warning hover:bg-warning/10"
              >
                <StickyNote className="h-4 w-4" aria-hidden="true" />
              </Button>
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Escribe un mensaje..."
                className="min-h-[40px] max-h-32 resize-none flex-1 text-sm"
                rows={2}
                aria-label="Mensaje"
                disabled={sending}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
              />
              <Button
                type="button"
                size="icon"
                variant="default"
                onClick={() => void handleSend()}
                disabled={sending || draft.trim().length === 0}
                aria-label="Enviar mensaje"
                aria-busy={sending}
                className="shrink-0 h-10 w-10"
              >
                <Send className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          )}
        </footer>
      </div>

      {/* Right: CRM panel */}
      {showCrm && (
        <CrmPanel
          contact={conversation.contact}
          conversationId={conversation.id}
        />
      )}

      {/* Right: Observability panel */}
      {showObservability && (
        <div className="w-full md:w-80 shrink-0 border-t md:border-t-0 md:border-l border-border/50 overflow-y-auto p-3">
          <ObservabilityPanel conversationId={conversation.id} />
        </div>
      )}
    </div>
  );
}
