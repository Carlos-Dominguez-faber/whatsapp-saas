export type ConversationState =
  | "ai_active"
  | "human_active"
  | "handoff_pending"
  | "waiting_reply"
  | "paused"
  | "closed";

export type MessageDirection = "in" | "out";

export type MessageStatus = "queued" | "sent" | "delivered" | "read" | "failed";

export type MessageType =
  | "text"
  | "audio"
  | "image"
  | "document"
  | "video"
  | "sticker"
  | "location"
  | "template"
  | "system";

export interface ContactRow {
  id: string;
  workspace_id: string;
  phone: string;
  name: string | null;
  email: string | null;
  stage: string | null;
  tags: string[] | null;
  opt_in: boolean;
  created_at: string;
  updated_at: string;
}

export interface ConversationRow {
  id: string;
  workspace_id: string;
  contact_id: string;
  channel: string;
  state: ConversationState;
  ai_enabled: boolean;
  assigned_to: string | null;
  last_message_at: string | null;
  window_expires_at: string | null;
  unread_count: number;
  created_at: string;
  updated_at: string;
}

/** Operator who sent a manual outbound message (joined from `users`). */
export interface MessageSender {
  full_name: string;
  avatar_url: string | null;
}

export interface MessageRow {
  id: string;
  workspace_id: string;
  conversation_id: string;
  direction: MessageDirection;
  type: MessageType;
  body: string | null;
  wamid: string | null;
  status: MessageStatus;
  /** Motivo en español, listo para mostrar, cuando `status` es "failed". */
  error_message: string | null;
  /** null = AI-generated, set = human operator (see `sender`). */
  sender_user_id: string | null;
  /** Joined operator info for manual messages; absent on realtime inserts. */
  sender?: MessageSender | null;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface ConversationWithContact extends ConversationRow {
  contact: ContactRow;
  last_message: Pick<MessageRow, "body" | "direction" | "created_at"> | null;
}

/**
 * Fila de `message_errors`: el detalle técnico de un envío fallido.
 *
 * SERVER-SIDE ONLY. La tabla tiene RLS activada y cero políticas a propósito,
 * así que ningún cliente la lee (ni por consulta ni por Realtime). Al operador
 * le llega `MessageRow.error_message`, el texto en español. Este tipo está acá
 * por consistencia con las demás filas, no para renderizarlo.
 */
export interface MessageErrorRow {
  id: string;
  workspace_id: string;
  message_id: string;
  /** Código numérico de Meta; null cuando el payload no traía ninguno. */
  code: number | null;
  /** Texto crudo en inglés. Jamás se muestra al usuario. */
  detail: string | null;
  source: "response" | "webhook" | "kapso" | "unknown";
  http_status: number | null;
  fbtrace_id: string | null;
  created_at: string;
}
