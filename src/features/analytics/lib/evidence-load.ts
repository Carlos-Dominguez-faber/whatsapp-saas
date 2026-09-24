/**
 * Una Server Action puede RECHAZAR (red caída,
 * deploy nuevo, respuesta cortada) además de devolver `{ error }`. Sin esto, el
 * diálogo de evidencia quedaría "Cargando…" para siempre. El rechazo se
 * convierte en el mismo `{ error }` que ya muestra la UI, sin detalle técnico.
 */
export const EVIDENCE_TRANSPORT_ERROR = "No se pudo cargar la evidencia. Revisa tu conexión e intenta de nuevo.";

export async function settleEvidence<T extends object>(
  pending: Promise<T | { error: string }>,
): Promise<T | { error: string }> {
  try {
    return await pending;
  } catch {
    return { error: EVIDENCE_TRANSPORT_ERROR };
  }
}
