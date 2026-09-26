"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Copy, CheckCheck } from "lucide-react";
import { createWorkspaceForClient } from "../services/agency-actions";
import type { UseCase } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

const USE_CASES: { value: UseCase; label: string; description: string }[] = [
  {
    value: "setter",
    label: "Setter",
    description: "Calificación de leads y agendamiento",
  },
  {
    value: "soporte",
    label: "Soporte",
    description: "Atención al cliente y resolución de problemas",
  },
  {
    value: "agendamiento",
    label: "Agendamiento",
    description: "Reservas y recordatorios",
  },
  {
    value: "general",
    label: "General",
    description: "Asistente virtual multipropósito",
  },
];

export function CreateWorkspaceSheet({ open, onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [clientPassword, setClientPassword] = useState("");
  const [useCase, setUseCase] = useState<UseCase>("general");
  const [webhookUrls, setWebhookUrls] = useState<{
    ycloud: string;
    kapso: string;
  } | null>(null);
  const [credentials, setCredentials] = useState<{
    email: string;
    password: string;
  } | null>(null);
  const [copied, setCopied] = useState<"ycloud" | "kapso" | null>(null);
  const [copiedCred, setCopiedCred] = useState(false);
  const [saving, startSave] = useTransition();

  function handleClose() {
    if (saving) return;
    setName("");
    setClientEmail("");
    setClientPassword("");
    setUseCase("general");
    setWebhookUrls(null);
    setCredentials(null);
    setCopied(null);
    setCopiedCred(false);
    onClose();
  }

  function handleCopy(provider: "ycloud" | "kapso") {
    if (!webhookUrls) return;
    navigator.clipboard.writeText(webhookUrls[provider]);
    setCopied(provider);
    setTimeout(() => setCopied(null), 2000);
  }

  function handleCopyCredentials() {
    if (!credentials) return;
    navigator.clipboard.writeText(
      `Email: ${credentials.email}\nContraseña: ${credentials.password}`,
    );
    setCopiedCred(true);
    setTimeout(() => setCopiedCred(false), 2000);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    startSave(async () => {
      const result = await createWorkspaceForClient({
        name,
        useCase,
        clientEmail: clientEmail || undefined,
        clientPassword: clientPassword || undefined,
      });

      if (result.error) {
        toast.error(result.error);
        return;
      }

      setWebhookUrls(result.webhookUrls ?? null);
      setCredentials(result.clientCredentials ?? null);
      toast.success("Workspace creado correctamente");
      onCreated();
    });
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) handleClose();
      }}
    >
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="font-display text-foreground">
            Nuevo cliente
          </SheetTitle>
          <SheetDescription className="text-muted-foreground">
            Da de alta un cliente (su propio workspace). Si pones su email, se
            crea su cuenta al instante con una contraseña — compártela y entra
            directo, sin correos.
          </SheetDescription>
        </SheetHeader>

        {webhookUrls ? (
          // Success state — show webhook URL
          <div className="mt-6 space-y-5">
            {credentials && (
              <div className="rounded-lg border border-warning/30 bg-warning/5 p-4 space-y-2">
                <p className="text-sm font-medium text-foreground">
                  Credenciales del cliente
                </p>
                <p className="text-xs text-muted-foreground">
                  Compártelas con tu cliente. No se vuelven a mostrar.
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
                  onClick={handleCopyCredentials}
                >
                  {copiedCred ? (
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

            <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-2">
              <p className="text-sm font-medium text-foreground">
                Workspace creado
              </p>
              <p className="text-xs text-muted-foreground">
                El cliente elige su proveedor de WhatsApp en Configuración →
                Integraciones. Comparte la URL de webhook del que vaya a usar:
              </p>
              {(["ycloud", "kapso"] as const).map((provider) => (
                <div key={provider} className="space-y-1 mt-1">
                  <p className="text-xs font-medium text-foreground">
                    {provider === "kapso" ? "Kapso (Estados Unidos)" : "YCloud"}
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 rounded bg-muted px-2 py-1.5 font-mono text-xs text-foreground break-all">
                      {webhookUrls[provider]}
                    </code>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="shrink-0"
                      aria-label={`Copiar URL de ${provider === "kapso" ? "Kapso" : "YCloud"}`}
                      onClick={() => handleCopy(provider)}
                    >
                      {copied === provider ? (
                        <CheckCheck
                          className="h-4 w-4 text-primary"
                          aria-hidden="true"
                        />
                      ) : (
                        <Copy className="h-4 w-4" aria-hidden="true" />
                      )}
                    </Button>
                  </div>
                </div>
              ))}
            </div>

            <Button variant="outline" className="w-full" onClick={handleClose}>
              Cerrar
            </Button>
          </div>
        ) : (
          // Creation form
          <form onSubmit={handleSubmit} className="mt-6 space-y-5">
            <div className="space-y-2">
              <Label
                htmlFor="ws-name"
                className="text-sm font-medium text-foreground"
              >
                Nombre del negocio
                <span className="ml-1 text-destructive" aria-hidden="true">
                  *
                </span>
              </Label>
              <Input
                id="ws-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ej: Clínica Dental Norte"
                required
                disabled={saving}
                aria-required="true"
              />
            </div>

            <div className="space-y-2">
              <Label
                htmlFor="ws-email"
                className="text-sm font-medium text-foreground"
              >
                Email del cliente
                <span className="ml-1 text-muted-foreground text-xs">
                  (opcional)
                </span>
              </Label>
              <Input
                id="ws-email"
                type="email"
                value={clientEmail}
                onChange={(e) => setClientEmail(e.target.value)}
                placeholder="cliente@empresa.com"
                disabled={saving}
              />
              <p className="text-xs text-muted-foreground">
                Se crea su cuenta al instante (rol admin). Sin correos: le
                compartes las credenciales y entra directo.
              </p>
            </div>

            <div className="space-y-2">
              <Label
                htmlFor="ws-password"
                className="text-sm font-medium text-foreground"
              >
                Contraseña del cliente
                <span className="ml-1 text-muted-foreground text-xs">
                  (opcional)
                </span>
              </Label>
              <Input
                id="ws-password"
                type="text"
                value={clientPassword}
                onChange={(e) => setClientPassword(e.target.value)}
                placeholder="Se genera una segura si lo dejas vacío"
                disabled={saving}
                autoComplete="off"
              />
            </div>

            <div className="space-y-2">
              <Label
                htmlFor="ws-usecase"
                className="text-sm font-medium text-foreground"
              >
                Caso de uso
              </Label>
              <Select
                value={useCase}
                onValueChange={(v) => setUseCase(v as UseCase)}
                disabled={saving}
              >
                <SelectTrigger id="ws-usecase">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {USE_CASES.map((uc) => (
                    <SelectItem key={uc.value} value={uc.value}>
                      <span className="font-medium">{uc.label}</span>
                      <span className="ml-1.5 text-muted-foreground text-xs">
                        — {uc.description}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={saving || !name.trim()}
              aria-busy={saving}
            >
              {saving ? "Dando de alta..." : "Dar de alta cliente"}
            </Button>
          </form>
        )}
      </SheetContent>
    </Sheet>
  );
}
