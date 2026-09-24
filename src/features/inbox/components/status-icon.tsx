import { AlertCircle, Check, CheckCheck, Clock } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { MessageStatus } from "@/features/inbox/types";
import { GENERIC_SEND_ERROR } from "@/features/inbox/services/whatsapp-errors";
import { cn } from "@/lib/utils";

interface StatusIconProps {
  status: MessageStatus | null;
  /**
   * Texto en español ya listo para mostrar (`messages.error_message`).
   * NUNCA pasar aquí nada de `message_errors`: el código, el fbtrace_id y el
   * detalle en inglés son server-side y no salen a la UI ni a la consola.
   */
  errorMessage?: string | null;
}

export function StatusIcon({ status, errorMessage }: StatusIconProps) {
  if (!status) return null;

  switch (status) {
    case "queued":
      return (
        <Clock
          className={cn("h-3 w-3 shrink-0 opacity-50")}
          aria-label="En cola"
        />
      );
    case "sent":
      return (
        <Check
          className={cn("h-3 w-3 shrink-0 opacity-60")}
          aria-label="Enviado"
        />
      );
    case "delivered":
      return (
        <CheckCheck
          className={cn("h-3 w-3 shrink-0 opacity-60")}
          aria-label="Entregado"
        />
      );
    case "read":
      return (
        <CheckCheck
          className={cn("h-3 w-3 shrink-0 text-primary")}
          aria-label="Leído"
        />
      );
    case "failed": {
      // Los fallidos anteriores a este cambio no traen texto: fallback digno.
      const reason = errorMessage?.trim() || GENERIC_SEND_ERROR;
      // Popover y no Tooltip — abre con tap en móvil y con click en
      // escritorio sin montar un TooltipProvider en el layout.
      return (
        <Popover>
          <PopoverTrigger
            className="shrink-0 rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-destructive"
            aria-label={`Fallido: ${reason}`}
          >
            <AlertCircle
              className="h-3 w-3 text-destructive"
              aria-hidden="true"
            />
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-64 p-3 text-xs leading-relaxed"
          >
            {reason}
          </PopoverContent>
        </Popover>
      );
    }
    default:
      return null;
  }
}
