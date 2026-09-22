"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AgentCard } from "./agent-card";
import { AgentConfigSheet } from "./agent-config-sheet";
import { JevPanel, type JevSettings } from "@/features/jev-judge/components/jev-panel";
import type { AgentDto, AgentType } from "@/features/agents/types";

const ORDER: AgentType[] = ["setter", "soporte", "agendamiento"];

function sortAgents(list: AgentDto[]): AgentDto[] {
  return [...list].sort(
    (a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type),
  );
}

export function AgentsTab({
  workspaceId,
  initialAgents,
  jev,
  canManage,
}: {
  workspaceId: string;
  initialAgents: AgentDto[];
  jev: JevSettings;
  canManage: boolean;
}) {
  const router = useRouter();
  const [agents, setAgents] = useState<AgentDto[]>(() =>
    sortAgents(initialAgents),
  );
  const [editing, setEditing] = useState<AgentDto | null>(null);
  const [pending, setPending] = useState<AgentDto | null>(null);
  const [busy, setBusy] = useState(false);

  const currentActive = agents.find((a) => a.isActive) ?? null;

  function requestActivate(agentId: string) {
    const target = agents.find((a) => a.id === agentId);
    if (!target || target.isActive) return;
    setPending(target);
  }

  async function confirmActivate() {
    if (!pending) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/agents`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: pending.id, setActive: true }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast.error(json.error ?? "No se pudo activar el agente");
        return;
      }
      setAgents((prev) =>
        prev.map((a) => ({ ...a, isActive: a.id === pending.id })),
      );
      toast.success(`${pending.name} está activo`);
      router.refresh();
    } catch {
      toast.error("Error de conexión");
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  function handleSaved(updated: Partial<AgentDto> & { id: string }) {
    setAgents((prev) =>
      sortAgents(
        prev.map((a) => (a.id === updated.id ? { ...a, ...updated } : a)),
      ),
    );
  }

  return (
    <div className="space-y-5">
      <JevPanel
        workspaceId={workspaceId}
        initialEnabled={jev.enabled}
        initialUses={jev.uses}
        keyReady={jev.keyReady}
        judgmentsToday={jev.judgmentsToday}
        canManage={canManage}
      />
      <p className="text-sm text-muted-foreground">
        Configura tus 3 agentes. Solo uno puede estar activo a la vez.
      </p>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {agents.map((a) => (
          <AgentCard
            key={a.id}
            agent={a}
            busy={busy}
            onConfigure={setEditing}
            onActivate={requestActivate}
          />
        ))}
      </div>

      {editing && (
        <AgentConfigSheet
          key={editing.id}
          workspaceId={workspaceId}
          agent={editing}
          open={!!editing}
          onOpenChange={(o) => {
            if (!o) setEditing(null);
          }}
          onSaved={handleSaved}
        />
      )}

      <Dialog
        open={!!pending}
        onOpenChange={(o) => {
          if (!o) setPending(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Activar a {pending?.name}</DialogTitle>
            <DialogDescription>
              {currentActive && currentActive.id !== pending?.id
                ? `Esto desactivará a ${currentActive.name}. Solo un agente puede estar activo a la vez.`
                : "¿Activar este agente?"}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPending(null)}>
              Cancelar
            </Button>
            <Button onClick={confirmActivate} disabled={busy} aria-busy={busy}>
              Activar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
