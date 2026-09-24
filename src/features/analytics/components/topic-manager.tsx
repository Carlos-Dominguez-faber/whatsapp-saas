"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MAX_ACTIVE_TOPICS } from "../lib/schemas";
import {
  archiveTopicAction,
  createTopicAction,
  updateTopicAction,
  type InsightTopic,
  type TopicActionResult,
} from "../services/topic-actions";

type FieldErrors = Partial<Record<"name" | "description", string>>;
type Editing = { mode: "create" } | { mode: "edit"; topic: InsightTopic } | null;

export function TopicManager({
  workspaceId,
  topics,
  canManage,
}: {
  workspaceId: string;
  topics: InsightTopic[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<Editing>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const atCap = topics.length >= MAX_ACTIVE_TOPICS;

  function openEditor(next: Editing) {
    setFieldErrors({});
    setFormError(null);
    setEditing(next);
  }

  function handleResult<T>(r: TopicActionResult<T>, onOk: () => void) {
    if ("error" in r) {
      setFieldErrors(r.fieldErrors ?? {});
      setFormError(r.fieldErrors && Object.keys(r.fieldErrors).length > 0 ? null : r.error);
      return;
    }
    onOk();
    router.refresh();
  }

  function submit(form: FormData) {
    const input = { name: String(form.get("name") ?? ""), description: String(form.get("description") ?? "") };
    const current = editing;
    if (!current) return;
    startTransition(async () => {
      if (current.mode === "create") {
        handleResult(await createTopicAction(workspaceId, input), () => {
          setEditing(null);
          setNotice("Analizaremos los últimos 30 días esta noche; los resultados aparecen mañana.");
        });
      } else {
        handleResult(await updateTopicAction(workspaceId, current.topic.id, input), () => setEditing(null));
      }
    });
  }

  function archive(topicId: string) {
    startTransition(async () => {
      const r = await archiveTopicAction(workspaceId, topicId);
      if ("error" in r) {
        setListError(r.error);
        return;
      }
      setConfirmArchive(null);
      setListError(null);
      router.refresh();
    });
  }

  return (
    <section aria-labelledby="topics-title" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="topics-title" className="text-lg font-semibold">
            Temas
          </h2>
          <p className="text-sm text-muted-foreground">
            {topics.length} de {MAX_ACTIVE_TOPICS} activos
          </p>
        </div>
        {canManage && (
          <Button size="sm" disabled={atCap || pending} onClick={() => openEditor({ mode: "create" })}>
            Nuevo tema
          </Button>
        )}
      </div>

      {canManage && atCap && (
        <p className="text-sm text-muted-foreground">
          Llegaste al máximo de 10 temas activos. Archiva uno para crear otro.
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-lg bg-primary/5 p-3 text-sm">
          {notice}
        </p>
      )}
      {listError && (
        <p role="alert" className="text-sm">
          {listError}
        </p>
      )}

      <ul className="divide-y rounded-xl border">
        {topics.map((t) => (
          <li key={t.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
            <div className="min-w-0 space-y-1">
              {/* div, no <p>: Badge renderiza un <div> y el HTML no lo admite
                  dentro de un <p>. Con <p> React tira un error de hidratación
                  ("cannot be a descendant") y rehidrata mal la lista. */}
              <div className="font-medium">
                {t.name}
                {t.backfill_status === "pending" && (
                  <Badge variant="secondary" className="ml-2">
                    Analizando histórico
                  </Badge>
                )}
              </div>
              {t.backfill_status === "expired" && (
                <p className="text-sm text-muted-foreground">
                  Histórico no reprocesado: la ventana de 30 días se venció.
                </p>
              )}
              <p className="text-sm text-muted-foreground">{t.description}</p>
            </div>
            {canManage && (
              <div className="flex gap-2">
                {confirmArchive === t.id ? (
                  <>
                    <Button size="sm" variant="destructive" disabled={pending} onClick={() => archive(t.id)}>
                      Confirmar archivo
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmArchive(null)}>
                      Cancelar
                    </Button>
                  </>
                ) : (
                  <>
                    <Button size="sm" variant="outline" onClick={() => openEditor({ mode: "edit", topic: t })}>
                      Editar
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmArchive(t.id)}>
                      Archivar
                    </Button>
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing?.mode === "edit" ? "Editar tema" : "Nuevo tema"}</DialogTitle>
            <DialogDescription>
              Describe en lenguaje natural qué debe detectar el análisis en las conversaciones.
            </DialogDescription>
          </DialogHeader>
          <form action={submit} className="space-y-4">
            <div className="grid gap-1.5">
              <Label htmlFor="topic-name">Nombre</Label>
              <Input
                id="topic-name"
                name="name"
                maxLength={60}
                defaultValue={editing?.mode === "edit" ? editing.topic.name : ""}
                aria-invalid={Boolean(fieldErrors.name)}
                aria-describedby={fieldErrors.name ? "topic-name-error" : undefined}
              />
              {fieldErrors.name && (
                <p id="topic-name-error" className="text-sm text-destructive">
                  {fieldErrors.name}
                </p>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="topic-description">Qué detectar</Label>
              <Textarea
                id="topic-description"
                name="description"
                maxLength={500}
                rows={4}
                defaultValue={editing?.mode === "edit" ? editing.topic.description : ""}
                aria-invalid={Boolean(fieldErrors.description)}
                aria-describedby={fieldErrors.description ? "topic-description-error" : undefined}
              />
              {fieldErrors.description && (
                <p id="topic-description-error" className="text-sm text-destructive">
                  {fieldErrors.description}
                </p>
              )}
              {editing?.mode === "edit" && (
                <p className="text-xs text-muted-foreground">
                  Cambiar la descripción no vuelve a analizar conversaciones pasadas. Para un criterio nuevo con
                  histórico, archiva este tema y crea otro.
                </p>
              )}
            </div>
            {formError && (
              <p role="alert" className="text-sm">
                {formError}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Guardando…" : "Guardar"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
