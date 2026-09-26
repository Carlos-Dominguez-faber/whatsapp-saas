/**
 * message-status.ts — applies a provider status event (sent / delivered /
 * read / failed) to the outbound message it refers to.
 *
 * Provider webhooks call it only after verifying the signature against the
 * secret of `workspaceId`, so every lookup and write is scoped to that
 * workspace: a wamid is unique per workspace only, and a tenant can sign
 * events with its own secret.
 *
 * Kapso returns the wamid when the message is sent. YCloud answers with its
 * own message id and assigns the wamid later, so our row holds only
 * `meta.ycloud_id` until the first status event arrives: matching by wamid
 * alone never found it, and YCloud messages stayed on 'sent' forever. When the
 * wamid doesn't match, the event's YCloud id does, and the row gets its wamid.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { recordMessageError, type WhatsAppError } from "./whatsapp-errors";

// WH-02: monotonic status order — never go backwards
const STATUS_ORDER = ["queued", "sent", "delivered", "read"] as const;
type OrderedStatus = (typeof STATUS_ORDER)[number];
type MessageStatus = OrderedStatus | "failed";

export interface StatusEvent {
  /** WhatsApp message id, when the event carries it. */
  wamid?: string | null;
  /** The provider's own message id (YCloud's `whatsappMessage.id`). */
  providerMessageId?: string | null;
  status: string;
  /** Why it failed, already translated; only on 'failed'. */
  error?: WhatsAppError | null;
}

interface MessageMatch {
  id: string;
  status: MessageStatus | null;
  wamid: string | null;
}

/**
 * Throws on a database error: the webhook then answers 500 and the provider
 * retries, instead of reading an outage as "message not found" and losing the
 * event with a 200.
 */
async function findMessage(
  supabase: SupabaseClient,
  workspaceId: string,
  event: StatusEvent,
): Promise<MessageMatch | null> {
  if (event.wamid) {
    const { data, error } = await supabase
      .from("messages")
      .select("id, status, wamid")
      .eq("workspace_id", workspaceId)
      .eq("wamid", event.wamid)
      .maybeSingle();
    if (error) throw new Error(`[message-status] lookup failed: ${error.message}`);
    if (data) return data as MessageMatch;
  }

  if (event.providerMessageId) {
    const { data, error } = await supabase
      .from("messages")
      .select("id, status, wamid")
      .eq("workspace_id", workspaceId)
      .eq("direction", "out")
      .filter("meta->>ycloud_id", "eq", event.providerMessageId)
      .maybeSingle();
    if (error) throw new Error(`[message-status] lookup failed: ${error.message}`);
    if (data) return data as MessageMatch;
  }

  return null;
}

export async function applyMessageStatus(
  supabase: SupabaseClient,
  workspaceId: string,
  event: StatusEvent,
): Promise<void> {
  const msg = await findMessage(supabase, workspaceId, event);

  // Message not found — can happen for outbound we didn't track
  if (!msg) return;

  const current = msg.status;
  const newStatus = event.status;
  const patch: Record<string, unknown> = {};

  // Backfill the wamid YCloud assigns after the send.
  if (event.wamid && !msg.wamid) patch.wamid = event.wamid;

  // 'failed' is terminal: a late 'sent'/'delivered' must not resurrect it.
  if (current !== "failed") {
    if (newStatus === "failed") {
      patch.status = "failed";
      if (event.error) patch.error_message = event.error.message;
    } else {
      // For ordered statuses: only advance, never go back
      const currentIdx = current
        ? STATUS_ORDER.indexOf(current as OrderedStatus)
        : -1;
      const newIdx = STATUS_ORDER.indexOf(newStatus as OrderedStatus);
      if (newIdx > currentIdx) patch.status = newStatus;
    }
  }

  if (Object.keys(patch).length === 0) return;

  // The terminal guard also rides in the WHERE: a concurrent 'failed' wins
  // over a 'delivered' read a moment earlier.
  const { error } = await supabase
    .from("messages")
    .update(patch)
    .eq("id", msg.id)
    .eq("workspace_id", workspaceId)
    .or("status.is.null,status.neq.failed");
  if (error) throw new Error(`[message-status] update failed: ${error.message}`);

  if (patch.status === "failed" && event.error) {
    await recordMessageError(supabase, event.error, workspaceId, msg.id);
  }
}
