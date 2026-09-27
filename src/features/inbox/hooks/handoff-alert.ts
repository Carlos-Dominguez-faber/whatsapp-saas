import type {
  RealtimePostgresChangesPayload,
  RealtimePostgresUpdatePayload,
} from "@supabase/supabase-js";
import type { ConversationRow } from "@/features/inbox/types";

/**
 * ¿Este evento de `postgres_changes` es una conversación que RECIÉN entra a
 * `handoff_pending`? Solo eso merece un aviso al operador — no cada UPDATE de
 * una conversación que ya estaba esperando, y no un INSERT (una conversación
 * nunca nace en `handoff_pending`, pero si algún día lo hiciera, avisar ahí
 * abriría una segunda vía de spam sin la garantía de "una vez por
 * conversación" que da comparar contra `old`).
 */
export function isHandoffTransition(
  payload: RealtimePostgresChangesPayload<ConversationRow>,
): payload is RealtimePostgresUpdatePayload<ConversationRow> {
  if (payload.eventType !== "UPDATE") return false;
  return (
    payload.new.state === "handoff_pending" &&
    payload.old.state !== "handoff_pending"
  );
}

/**
 * Igual que `isHandoffTransition`, pero sin depender de `old`: con RLS,
 * Realtime puede mandar `old` solo con la llave primaria (sin `state`), y
 * entonces cada UPDATE de una conversación que YA estaba esperando
 * (mensajes nuevos, `last_message_at`) parecería una entrada nueva.
 * `notified` recuerda qué conversaciones ya avisaron: se agregan al entrar a
 * `handoff_pending` y se quitan al salir, así cada espera avisa una sola vez.
 */
export function shouldNotifyHandoff(
  payload: RealtimePostgresChangesPayload<ConversationRow>,
  notified: Set<string>,
): boolean {
  if (payload.eventType !== "UPDATE") return false;
  const id = payload.new.id;
  if (payload.new.state !== "handoff_pending") {
    notified.delete(id);
    return false;
  }
  if (notified.has(id)) return false;
  notified.add(id);
  // Si Realtime sí trajo el estado anterior y ya era handoff_pending, no es
  // una entrada nueva (solo faltaba en el Set, p. ej. tras recargar).
  return (payload.old as Partial<ConversationRow>).state !== "handoff_pending";
}
