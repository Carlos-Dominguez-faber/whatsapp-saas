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
  type TemplateComponents,
  type WhatsAppSender,
} from "./whatsapp-sender";

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
  error?: string;
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

const NOT_FOUND: DispatchResult = { ok: false, error: "CONVERSATION_NOT_FOUND" };
const OPT_OUT: DispatchResult = {
  ok: false,
  error: "OPT_OUT: contact has opted out of WhatsApp messages",
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
    return { ok: false, error: "WINDOW_EXPIRED" };
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
      const errMsg =
        sendErr instanceof Error ? sendErr.message : String(sendErr);
      console.error(`[dispatch] ${sender.label} sendText error:`, errMsg);

      // Persist failed message for audit
      await supabase.from("messages").insert({
        workspace_id: workspaceId,
        conversation_id: conversationId,
        direction: "out",
        type: "text",
        body,
        status: "failed",
        sender_user_id: senderUserId ?? null,
        meta: { error: errMsg, override_admin: overrideAdmin || undefined },
      });

      return { ok: false, error: errMsg };
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
    // Surface DB trigger errors (WINDOW_EXPIRED raised by trigger)
    console.error("[dispatch] message insert error:", insertError.message);
    return { ok: false, error: insertError.message };
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

  if (sender.live) {
    try {
      const sent = await sender.sendTemplate({
        to: toPhone,
        templateName,
        language: templateLanguage,
        components,
      });
      wamid = sent.wamid;
    } catch (sendErr) {
      const errMsg =
        sendErr instanceof Error ? sendErr.message : String(sendErr);
      console.error(`[dispatch] ${sender.label} sendTemplate error:`, errMsg);

      await supabase.from("messages").insert({
        workspace_id: workspaceId,
        conversation_id: conversationId,
        direction: "out",
        type: "template",
        body: templateName,
        status: "failed",
        sender_user_id: senderUserId ?? null,
        meta: { error: errMsg, template_name: templateName },
      });

      return { ok: false, error: errMsg };
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
    status: wamid ? "queued" : "queued",
    sender_user_id: senderUserId ?? null,
    meta: {
      template_name: templateName,
      template_language: templateLanguage,
      dev_mode: !wamid || undefined,
    },
  });

  if (insertError) {
    console.error("[dispatch] template insert error:", insertError.message);
    return { ok: false, error: insertError.message };
  }

  // 5. Refresh conversation last_message_at
  await supabase
    .from("conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", conversationId);

  return { ok: true, wamid };
}
