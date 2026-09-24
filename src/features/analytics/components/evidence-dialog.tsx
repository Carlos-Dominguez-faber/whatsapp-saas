"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getEvidenceAction, type EvidenceRow } from "../services/evidence-actions";
import { settleEvidence } from "../lib/evidence-load";
import type { InsightsRange } from "../lib/schemas";

export interface EvidenceTarget {
  topicId: string;
  topicName: string;
  outcome: "all" | "booked" | "handed_off" | "tag";
  tag?: string;
}

const OUTCOME_LABEL: Record<EvidenceTarget["outcome"], string> = {
  all: "Todas",
  booked: "Agendaron cita",
  handed_off: "Derivadas a humano",
  tag: "Con etiqueta",
};

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; rows: EvidenceRow[]; hasMore: boolean };

export function EvidenceDialog({
  workspaceId,
  range,
  target,
  onClose,
}: {
  workspaceId: string;
  range: InsightsRange;
  target: EvidenceTarget | null;
  onClose: () => void;
}) {
  // Cada target nuevo es una carga distinta y necesita su propio estado desde
  // cero (página 0, sin filas viejas). Resetear page/loadingMore con un
  // useEffect([target]) no sirve: setState síncrono en el cuerpo de un efecto
  // dispara `react-hooks/set-state-in-effect` (encadena renders) y el lint
  // del repo lo trata como error. La alternativa que React documenta para
  // "ajustar estado cuando cambia una prop" (react.dev, "You Might Not Need
  // an Effect" → "Resetting all state when a prop changes") es comparar
  // durante el render con un `useState` — nunca un ref, el lint del repo
  // también prohíbe leer `.current` en render — y remontar con una key
  // nueva: el montaje inicial ya arranca en el estado por defecto, sin pasar
  // por un efecto.
  const [prevTarget, setPrevTarget] = useState(target);
  const [instance, setInstance] = useState(0);
  if (target !== prevTarget) {
    setPrevTarget(target);
    setInstance((i) => i + 1);
  }

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        {target && (
          <EvidenceDialogBody key={instance} workspaceId={workspaceId} range={range} target={target} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function EvidenceDialogBody({
  workspaceId,
  range,
  target,
}: {
  workspaceId: string;
  range: InsightsRange;
  target: EvidenceTarget;
}) {
  const [page, setPage] = useState(0);
  const [state, setState] = useState<State>({ status: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);

  // El estado inicial ({status:"loading"}) ya cubre la página 0: no hace
  // falta ponerlo de nuevo acá. Todo setState de este efecto vive dentro del
  // callback de la promesa, nunca
  // síncrono en el cuerpo del efecto.
  useEffect(() => {
    let cancelled = false;
    // settleEvidence nunca rechaza; un fallo de transporte llega como
    // { error } y apaga también `loadingMore`.
    settleEvidence(
      getEvidenceAction(workspaceId, {
        topicId: target.topicId,
        outcome: target.outcome,
        tag: target.tag,
        page,
        fromIso: range.fromIso,
        toIso: range.toIso,
      }),
    ).then((r) => {
      if (cancelled) return;
      setLoadingMore(false);
      if ("error" in r) {
        setState({ status: "error", message: r.error });
        return;
      }
      setState((prev) => ({
        status: "ready",
        rows: page > 0 && prev.status === "ready" ? [...prev.rows, ...r.data] : r.data,
        hasMore: r.hasMore,
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, range.fromIso, range.toIso, target, page]);

  // La página solo avanza cuando la anterior TERMINÓ. El guard vive en
  // el manejador del click (no en un efecto): dos clics seguidos no pueden
  // pedir la misma página dos veces ni saltarse una.
  function loadMore() {
    if (loadingMore) return;
    setLoadingMore(true);
    setPage((p) => p + 1);
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{target.topicName}</DialogTitle>
        <DialogDescription>
          {OUTCOME_LABEL[target.outcome]}
          {target.tag ? `: ${target.tag}` : ""}
        </DialogDescription>
      </DialogHeader>

      {state.status === "loading" && <p className="text-sm text-muted-foreground">Cargando conversaciones…</p>}
      {state.status === "error" && (
        <p role="alert" className="text-sm">
          {state.message}
        </p>
      )}
      {state.status === "ready" && state.rows.length === 0 && (
        <p className="text-sm text-muted-foreground">No hay conversaciones para este cruce.</p>
      )}
      {state.status === "ready" && state.rows.length > 0 && (
        <ul className="divide-y">
          {state.rows.map((r) => (
            <li key={r.conversation_id} className="space-y-1 py-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{r.contact_name ?? r.contact_phone}</span>
                <time className="text-xs text-muted-foreground" dateTime={r.detected_at}>
                  {new Date(r.detected_at).toLocaleDateString("es-CL")}
                </time>
              </div>
              <blockquote className="border-l-2 pl-3 text-muted-foreground">
                {r.evidence_body ?? "El mensaje de evidencia ya no está disponible."}
              </blockquote>
              <Link href={`/inbox/${r.conversation_id}`} className="text-primary underline">
                Abrir conversación
              </Link>
            </li>
          ))}
        </ul>
      )}
      {state.status === "ready" && state.hasMore && (
        <Button variant="outline" size="sm" disabled={loadingMore} aria-busy={loadingMore} onClick={loadMore}>
          {loadingMore ? "Cargando…" : "Ver más"}
        </Button>
      )}
    </>
  );
}
