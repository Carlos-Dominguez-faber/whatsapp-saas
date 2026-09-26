/**
 * message-status.ts — applies a provider status event (sent / delivered /
 * read / failed) to the outbound message it refers to.
 *
 * Provider webhooks call it only after verifying the signature against the
 * secret of `workspaceId`, so the lookup is scoped to that workspace: a wamid
 * is unique per workspace only, and a tenant can sign events with its own
 * secret.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// WH-02: monotonic status order — never go backwards
const STATUS_ORDER = ["queued", "sent", "delivered", "read"] as const;
type OrderedStatus = (typeof STATUS_ORDER)[number];
type MessageStatus = OrderedStatus | "failed";

export async function applyMessageStatus(
  supabase: SupabaseClient,
  workspaceId: string,
  wamid: string,
  newStatus: string,
): Promise<void> {
  // Scoped to the workspace whose signing secret verified this webhook: a
  // wamid is only unique per workspace, and a tenant signs its own events.
  const { data: msg } = await supabase
    .from("messages")
    .select("id, status")
    .eq("workspace_id", workspaceId)
    .eq("wamid", wamid)
    .maybeSingle();

  // Message not found — can happen for outbound we didn't track
  if (!msg) return;

  const current = msg.status as MessageStatus | null;

  // 'failed' is terminal: a late 'sent'/'delivered' must not resurrect it.
  if (current === "failed") return;

  // 'failed' always applies over any other state
  if (newStatus === "failed") {
    await supabase
      .from("messages")
      .update({ status: "failed" })
      .eq("id", msg.id);
    return;
  }

  // For ordered statuses: only advance, never go back
  const currentIdx = current
    ? STATUS_ORDER.indexOf(current as OrderedStatus)
    : -1;
  const newIdx = STATUS_ORDER.indexOf(newStatus as OrderedStatus);

  if (newIdx > currentIdx) {
    await supabase
      .from("messages")
      .update({ status: newStatus })
      .eq("id", msg.id);
  }
  // else: same or lower status — ignore (monotonic guarantee)
}
