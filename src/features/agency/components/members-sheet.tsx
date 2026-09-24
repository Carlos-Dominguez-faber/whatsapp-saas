"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Copy, CheckCheck, KeyRound } from "lucide-react";
import {
  getWorkspaceMembers,
  resetMemberPassword,
} from "../services/agency-actions";
import type { WorkspaceMember } from "../types";

interface Props {
  workspaceId: string | null;
  onClose: () => void;
}

export function MembersSheet({ workspaceId, onClose }: Props) {
  const [members, setMembers] = useState<WorkspaceMember[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmUserId, setConfirmUserId] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<{
    email: string;
    password: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [resetting, startReset] = useTransition();

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setMembers(null);
    setCredentials(null);
    setConfirmUserId(null);
    setLoading(true);
    getWorkspaceMembers(workspaceId).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setMembers(result.members ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function handleClose() {
    if (resetting) return;
    setMembers(null);
    setConfirmUserId(null);
    setCredentials(null);
    setCopied(false);
    onClose();
  }

  function handleReset(userId: string) {
    if (!workspaceId) return;
    setConfirmUserId(null);
    startReset(async () => {
      const result = await resetMemberPassword(workspaceId, userId);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setCredentials({ email: result.email ?? "", password: result.password ?? "" });
      toast.success("Clave actualizada");
    });
  }

  function handleCopy() {
    if (!credentials) return;
    navigator.clipboard.writeText(
      `Email: ${credentials.email}\nContraseña: ${credentials.password}`,
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Sheet
      open={workspaceId !== null}
      onOpenChange={(o) => {
        if (!o) handleClose();
      }}
    >
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="font-display text-foreground">
            Miembros
          </SheetTitle>
          <SheetDescription className="text-muted-foreground">
            Miembros con acceso a este workspace. Puedes resetear la clave de
            cualquiera de ellos.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-4">
          {credentials && (
            <div className="rounded-lg border border-warning/30 bg-warning/5 p-4 space-y-2">
              <p className="text-sm font-medium text-foreground">
                Nueva clave
              </p>
              <p className="text-xs text-muted-foreground">
                Compártela con el cliente. No se vuelve a mostrar.
              </p>
              <div className="space-y-1 font-mono text-xs mt-1">
                <p className="text-foreground break-all">
                  <span className="text-muted-foreground">Email: </span>
                  {credentials.email}
                </p>
                <p className="text-foreground break-all">
                  <span className="text-muted-foreground">Contraseña: </span>
                  {credentials.password}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-1 gap-1.5"
                onClick={handleCopy}
              >
                {copied ? (
                  <CheckCheck
                    className="h-4 w-4 text-primary"
                    aria-hidden="true"
                  />
                ) : (
                  <Copy className="h-4 w-4" aria-hidden="true" />
                )}
                Copiar credenciales
              </Button>
            </div>
          )}

          {loading && (
            <div className="space-y-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full rounded-lg" />
              ))}
            </div>
          )}

          {!loading && members?.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Este workspace no tiene miembros.
            </p>
          )}

          {!loading &&
            members?.map((member) => (
              <div
                key={member.userId}
                className="rounded-lg border border-border p-3 space-y-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">
                      {member.fullName ?? member.email}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {member.email}
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className="shrink-0 border-border text-muted-foreground"
                  >
                    {member.role}
                  </Badge>
                </div>
                {!member.isActive && (
                  <Badge
                    variant="outline"
                    className="border-border text-muted-foreground"
                  >
                    Inactivo
                  </Badge>
                )}
                {confirmUserId === member.userId ? (
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="destructive"
                      className="text-xs"
                      disabled={resetting}
                      onClick={() => handleReset(member.userId)}
                    >
                      Confirmar reset
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-xs text-muted-foreground"
                      disabled={resetting}
                      onClick={() => setConfirmUserId(null)}
                    >
                      Cancelar
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 text-xs"
                    disabled={resetting}
                    onClick={() => setConfirmUserId(member.userId)}
                  >
                    <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                    Resetear clave
                  </Button>
                )}
              </div>
            ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
