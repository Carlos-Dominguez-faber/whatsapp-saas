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
import { recordAutomationSendFailure } from "@/features/automations/services/send-failure";

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
  meta?: Record<string, unknown> | null;
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
      .select("id, status, wamid, meta")
      .eq("workspace_id", workspaceId)
      .eq("wamid", event.wamid)
      .limit(1);
    if (error) throw new Error(`[message-status] lookup failed: ${error.message}`);
    if (data?.[0]) return data[0] as MessageMatch;
  }

  if (event.providerMessageId) {
    // A containment filter, so the GIN (jsonb_path_ops) index on
    // messages.meta serves it; `meta->>ycloud_id` would scan the workspace.
    const { data, error } = await supabase
      .from("messages")
      .select("id, status, wamid, meta")
      .eq("workspace_id", workspaceId)
      .eq("direction", "out")
      .contains("meta", { ycloud_id: event.providerMessageId })
      .limit(1);
    if (error) throw new Error(`[message-status] lookup failed: ${error.message}`);
    if (data?.[0]) return data[0] as MessageMatch;
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

  // Backfill the wamid YCloud assigns after the send — on its own, so a
  // status that doesn't move still leaves the row findable by wamid.
  if (event.wamid && !msg.wamid) {
    const { error } = await supabase
      .from("messages")
      .update({ wamid: event.wamid })
      .eq("id", msg.id)
      .eq("workspace_id", workspaceId)
      .is("wamid", null);
    if (error) throw new Error(`[message-status] wamid backfill failed: ${error.message}`);
  }

  // 'failed' is terminal: a late 'sent'/'delivered' must not resurrect it.
  if (current === "failed") return;

  let patch: Record<string, unknown>;
  let allowedFrom: string;
  if (newStatus === "failed") {
    // An automation's template that failed after the send: close its run and,
    // for a paused template, its rule. Before the message update, so a
    // database error here is retried with the whole event.
    await recordAutomationSendFailure(
      supabase,
      workspaceId,
      msg.meta,
      typeof event.error?.code === "number" ? event.error.code : null,
    );
    patch = { status: "failed" };
    if (event.error) patch.error_message = event.error.message;
    allowedFrom = "status.is.null,status.neq.failed";
  } else {
    // For ordered statuses: only advance, never go back
    const currentIdx = current
      ? STATUS_ORDER.indexOf(current as OrderedStatus)
      : -1;
    const newIdx = STATUS_ORDER.indexOf(newStatus as OrderedStatus);
    if (newIdx <= currentIdx) return;
    patch = { status: newStatus };
    // The monotonic rule rides in the WHERE too: two webhooks racing (read
    // and delivered arrive together) can't move 'read' back to 'delivered'.
    const lower = STATUS_ORDER.slice(0, newIdx);
    allowedFrom = lower.length
      ? `status.is.null,status.in.(${lower.join(",")})`
      : "status.is.null";
  }

  const { error } = await supabase
    .from("messages")
    .update(patch)
    .eq("id", msg.id)
    .eq("workspace_id", workspaceId)
    .or(allowedFrom);
  if (error) throw new Error(`[message-status] update failed: ${error.message}`);

  if (patch.status === "failed" && event.error) {
    await recordMessageError(supabase, event.error, workspaceId, msg.id);
  }
}
