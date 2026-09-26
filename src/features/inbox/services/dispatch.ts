/**
 * dispatch.ts — SEC-04 single exit point for ALL outbound messages.
 *
 * ONLY dispatchText and dispatchTemplate should call sendText / sendTemplate.
 * No other module should invoke those functions directly for user-facing sends.
 */

import { createClient as createSbClient } from "@supabase/supabase-js";
import { formatWhatsAppMarkdown } from "./text-formatter";
import {
  decryptWhatsAppCredentials,
  loadWhatsAppIntegration,
  WHATSAPP_NOT_CONNECTED,
} from "./whatsapp-provider";
import {
  whatsappSender,
  WhatsAppConfigError,
  type TemplateComponents,
  type WhatsAppSender,
} from "./whatsapp-sender";
import { YCloudError } from "./ycloud-client";
import { KapsoError } from "./kapso-client";
import {
  parseWhatsAppError,
  formatErrorForLog,
  recordMessageError,
  wasNotAccepted,
  GENERIC_SEND_ERROR,
  WINDOW_EXPIRED_MESSAGE,
  OPT_OUT_MESSAGE,
  type WhatsAppError,
} from "./whatsapp-errors";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Parameter interfaces
// ──────────────────────────────────────────────────────────────────────────────

export interface DispatchTextParams {
  workspaceId: string;
  conversationId: string;
  body: string;
  /** null = AI-generated, set = human agent */
  senderUserId?: string;
  /** Admin bypass for expired window — triggers a WINDOW_OVERRIDE DB log */
  overrideAdmin?: boolean;
  /**
   * When false, a failure WhatsApp is known not to have accepted (rate limits)
   * is returned as `retryable` without storing a failed message: the caller
   * will send the same text again. The buffer passes false on every attempt
   * but its last, so the inbox shows one failure, not one per attempt.
   */
  recordRetryableFailure?: boolean;
}

export interface DispatchTemplateParams {
  workspaceId: string;
  conversationId: string;
  templateName: string;
  /** Defaults to 'es'. NEVER use 'es_PA' — Movinsa gotcha */
  templateLanguage?: string;
  components?: TemplateComponents;
  senderUserId?: string;
}

export interface DispatchResult {
  ok: boolean;
  wamid?: string;
  /** Spanish text for the team. Never provider detail. */
  error?: string;
  /** Stable code for callers to branch on — never parse `error`. */
  errorCode?:
    | "WINDOW_EXPIRED"
    | "OPT_OUT"
    | "SEND_FAILED"
    | "DB_ERROR"
    | "NOT_FOUND";
  /**
   * True only when WhatsApp is known not to have accepted the message, so
   * sending the same text again cannot duplicate it.
   */
  retryable?: boolean;
}

/**
 * Translates a failed send. Provider errors carry the whole response body
 * (Meta's code sits inside it); a missing setting already names itself in
 * Spanish; anything else is a network-level failure where the message may or
 * may not have left.
 */
function toWhatsAppError(sendErr: unknown): WhatsAppError {
  if (sendErr instanceof YCloudError || sendErr instanceof KapsoError) {
    return parseWhatsAppError(sendErr.body, sendErr.status);
  }
  if (sendErr instanceof WhatsAppConfigError) {
    return {
      code: null,
      message: sendErr.message,
      retryable: false,
      detail: null,
      source: "unknown",
      httpStatus: null,
      fbtraceId: null,
    };
  }
  return {
    ...parseWhatsAppError(null),
    detail: sendErr instanceof Error ? sendErr.message : String(sendErr),
  };
}

/**
 * Stores a failed outbound with the team-facing reason, and the technical
 * detail in message_errors (never in `meta`, which reaches the browser).
 */
async function persistFailedMessage(
  supabase: ReturnType<typeof svc>,
  row: Record<string, unknown> & { workspace_id: string },
  waError: WhatsAppError,
): Promise<void> {
  const { data: failed, error: failedInsertError } = await supabase
    .from("messages")
    .insert({ ...row, status: "failed", error_message: waError.message })
    .select("id")
    .maybeSingle();

  if (failed?.id) {
    await recordMessageError(supabase, waError, row.workspace_id, failed.id);
  } else {
    // The send already failed; only the inbox trace is lost here.
    console.error(
      "[dispatch] failed-message insert error:",
      failedInsertError?.message ?? "insert returned no row",
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

interface ContactPhoneRow {
  phone: string;
  opt_in: boolean | null;
}

interface ConversationWindowRow {
  window_expires_at: string | null;
  contact_id: string;
}

/**
 * The sender for the workspace's active WhatsApp provider (YCloud or Kapso).
 * dispatch never names a provider itself.
 */
async function loadSender(
  workspaceId: string,
  supabase: ReturnType<typeof svc>,
): Promise<WhatsAppSender> {
  const row = await loadWhatsAppIntegration(supabase, workspaceId);
  if (!row) {
    throw new Error(`[dispatch] ${WHATSAPP_NOT_CONNECTED}`);
  }
  const credentials = await decryptWhatsAppCredentials(row, workspaceId);
  return whatsappSender(row.provider, credentials, row.config);
}

/**
 * Loads the conversation window and the contact's phone/opt-in, scoped to
 * `workspaceId`. This runs with the service role (no RLS), so the tenant
 * filter must live here: without it a conversationId from another workspace
 * would load and its contact would receive the message with this workspace's
 * credentials. Returns null when the conversation or contact is not in the
 * workspace; throws only on a database error.
 */
async function loadConversationAndPhone(
  conversationId: string,
  workspaceId: string,
  supabase: ReturnType<typeof svc>,
): Promise<{
  window_expires_at: string | null;
  toPhone: string;
  optIn: boolean;
} | null> {
  const { data: conv, error: convError } = await supabase
    .from("conversations")
    .select("window_expires_at, contact_id")
    .eq("id", conversationId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (convError) {
    throw new Error(`[dispatch] conversation lookup failed: ${convError.message}`);
  }
  if (!conv) return null;

  const convRow = conv as ConversationWindowRow;

  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("phone, opt_in")
    .eq("id", convRow.contact_id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (contactError) {
    throw new Error(`[dispatch] contact lookup failed: ${contactError.message}`);
  }
  if (!contact) return null;

  const contactRow = contact as ContactPhoneRow;
  return {
    window_expires_at: convRow.window_expires_at,
    toPhone: contactRow.phone,
    optIn: contactRow.opt_in !== false,
  };
}

const NOT_FOUND: DispatchResult = {
  ok: false,
  error: "No se encontró la conversación.",
  errorCode: "NOT_FOUND",
};
const OPT_OUT: DispatchResult = {
  ok: false,
  error: OPT_OUT_MESSAGE,
  errorCode: "OPT_OUT",
};

// ──────────────────────────────────────────────────────────────────────────────
// dispatchText — sends a free-text outbound message
// ──────────────────────────────────────────────────────────────────────────────
export async function dispatchText(
  params: DispatchTextParams,
): Promise<DispatchResult> {
  const {
    workspaceId,
    conversationId,
    body: rawBody,
    senderUserId,
    overrideAdmin = false,
    recordRetryableFailure = true,
  } = params;

  // Normalise Markdown → WhatsApp formatting (e.g. **bold** → *bold*) once, so
  // both the provider send and the persisted message match what the user receives.
  const body = formatWhatsAppMarkdown(rawBody);

  const supabase = svc();

  // 1. Load conversation window + contact phone (scoped to the workspace)
  const loaded = await loadConversationAndPhone(
    conversationId,
    workspaceId,
    supabase,
  );
  if (!loaded) return NOT_FOUND;
  const { window_expires_at, toPhone } = loaded;

  // SEC-10: Block outbound to opted-out contacts
  if (!loaded.optIn) return OPT_OUT;

  // 2. App-level 24h window guard (DB trigger is the final enforcer)
  if (
    window_expires_at !== null &&
    new Date() > new Date(window_expires_at) &&
    !overrideAdmin
  ) {
    return {
      ok: false,
      error: WINDOW_EXPIRED_MESSAGE,
      errorCode: "WINDOW_EXPIRED",
    };
  }

  // 3. Resolve the workspace's WhatsApp provider
  const sender = await loadSender(workspaceId, supabase);

  // 4. Send (skip if placeholder / dev mode). A 2xx means the message was
  // accepted for delivery. Kapso returns the WhatsApp `wamid` synchronously;
  // YCloud returns its own id and delivers the `wamid` later via a status
  // webhook, so `wamid` may still be empty here.
  let wamid: string | undefined;
  let providerMessageId: string | undefined;
  const realSend = sender.live;

  if (realSend) {
    try {
      const sent = await sender.sendText(toPhone, body);
      wamid = sent.wamid;
      providerMessageId = sent.providerMessageId;
    } catch (sendErr) {
      const waError = toWhatsAppError(sendErr);
      const retryable = wasNotAccepted(waError);
      // Technical detail: ONLY here, never in a response or the browser.
      console.error(
        `[dispatch] ${sender.label} sendText error:`,
        formatErrorForLog(waError),
      );

      if (!retryable || recordRetryableFailure) {
        await persistFailedMessage(
          supabase,
          {
            workspace_id: workspaceId,
            conversation_id: conversationId,
            direction: "out",
            type: "text",
            body,
            sender_user_id: senderUserId ?? null,
            meta: { override_admin: overrideAdmin || undefined },
          },
          waError,
        );
      }

      return {
        ok: false,
        error: waError.message,
        errorCode: "SEND_FAILED",
        retryable,
      };
    }
  }

  // 5. Persist outbound message
  // The DB trigger trg_messages_24h_window fires here — if override_admin is set
  // and window is expired, the trigger logs WINDOW_OVERRIDE and allows the insert.
  const { error: insertError } = await supabase.from("messages").insert({
    workspace_id: workspaceId,
    conversation_id: conversationId,
    direction: "out",
    type: "text",
    body,
    wamid: wamid ?? null,
    // A real send is 'sent'; only a placeholder key stays a dev no-op.
    status: realSend ? "sent" : "queued",
    sender_user_id: senderUserId ?? null,
    meta: {
      dev_mode: realSend ? undefined : true,
      // YCloud's own message id, kept to reconcile its status webhooks.
      ycloud_id: sender.provider === "ycloud" ? providerMessageId : undefined,
      override_admin: overrideAdmin || undefined,
    },
  });

  if (insertError) {
    // The trg_messages_24h_window trigger raises 'WINDOW_EXPIRED: …' in
    // English: translate it, never return database text to the team.
    console.error("[dispatch] message insert error:", insertError.message);
    const isWindow = insertError.message.includes("WINDOW_EXPIRED");
    return {
      ok: false,
      error: isWindow ? WINDOW_EXPIRED_MESSAGE : GENERIC_SEND_ERROR,
      errorCode: isWindow ? "WINDOW_EXPIRED" : "DB_ERROR",
    };
  }

  // 6. Refresh conversation last_message_at
  await supabase
    .from("conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", conversationId);

  return { ok: true, wamid };
}

// ──────────────────────────────────────────────────────────────────────────────
// dispatchTemplate — sends an approved template (bypasses 24h window)
// ──────────────────────────────────────────────────────────────────────────────
export async function dispatchTemplate(
  params: DispatchTemplateParams,
): Promise<DispatchResult> {
  const {
    workspaceId,
    conversationId,
    templateName,
    templateLanguage = "es",
    components,
    senderUserId,
  } = params;

  const supabase = svc();

  // 1. Load contact phone (templates bypass the window guard entirely)
  const loaded = await loadConversationAndPhone(
    conversationId,
    workspaceId,
    supabase,
  );
  if (!loaded) return NOT_FOUND;
  const { toPhone } = loaded;

  // SEC-10: Block outbound to opted-out contacts
  if (!loaded.optIn) return OPT_OUT;

  // 2. Resolve the workspace's WhatsApp provider
  const sender = await loadSender(workspaceId, supabase);

  // 3. Send the template
  let wamid: string | undefined;
  let providerMessageId: string | undefined;
  const realSend = sender.live;

  if (realSend) {
    try {
      const sent = await sender.sendTemplate({
        to: toPhone,
        templateName,
        language: templateLanguage,
        components,
      });
      wamid = sent.wamid;
      providerMessageId = sent.providerMessageId;
    } catch (sendErr) {
      const waError = toWhatsAppError(sendErr);
      console.error(
        `[dispatch] ${sender.label} sendTemplate error:`,
        formatErrorForLog(waError),
      );

      await persistFailedMessage(
        supabase,
        {
          workspace_id: workspaceId,
          conversation_id: conversationId,
          direction: "out",
          type: "template",
          body: templateName,
          sender_user_id: senderUserId ?? null,
          meta: { template_name: templateName },
        },
        waError,
      );

      return {
        ok: false,
        error: waError.message,
        errorCode: "SEND_FAILED",
        retryable: wasNotAccepted(waError),
      };
    }
  }

  // 4. Persist template message — type='template' bypasses DB trigger
  const { error: insertError } = await supabase.from("messages").insert({
    workspace_id: workspaceId,
    conversation_id: conversationId,
    direction: "out",
    type: "template",
    body: templateName,
    wamid: wamid ?? null,
    // Same rule as dispatchText: a real send was accepted by the provider
    // ('sent'); only a placeholder key in dev mode stays 'queued'.
    status: realSend ? "sent" : "queued",
    sender_user_id: senderUserId ?? null,
    meta: {
      template_name: templateName,
      template_language: templateLanguage,
      dev_mode: realSend ? undefined : true,
      // YCloud's own message id, kept to reconcile its status webhooks.
      ycloud_id: sender.provider === "ycloud" ? providerMessageId : undefined,
    },
  });

  if (insertError) {
    console.error("[dispatch] template insert error:", insertError.message);
    return { ok: false, error: GENERIC_SEND_ERROR, errorCode: "DB_ERROR" };
  }

  // 5. Refresh conversation last_message_at
  await supabase
    .from("conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", conversationId);

  return { ok: true, wamid };
}
