import { createClient as createSbClient } from "@supabase/supabase-js";
import type {
  NormalizedInbound,
  OutboundEcho,
} from "./kapso-webhook-handler";
import type { ContactRow, ConversationRow, MessageRow } from "../types/index";
import type { ConversationState } from "./state-machine";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

/** Default country code when a workspace hasn't configured one (Mexico). */
export const DEFAULT_COUNTRY_CODE = "52";

/**
 * Normalises a phone string to E.164 format.
 * - Trims whitespace and separators, prepends '+' if missing.
 * - When the number arrives WITHOUT a country code (no '+', national length
 *   ≤ 10 digits), prepends the workspace's `defaultCountryCode`.
 */
export function normalizePhone(
  phone: string,
  defaultCountryCode?: string,
): string {
  const trimmed = phone.trim().replace(/[\s\-()]/g, "");
  if (trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (defaultCountryCode && digits.length > 0 && digits.length <= 10) {
    return `+${defaultCountryCode}${digits}`;
  }
  return `+${digits}`;
}

export interface ProcessInboundResult {
  contact: ContactRow;
  conversation: ConversationRow;
  message: MessageRow | null;
}

/**
 * Persists an inbound message and its related contact/conversation records.
 *
 * - Upserts the contact (by workspace_id + phone).
 * - Upserts the conversation (by workspace_id + contact_id + channel),
 *   incrementing unread_count and refreshing last_message_at.
 * - Inserts the message, deduplicating on workspace_id + wamid.
 *   Returns message: null when the wamid already exists.
 */
export async function processInbound(
  workspaceId: string,
  normalized: NormalizedInbound,
): Promise<ProcessInboundResult> {
  const supabase = svc();

  // Per-workspace default country code for numbers without one.
  const { data: biRow } = await supabase
    .from("business_info")
    .select("structured")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const defaultCc =
    ((biRow?.structured as { default_country_code?: string } | null)
      ?.default_country_code as string) ?? DEFAULT_COUNTRY_CODE;

  const phone = normalizePhone(normalized.from, defaultCc);

  // 1. Upsert contact
  // A user messaging the business first is implicit opt-in for service
  // messages within the 24h window, so inbound contacts are opted in.
  // (STOP-keyword opt-out handling is future work and would guard this.)
  const { data: contactData, error: contactError } = await supabase
    .from("contacts")
    .upsert(
      {
        workspace_id: workspaceId,
        phone,
        // Only update name when the incoming value is non-null
        name: normalized.customerName,
        opt_in: true,
        opt_in_at: new Date().toISOString(),
      },
      {
        onConflict: "workspace_id,phone",
        ignoreDuplicates: false,
      },
    )
    .select()
    .single();

  if (contactError || !contactData) {
    throw new Error(
      `[normalizer] contact upsert failed: ${contactError?.message}`,
    );
  }

  const contact = contactData as ContactRow;

  // 2. Upsert conversation — reset 24h window on every inbound
  const windowExpiresAt = new Date(
    Date.now() + 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data: convData, error: convError } = await supabase
    .from("conversations")
    .upsert(
      {
        workspace_id: workspaceId,
        contact_id: contact.id,
        channel: "whatsapp",
        last_message_at: new Date().toISOString(),
        window_expires_at: windowExpiresAt,
        unread_count: 1,
      },
      {
        onConflict: "workspace_id,contact_id,channel",
        ignoreDuplicates: false,
      },
    )
    .select()
    .single();

  if (convError || !convData) {
    throw new Error(
      `[normalizer] conversation upsert failed: ${convError?.message}`,
    );
  }

  const conversation = convData as ConversationRow;

  // 3. Insert message — deduplicate on wamid
  const { data: msgData, error: msgError } = await supabase
    .from("messages")
    .upsert(
      {
        workspace_id: workspaceId,
        conversation_id: conversation.id,
        direction: "in" as const,
        type: normalized.type,
        body: normalized.text,
        wamid: normalized.wamid,
        status: "delivered",
        meta: { from_name: normalized.customerName },
      },
      {
        onConflict: "workspace_id,wamid",
        ignoreDuplicates: true,
      },
    )
    .select()
    .single();

  // ignoreDuplicates: true means a conflict returns no rows — treat as dedup
  if (msgError && msgError.code !== "PGRST116") {
    throw new Error(`[normalizer] message insert failed: ${msgError?.message}`);
  }

  const message = msgData ? (msgData as MessageRow) : null;

  // F8-D1: media download hooks in here when message.type !== 'text' and message is not a dedup.
  // The webhook handler extracts the media `link` from the raw Kapso payload and passes it
  // alongside the NormalizedInbound. Once available, the call pattern is:
  //
  //   if (message && normalized.mediaLink && normalized.type !== 'text') {
  //     void downloadAndStoreMedia({ link: normalized.mediaLink, apiKey, workspaceId, ... })
  //       .then((meta) => meta && patchMessageMedia(workspaceId, message.id, meta))
  //   }
  //
  // See media-handler.ts for downloadAndStoreMedia() and patchMessageMedia().
  // NormalizedInbound extension (mediaLink field) + webhook wiring is D2 scope.

  return { contact, conversation, message };
}

export interface ProcessEchoResult {
  /** Null when the echo belongs to a conversation we've never seen */
  conversationId: string | null;
  /** False when the wamid was already recorded */
  inserted: boolean;
  /** True when this echo handed the conversation to the human */
  aiDisabled: boolean;
}

/**
 * Records a message the business sent from the WhatsApp Business App
 * (coexistence) and hands the conversation over to the human.
 *
 * Turning `ai_enabled` off is the point: someone picked up the phone and
 * answered, so the agent must stop replying over them. It is the same handoff
 * the app already has, just triggered from the phone instead of the inbox — and
 * the operator re-enables it there when they're done.
 *
 * Deliberately does NOT touch `window_expires_at`: only inbound messages reopen
 * Meta's 24h window, and an outbound must never appear to extend it.
 */
export async function processOutboundEcho(
  workspaceId: string,
  echo: OutboundEcho,
): Promise<ProcessEchoResult> {
  const supabase = svc();

  const { data: biRow } = await supabase
    .from("business_info")
    .select("structured")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const defaultCc =
    ((biRow?.structured as { default_country_code?: string } | null)
      ?.default_country_code as string) ?? DEFAULT_COUNTRY_CODE;

  const phone = normalizePhone(echo.to, defaultCc);

  // Look up rather than upsert: an echo is not opt-in evidence, and a business
  // messaging someone first must not silently mark them as having consented.
  const { data: contactRow } = await supabase
    .from("contacts")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("phone", phone)
    .maybeSingle();

  if (!contactRow) {
    // The human started a brand-new thread from their phone. We have no contact
    // and no consent record, so we don't invent either.
    return { conversationId: null, inserted: false, aiDisabled: false };
  }

  const contactId = (contactRow as { id: string }).id;

  const { data: convRow } = await supabase
    .from("conversations")
    .select("id, state, ai_enabled")
    .eq("workspace_id", workspaceId)
    .eq("contact_id", contactId)
    .eq("channel", "whatsapp")
    .maybeSingle();

  if (!convRow) {
    return { conversationId: null, inserted: false, aiDisabled: false };
  }

  const conversation = convRow as {
    id: string;
    state: ConversationState;
    ai_enabled: boolean;
  };

  const { data: msgData, error: msgError } = await supabase
    .from("messages")
    .upsert(
      {
        workspace_id: workspaceId,
        conversation_id: conversation.id,
        direction: "out" as const,
        type: echo.type,
        body: echo.text,
        wamid: echo.wamid,
        status: "sent",
        // `origin` is what lets the 24h guard recognise this as a record of an
        // already-delivered message rather than a new send.
        meta: { origin: "business_app" },
      },
      { onConflict: "workspace_id,wamid", ignoreDuplicates: true },
    )
    .select()
    .single();

  if (msgError && msgError.code !== "PGRST116") {
    throw new Error(`[normalizer] echo insert failed: ${msgError.message}`);
  }

  // Duplicate delivery — Kapso retries, and its signature has no replay window.
  if (!msgData) {
    return {
      conversationId: conversation.id,
      inserted: false,
      aiDisabled: false,
    };
  }

  // Hand the conversation to the human. This must go through applyTransition,
  // not a manual ai_enabled flip: the buffer's decision engine gates on
  // conversations.state, so flipping the flag alone would leave the agent
  // replying over the person. 'human_active' (not 'handoff_pending') is the
  // right target — somebody already answered, so notifying the team to pick it
  // up would be wrong.
  let aiDisabled = false;
  if (conversation.state !== "human_active") {
    const { applyTransition } = await import("./decision-engine");
    const { canTransition } = await import("./state-machine");
    if (canTransition(conversation.state, "human_active")) {
      try {
        await applyTransition(conversation.id, "human_active", {
          trigger: "business_app",
        });
        aiDisabled = true;
      } catch (err) {
        // A committed message beats a failed transition — log and move on.
        console.error(
          "[normalizer] echo handoff transition failed:",
          err instanceof Error ? err.message : "unknown",
        );
      }
    }
  }

  await supabase
    .from("conversations")
    .update({ last_message_at: echo.createTime })
    .eq("id", conversation.id);

  return { conversationId: conversation.id, inserted: true, aiDisabled };
}
