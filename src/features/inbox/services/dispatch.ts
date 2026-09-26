/**
 * dispatch.ts — SEC-04 single exit point for ALL outbound messages.
 *
 * ONLY dispatchText and dispatchTemplate should call sendText / sendTemplate.
 * No other module should invoke those functions directly for user-facing sends.
 *
 * Every send follows the same order: the outbound row is inserted as 'queued'
 * FIRST, then the provider is called, then the row is updated with the result.
 * - The 24h guard (trg_messages_24h_window) fires on that insert, so a message
 *   outside the window is refused before it is sent — never sent and then
 *   left unrecorded.
 * - A database error before the send means nothing left: it is retryable.
 * - After an accepted send the row already exists, so a failed update still
 *   leaves the message visible in the inbox.
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
  type SendResult,
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
  UNCONFIRMED_SEND_ERROR,
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

type Db = ReturnType<typeof svc>;

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
  /**
   * For system sends (the AI's reply): when the message is not sent because
   * of the 24h window or an opt-out, leave an internal note in the thread with
   * the text, so the team sees what the contact did not get. A person sending
   * from the composer already sees the error, so it defaults to false.
   */
  noteWhenBlocked?: boolean;
  /** Extra keys for the outbound row's meta (e.g. the buffer's batch_id). */
  meta?: Record<string, unknown>;
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
   * True only when nothing was sent — WhatsApp refused it for a reason that
   * clears with time (rate limits), or the database failed before the send —
   * so sending the same text again cannot duplicate it.
   */
  retryable?: boolean;
}

/**
 * Translates a failed send. Provider errors carry the whole response body
 * (Meta's code sits inside it); a missing setting already names itself in
 * Spanish; anything else is a network-level failure (or our own timeout)
 * where the message may or may not have left.
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
    message: UNCONFIRMED_SEND_ERROR,
    detail: sendErr instanceof Error ? sendErr.message : String(sendErr),
  };
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
async function loadSender(workspaceId: string, supabase: Db): Promise<WhatsAppSender> {
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
  supabase: Db,
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
const WINDOW_EXPIRED: DispatchResult = {
  ok: false,
  error: WINDOW_EXPIRED_MESSAGE,
  errorCode: "WINDOW_EXPIRED",
};

/**
 * A system send that never left (24h window, opt-out): an internal note in
 * the thread says so and keeps the text, which the team can still deliver
 * with a template. The 24h guard lets internal notes through.
 */
async function noteBlockedSend(
  supabase: Db,
  workspaceId: string,
  conversationId: string,
  reason: string,
  body: string,
): Promise<void> {
  const { error } = await supabase.from("messages").insert({
    workspace_id: workspaceId,
    conversation_id: conversationId,
    direction: "out",
    type: "system",
    body: `No se envió esta respuesta: ${reason}\n\n${body}`,
    status: "sent",
    meta: { internal: true, reason: "send_blocked" },
  });
  if (error) {
    console.error("[dispatch] blocked-send note failed:", error.message);
  }
}

/**
 * A send that could not even find its conversation: there is no thread to
 * leave a note in, so it goes to the workspace's events.
 */
async function logNotFound(
  supabase: Db,
  workspaceId: string,
  conversationId: string,
): Promise<void> {
  await supabase
    .from("events")
    .insert({
      type: "outbound_not_sent",
      level: "warn",
      workspace_id: workspaceId,
      payload: { reason: "conversation_not_found", conversation_id: conversationId },
    })
    .then(
      () => {},
      () => {},
    );
}

/**
 * Sends one already-queued outbound row and records the outcome on it. The row
 * was inserted before the call, so it exists whatever happens afterwards.
 */
async function sendQueuedRow(opts: {
  supabase: Db;
  sender: WhatsAppSender;
  workspaceId: string;
  rowId: string;
  rowMeta: Record<string, unknown>;
  send: () => Promise<SendResult>;
  what: string;
  /** False: a not-accepted failure removes the row; the caller re-sends. */
  recordRetryableFailure: boolean;
}): Promise<DispatchResult> {
  const { supabase, sender, workspaceId, rowId, rowMeta } = opts;

  let sent: SendResult;
  try {
    sent = await opts.send();
  } catch (sendErr) {
    const waError = toWhatsAppError(sendErr);
    const retryable = wasNotAccepted(waError);
    // Technical detail: ONLY here, never in a response or the browser.
    console.error(
      `[dispatch] ${sender.label} ${opts.what} error:`,
      formatErrorForLog(waError),
    );

    if (retryable && !opts.recordRetryableFailure) {
      // Nothing left; the caller sends the same text again. Remove the row so
      // the retry doesn't mistake it for a message already sent.
      await supabase
        .from("messages")
        .delete()
        .eq("id", rowId)
        .eq("workspace_id", workspaceId);
    } else {
      const { error: failError } = await supabase
        .from("messages")
        .update({ status: "failed", error_message: waError.message })
        .eq("id", rowId)
        .eq("workspace_id", workspaceId);
      if (failError) {
        console.error("[dispatch] failed-status update error:", failError.message);
      }
      await recordMessageError(supabase, waError, workspaceId, rowId);
    }

    return {
      ok: false,
      error: waError.message,
      errorCode: "SEND_FAILED",
      retryable,
    };
  }

  // Accepted by the provider: from here on the message exists for the
  // contact, so a failed update must not read as a failed send.
  const patch = {
    status: "sent",
    wamid: sent.wamid ?? null,
    meta: {
      ...rowMeta,
      // YCloud's own message id, kept to reconcile its status webhooks.
      ycloud_id: sender.provider === "ycloud" ? sent.providerMessageId : undefined,
    },
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const { error } = await supabase
      .from("messages")
      .update(patch)
      .eq("id", rowId)
      .eq("workspace_id", workspaceId);
    if (!error) return { ok: true, wamid: sent.wamid };
    if (attempt === 1) {
      console.error("[dispatch] sent-status update error:", error.message);
      await supabase
        .from("events")
        .insert({
          type: "outbound_status_not_recorded",
          level: "error",
          workspace_id: workspaceId,
          payload: { message_id: rowId, wamid: sent.wamid ?? null },
        })
        .then(
          () => {},
          () => {},
        );
    }
  }
  return { ok: true, wamid: sent.wamid };
}

/** Inserts the outbound row as 'queued'. Throws only on an unexpected error. */
async function insertQueuedRow(
  supabase: Db,
  row: Record<string, unknown>,
): Promise<{ id: string } | { error: string }> {
  const { data, error } = await supabase
    .from("messages")
    .insert({ ...row, status: "queued" })
    .select("id")
    .single();
  if (error || !data) {
    return { error: error?.message ?? "insert returned no row" };
  }
  return { id: data.id as string };
}

async function touchConversation(supabase: Db, conversationId: string): Promise<void> {
  await supabase
    .from("conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", conversationId);
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
    recordRetryableFailure = true,
    noteWhenBlocked = false,
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
  if (!loaded) {
    if (noteWhenBlocked) await logNotFound(supabase, workspaceId, conversationId);
    return NOT_FOUND;
  }
  const { window_expires_at, toPhone } = loaded;

  // SEC-10: Block outbound to opted-out contacts
  if (!loaded.optIn) {
    if (noteWhenBlocked) {
      await noteBlockedSend(supabase, workspaceId, conversationId, OPT_OUT_MESSAGE, body);
    }
    return OPT_OUT;
  }

  // 2. App-level 24h window guard (DB trigger is the final enforcer)
  if (
    window_expires_at !== null &&
    new Date() > new Date(window_expires_at) &&
    !overrideAdmin
  ) {
    if (noteWhenBlocked) {
      await noteBlockedSend(
        supabase,
        workspaceId,
        conversationId,
        WINDOW_EXPIRED_MESSAGE,
        body,
      );
    }
    return WINDOW_EXPIRED;
  }

  // 3. Resolve the workspace's WhatsApp provider
  const sender = await loadSender(workspaceId, supabase);
  const rowMeta: Record<string, unknown> = {
    ...(params.meta ?? {}),
    dev_mode: sender.live ? undefined : true,
    override_admin: overrideAdmin || undefined,
  };

  // 4. Queue the row. The DB trigger trg_messages_24h_window fires here: with
  // override_admin and an expired window it logs WINDOW_OVERRIDE and allows it.
  const queued = await insertQueuedRow(supabase, {
    workspace_id: workspaceId,
    conversation_id: conversationId,
    direction: "out",
    type: "text",
    body,
    sender_user_id: senderUserId ?? null,
    meta: rowMeta,
  });
  if ("error" in queued) {
    console.error("[dispatch] message insert error:", queued.error);
    if (queued.error.includes("WINDOW_EXPIRED")) {
      if (noteWhenBlocked) {
        await noteBlockedSend(
          supabase,
          workspaceId,
          conversationId,
          WINDOW_EXPIRED_MESSAGE,
          body,
        );
      }
      return WINDOW_EXPIRED;
    }
    // Nothing was sent: safe to try again.
    return {
      ok: false,
      error: GENERIC_SEND_ERROR,
      errorCode: "DB_ERROR",
      retryable: true,
    };
  }

  // 5. Dev mode (placeholder key): the queued row is the whole record.
  if (!sender.live) {
    await touchConversation(supabase, conversationId);
    return { ok: true };
  }

  // 6. Send and record the outcome on the row
  const result = await sendQueuedRow({
    supabase,
    sender,
    workspaceId,
    rowId: queued.id,
    rowMeta,
    send: () => sender.sendText(toPhone, body),
    what: "sendText",
    recordRetryableFailure,
  });

  if (result.ok) await touchConversation(supabase, conversationId);
  return result;
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
  const rowMeta: Record<string, unknown> = {
    template_name: templateName,
    template_language: templateLanguage,
    dev_mode: sender.live ? undefined : true,
  };

  // 3. Queue the row — type='template' bypasses the 24h trigger
  const queued = await insertQueuedRow(supabase, {
    workspace_id: workspaceId,
    conversation_id: conversationId,
    direction: "out",
    type: "template",
    body: templateName,
    sender_user_id: senderUserId ?? null,
    meta: rowMeta,
  });
  if ("error" in queued) {
    console.error("[dispatch] template insert error:", queued.error);
    return {
      ok: false,
      error: GENERIC_SEND_ERROR,
      errorCode: "DB_ERROR",
      retryable: true,
    };
  }

  if (!sender.live) {
    await touchConversation(supabase, conversationId);
    return { ok: true };
  }

  // 4. Send and record the outcome on the row
  const result = await sendQueuedRow({
    supabase,
    sender,
    workspaceId,
    rowId: queued.id,
    rowMeta,
    send: () =>
      sender.sendTemplate({
        to: toPhone,
        templateName,
        language: templateLanguage,
        components,
      }),
    what: "sendTemplate",
    recordRetryableFailure: true,
  });

  if (result.ok) await touchConversation(supabase, conversationId);
  return result;
}
