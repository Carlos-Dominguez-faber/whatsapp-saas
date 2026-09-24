/**
 * template-sync.ts — decisiones puras del sync de plantillas.
 *
 * Módulo puro a propósito (no importa `@/` ni Supabase) para poder testearlo con
 * `node --test`. Lo consume `templates.ts` en `syncTemplatesFromKapso`.
 */

export type TemplateStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "rejected"
  | "paused";

// Meta manda "NONE" (y a veces nada) cuando la plantilla no tiene motivo de
// rechazo, así que todo lo que no sea un motivo real colapsa a null.
const EMPTY_REASONS = new Set(["", "none", "null", "undefined"]);

/** Lee `rejected_reason` de la respuesta de Meta y normaliza los no-motivos. */
export function extractRejectionReason(raw: unknown): string | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  return text && !EMPTY_REASONS.has(text.toLowerCase()) ? text : null;
}

/**
 * Las dos columnas que un sync no puede escribir a ciegas:
 *
 * - `rejection_reason`: solo tiene sentido mientras la plantilla está rechazada.
 *   Escribir null en cada sync era lo que dejaba al operador sin saber por qué
 *   Meta la rechazó. Si Meta deja de reportar el motivo, se conserva el guardado.
 * - `approved_at`: la primera vez que la vimos aprobada, no la última corrida
 *   del sync (por eso se omite si ya está sellado).
 */
export function templateStatusPatch(
  status: TemplateStatus,
  remoteReason: string | null,
  prev:
    | { rejection_reason: string | null; approved_at: string | null }
    | undefined,
  now: string,
): { rejection_reason: string | null; approved_at?: string } {
  const patch: { rejection_reason: string | null; approved_at?: string } = {
    rejection_reason:
      status === "rejected"
        ? (remoteReason ?? prev?.rejection_reason ?? null)
        : null,
  };

  if (status === "approved" && !prev?.approved_at) {
    patch.approved_at = now;
  }

  return patch;
}
