/**
 * dispatch.ts — SEC-04 single exit point for ALL outbound messages.
 *
 * ONLY dispatchText and dispatchTemplate should call sendText / sendTemplate.
 * No other module should invoke those functions directly for user-facing sends.
 */

import { createClient as createSbClient } from "@supabase/supabase-js";
import { sendText, sendTemplate } from "./ycloud-client";
import type { TemplateParams } from "./ycloud-client";
import { formatWhatsAppMarkdown } from "./text-formatter";
import { decryptCredentials } from "@/shared/lib/integration-secrets";

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
  components?: TemplateParams["components"];
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

interface IntegrationRow {
  credentials: Record<string, unknown>;
  config: Record<string, unknown>;
}

interface ContactPhoneRow {
  phone: string;
}

interface ConversationWindowRow {
  window_expires_at: string | null;
  contact_id: string;
}

async function loadIntegration(
  workspaceId: string,
  supabase: ReturnType<typeof svc>,
): Promise<{ apiKey: string; fromPhone: string }> {
  const { data, error } = await supabase
    .from("integrations")
    .select("credentials, config")
    .eq("workspace_id", workspaceId)
    .eq("provider", "ycloud")
    .eq("enabled", true)
    .single();

  if (error || !data) {
    throw new Error(
      `[dispatch] YCloud integration not found: ${error?.message}`,
    );
  }

  const row = data as IntegrationRow;
  const creds = await decryptCredentials(
    row.credentials,
    workspaceId,
    "ycloud",
  );
  return {
    apiKey: (creds.ycloud_api_key as string | undefined) ?? "",
    fromPhone: (row.config.phone_number as string | undefined) ?? "",
  };
}

async function loadConversationAndPhone(
  conversationId: string,
  supabase: ReturnType<typeof svc>,
): Promise<{ window_expires_at: string | null; toPhone: string }> {
  const { data: conv, error: convError } = await supabase
    .from("conversations")
    .select("window_expires_at, contact_id")
    .eq("id", conversationId)
    .single();

  if (convError || !conv) {
    throw new Error(`[dispatch] conversation not found: ${convError?.message}`);
  }

  const convRow = conv as ConversationWindowRow;

  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("phone")
    .eq("id", convRow.contact_id)
    .single();

  if (contactError || !contact) {
    throw new Error(`[dispatch] contact not found: ${contactError?.message}`);
  }

  return {
    window_expires_at: convRow.window_expires_at,
    toPhone: (contact as ContactPhoneRow).phone,
  };
}

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
  // both the YCloud send and the persisted message match what the user receives.
  const body = formatWhatsAppMarkdown(rawBody);

  const supabase = svc();

  // 1. Load conversation window + contact phone
  const { window_expires_at, toPhone } = await loadConversationAndPhone(
    conversationId,
    supabase,
  );

  // SEC-10: Block outbound to opted-out contacts
  const { data: convRow } = await supabase
    .from("conversations")
    .select("contact_id")
    .eq("id", conversationId)
    .single();

  if (convRow) {
    const { data: contactOptData } = await supabase
      .from("contacts")
      .select("opt_in")
      .eq("id", (convRow as { contact_id: string }).contact_id)
      .single();

    if (
      contactOptData &&
      (contactOptData as { opt_in: boolean }).opt_in === false
    ) {
      return {
        ok: false,
        error: "OPT_OUT: contact has opted out of WhatsApp messages",
      };
    }
  }

  // 2. App-level 24h window guard (DB trigger is the final enforcer)
  if (
    window_expires_at !== null &&
    new Date() > new Date(window_expires_at) &&
    !overrideAdmin
  ) {
    return { ok: false, error: "WINDOW_EXPIRED" };
  }

  // 3. Load YCloud credentials
  const { apiKey, fromPhone } = await loadIntegration(workspaceId, supabase);

  // 4. Send via YCloud (skip if placeholder / dev mode)
  // YCloud returns its own `id` synchronously and assigns the WhatsApp `wamid`
  // asynchronously (delivered via a status webhook). A 2xx response means the
  // message was accepted for delivery, even when `wamid` is still empty.
  let wamid: string | undefined;
  let ycloudId: string | undefined;
  const realSend = Boolean(apiKey && apiKey !== "placeholder");

  if (realSend) {
    try {
      const sent = await sendText({
        apiKey,
        from: fromPhone,
        to: toPhone,
        body,
      });
      wamid = sent.wamid || undefined;
      ycloudId = sent.id || undefined;
    } catch (sendErr) {
      const errMsg =
        sendErr instanceof Error ? sendErr.message : String(sendErr);
      console.error("[dispatch] YCloud sendText error:", errMsg);

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
    // A real YCloud send is 'sent'; only a placeholder key stays a dev no-op.
    status: realSend ? "sent" : "queued",
    sender_user_id: senderUserId ?? null,
    meta: {
      dev_mode: realSend ? undefined : true,
      ycloud_id: ycloudId,
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
  const { toPhone } = await loadConversationAndPhone(conversationId, supabase);

  // SEC-10: Block outbound to opted-out contacts
  const { data: tplConvRow } = await supabase
    .from("conversations")
    .select("contact_id")
    .eq("id", conversationId)
    .single();

  if (tplConvRow) {
    const { data: tplOptData } = await supabase
      .from("contacts")
      .select("opt_in")
      .eq("id", (tplConvRow as { contact_id: string }).contact_id)
      .single();

    if (tplOptData && (tplOptData as { opt_in: boolean }).opt_in === false) {
      return {
        ok: false,
        error: "OPT_OUT: contact has opted out of WhatsApp messages",
      };
    }
  }

  // 2. Load YCloud credentials
  const { apiKey, fromPhone } = await loadIntegration(workspaceId, supabase);

  // 3. Send template via YCloud
  let wamid: string | undefined;

  if (apiKey && apiKey !== "placeholder") {
    try {
      const sent = await sendTemplate({
        apiKey,
        from: fromPhone,
        to: toPhone,
        templateName,
        language: templateLanguage,
        components,
      });
      wamid = sent.wamid;
    } catch (sendErr) {
      const errMsg =
        sendErr instanceof Error ? sendErr.message : String(sendErr);
      console.error("[dispatch] YCloud sendTemplate error:", errMsg);

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
