// Handoff notifications — what happens once a conversation lands in
// `handoff_pending`.
//
// Today this only covers the acknowledgement sent to the CONTACT ("someone will
// be with you shortly"). That message is free text, which is legal here because
// the contact just wrote in, so the 24h window is open and both the app-level
// guard in dispatchText() and the DB trigger check_outbound_24h_window() let it
// through.
//
// Notifying the TEAM over WhatsApp is deliberately NOT implemented yet: team
// numbers never messaged us, so there is no open window and Meta requires an
// approved HSM template. A workspace cannot have one until its WABA exists and
// is verified. See docs/handoff-notifications.md.
//
// Hard rule for everything in this module: a failed notification must never
// break or revert the handoff. Every path swallows its error and records it in
// `events` instead.

import { createClient as createSbClient } from "@supabase/supabase-js";
import { dispatchText } from "./dispatch";
import { DEFAULT_HANDOFF_ACK } from "../types/handoff";

export { DEFAULT_HANDOFF_ACK };

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

/** Don't send a second acknowledgement within this window. */
const ACK_DEDUPE_MINUTES = 15;

export interface HandoffAckConfig {
  enabled: boolean;
  message: string;
}

/**
 * Reads the per-workspace acknowledgement settings from the Kapso integration
 * config — the same jsonb bag that already carries message_history_window.
 * Defaults to enabled so a workspace that never touches the setting still gives
 * the contact a reply instead of silence.
 */
export async function getHandoffAckConfig(
  workspaceId: string,
): Promise<HandoffAckConfig> {
  const supabase = svc();

  const { data } = await supabase
    .from("integrations")
    .select("config")
    .eq("workspace_id", workspaceId)
    .eq("provider", "kapso")
    .maybeSingle();

  const config = (data?.config ?? {}) as {
    handoff_ack_enabled?: boolean;
    handoff_ack_message?: string;
  };

  const message = config.handoff_ack_message?.trim();

  return {
    enabled: config.handoff_ack_enabled !== false,
    message: message || DEFAULT_HANDOFF_ACK,
  };
}

/**
 * True when this conversation already got an acknowledgement in the last
 * ACK_DEDUPE_MINUTES. A conversation can bounce in and out of handoff_pending
 * (contact keeps writing, an agent hands it back to the AI), and each bounce
 * would otherwise re-send the same line.
 */
async function wasRecentlyAcknowledged(
  conversationId: string,
): Promise<boolean> {
  const supabase = svc();
  const since = new Date(
    Date.now() - ACK_DEDUPE_MINUTES * 60_000,
  ).toISOString();

  const { data } = await supabase
    .from("events")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("type", "handoff_ack_sent")
    .gte("created_at", since)
    .limit(1);

  return Boolean(data?.length);
}

async function logEvent(
  workspaceId: string,
  conversationId: string,
  type: string,
  level: "info" | "warn" | "error",
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await svc().from("events").insert({
      workspace_id: workspaceId,
      conversation_id: conversationId,
      type,
      level,
      payload,
    });
  } catch (err) {
    // Logging must not become the thing that breaks the handoff either.
    console.error("[handoff-notifier] failed to log event:", err);
  }
}

export interface HandoffNotifyParams {
  workspaceId: string;
  conversationId: string;
  /** What put the conversation in handoff_pending: keyword | agent | manual */
  trigger: string;
}

/**
 * Sends the contact-facing acknowledgement for a conversation that just entered
 * handoff_pending.
 *
 * Never throws. Never returns a value the caller is expected to act on — the
 * transition already happened and stands regardless of what happens here.
 */
export async function notifyHandoffPending(
  params: HandoffNotifyParams,
): Promise<void> {
  const { workspaceId, conversationId, trigger } = params;

  try {
    const config = await getHandoffAckConfig(workspaceId);

    if (!config.enabled) return;

    if (await wasRecentlyAcknowledged(conversationId)) {
      await logEvent(workspaceId, conversationId, "handoff_ack_skipped", "info", {
        reason: "deduped",
        within_minutes: ACK_DEDUPE_MINUTES,
        trigger,
      });
      return;
    }

    const result = await dispatchText({
      workspaceId,
      conversationId,
      body: config.message,
      // No senderUserId: this is system-generated, same as an AI reply.
    });

    if (result.ok) {
      await logEvent(workspaceId, conversationId, "handoff_ack_sent", "info", {
        trigger,
      });
    } else {
      // WINDOW_EXPIRED and OPT_OUT are expected outcomes, not incidents: the
      // contact may have opted out, or the trigger came from an agent long
      // after the contact's last message.
      const expected = ["WINDOW_EXPIRED", "OPT_OUT"].some((code) =>
        (result.error ?? "").startsWith(code),
      );
      await logEvent(
        workspaceId,
        conversationId,
        "handoff_ack_failed",
        expected ? "info" : "warn",
        { trigger, error: result.error },
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A workspace with no Kapso integration yet is a normal state during
    // onboarding, not an incident worth an error-level event.
    const notConnected = message.includes("Kapso integration not found");
    await logEvent(
      workspaceId,
      conversationId,
      "handoff_ack_failed",
      notConnected ? "info" : "error",
      { trigger, error: message },
    );
  }
}
