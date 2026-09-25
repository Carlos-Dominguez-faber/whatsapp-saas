import { createClient as createSbClient } from "@supabase/supabase-js";
import type { NormalizedInbound } from "./ycloud-webhook-handler";
import type { ContactRow, ConversationRow, MessageRow } from "../types/index";
import {
  buildDuplicateRepairPatch,
  buildInboundMeta,
} from "./ycloud-duplicate-repair";

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
  duplicateRepaired: boolean;
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
        meta: buildInboundMeta(normalized),
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
  let duplicateRepaired = false;

  if (!message) {
    const { data: existingData, error: existingError } = await supabase
      .from("messages")
      .select("id, type, body, meta")
      .eq("workspace_id", workspaceId)
      .eq("wamid", normalized.wamid)
      .maybeSingle();

    if (existingError) {
      throw new Error(
        `[normalizer] duplicate lookup failed: ${existingError.message}`,
      );
    }

    if (existingData) {
      const repair = buildDuplicateRepairPatch(
        {
          type: existingData.type as string,
          body: (existingData.body as string | null) ?? null,
          meta:
            typeof existingData.meta === "object" && existingData.meta !== null
              ? (existingData.meta as Record<string, unknown>)
              : null,
        },
        normalized,
      );

      if (repair) {
        const { error: repairError } = await supabase
          .from("messages")
          .update(repair)
          .eq("id", existingData.id)
          .eq("workspace_id", workspaceId);

        if (repairError) {
          throw new Error(
            `[normalizer] duplicate repair failed: ${repairError.message}`,
          );
        }
        duplicateRepaired = true;
      }
    }
  }

  // F8-D1: media download hooks in here when message.type !== 'text' and message is not a dedup.
  // The webhook handler extracts the media `link` from the raw YCloud payload and passes it
  // alongside the NormalizedInbound. Once available, the call pattern is:
  //
  //   if (message && normalized.mediaLink && normalized.type !== 'text') {
  //     void downloadAndStoreMedia({ link: normalized.mediaLink, apiKey, workspaceId, ... })
  //       .then((meta) => meta && patchMessageMedia(workspaceId, message.id, meta))
  //   }
  //
  // See media-handler.ts for downloadAndStoreMedia() and patchMessageMedia().
  // NormalizedInbound extension (mediaLink field) + webhook wiring is D2 scope.

  return { contact, conversation, message, duplicateRepaired };
}
