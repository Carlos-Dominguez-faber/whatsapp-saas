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
