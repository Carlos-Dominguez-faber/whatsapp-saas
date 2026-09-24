/**
 * dispatch.ts — SEC-04 single exit point for ALL outbound messages.
 *
 * ONLY dispatchText and dispatchTemplate should call sendText / sendTemplate.
 * No other module should invoke those functions directly for user-facing sends.
 */

import { createClient as createSbClient } from "@supabase/supabase-js";
import { sendText, sendTemplate, KapsoError } from "./kapso-client";
import type { TemplateParams } from "./kapso-client";
import { formatWhatsAppMarkdown } from "./text-formatter";
import { decryptCredentials } from "@/shared/lib/integration-secrets";
import {
  parseWhatsAppError,
  formatErrorForLog,
  recordMessageError,
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
  /** Texto en español para el operador. Nunca detalle técnico. */
  error?: string;
  /**
   * Código estable para que los callers ramifiquen. Antes se ramificaba por el
   * prefijo del texto (`error.startsWith("WINDOW_EXPIRED")`), lo que ataba el
   * mensaje al operador al flujo de control.
   */
  errorCode?:
    | "WINDOW_EXPIRED"
    | "OPT_OUT"
    | "SEND_FAILED"
    | "DB_ERROR"
    | "NOT_FOUND";
}

/**
 * Traduce el fallo de un envío: KapsoError trae el body completo (Graph o el
 * string suelto de Kapso); `sendErr.message` solo traía el título.
 */
function toWhatsAppError(sendErr: unknown): WhatsAppError {
  return sendErr instanceof KapsoError
    ? parseWhatsAppError(sendErr.body, sendErr.status)
    : parseWhatsAppError(null);
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
  opt_in: boolean | null;
}

interface ConversationWindowRow {
  window_expires_at: string | null;
  contact_id: string;
}

async function loadIntegration(
  workspaceId: string,
  supabase: ReturnType<typeof svc>,
): Promise<{ apiKey: string; phoneNumberId: string }> {
  const { data, error } = await supabase
    .from("integrations")
    .select("credentials, config")
    .eq("workspace_id", workspaceId)
    .eq("provider", "kapso")
    .eq("enabled", true)
    .single();

  if (error || !data) {
    throw new Error(
      `[dispatch] Kapso integration not found: ${error?.message}`,
    );
  }

  const row = data as IntegrationRow;
  const creds = await decryptCredentials(row.credentials, workspaceId, "kapso");
  return {
    apiKey: (creds.kapso_api_key as string | undefined) ?? "",
    // Kapso identifies the sender by Meta's phone_number_id in the request PATH,
    // not by the E.164 number. config.phone_number is kept for the UI/CRM only.
    phoneNumberId: (row.config.phone_number_id as string | undefined) ?? "",
  };
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
  } = params;

  // Normalise Markdown → WhatsApp formatting (e.g. **bold** → *bold*) once, so
  // both the Kapso send and the persisted message match what the user receives.
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

  // 3. Load Kapso credentials
  const { apiKey, phoneNumberId } = await loadIntegration(
    workspaceId,
    supabase,
  );

  // 4. Send via Kapso (skip if placeholder / dev mode)
  // Kapso returns the WhatsApp `wamid` synchronously as messages[0].id and no
  // status of its own. A 2xx means the message was accepted for delivery; the
  // delivered/read webhooks advance the status from there.
  let wamid: string | undefined;
  const realSend = Boolean(apiKey && apiKey !== "placeholder");

  if (realSend) {
    try {
      const sent = await sendText({
        apiKey,
        phoneNumberId,
        to: toPhone,
        body,
      });
      wamid = sent.wamid || undefined;
    } catch (sendErr) {
      const waError = toWhatsAppError(sendErr);
      // Detalle técnico: SOLO acá. Ni a la respuesta HTTP ni al cliente.
      console.error(
        "[dispatch] Kapso sendText error:",
        formatErrorForLog(waError),
      );

      // Persist failed message for audit. El detalle técnico va aparte, a
      // message_errors: el meta viaja al cliente por Realtime y por el
      // select("*") del inbox.
      const { data: failed, error: failedInsertError } = await supabase
        .from("messages")
        .insert({
          workspace_id: workspaceId,
          conversation_id: conversationId,
          direction: "out",
          type: "text",
          body,
          status: "failed",
          error_message: waError.message,
          sender_user_id: senderUserId ?? null,
          meta: {
            override_admin: overrideAdmin || undefined,
          },
        })
        .select("id")
        .maybeSingle();

      if (failed?.id) {
        await recordMessageError(supabase, waError, workspaceId, failed.id);
      } else {
        // El envío ya falló; acá se pierde solo el rastro en el inbox. Se deja
        // en el log del servidor y se sigue devolviendo el motivo real del
        // fallo de envío, que es más útil al operador que un "error de base".
        console.error(
          "[dispatch] failed-message insert error:",
          failedInsertError?.message ?? "insert devolvió 0 filas",
        );
      }

      return { ok: false, error: waError.message, errorCode: "SEND_FAILED" };
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
    // A real Kapso send is 'sent'; only a placeholder key stays a dev no-op.
    status: realSend ? "sent" : "queued",
    sender_user_id: senderUserId ?? null,
    meta: {
      dev_mode: realSend ? undefined : true,
      override_admin: overrideAdmin || undefined,
    },
  });

  if (insertError) {
    // El trigger trg_messages_24h_window levanta 'WINDOW_EXPIRED: free text…'
    // en inglés: se traduce, nunca se devuelve crudo al operador.
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

  // 2. Load Kapso credentials
  const { apiKey, phoneNumberId } = await loadIntegration(
    workspaceId,
    supabase,
  );

  // 3. Send template via Kapso
  let wamid: string | undefined;
  const realSend = Boolean(apiKey && apiKey !== "placeholder");

  if (realSend) {
    try {
      const sent = await sendTemplate({
        apiKey,
        phoneNumberId,
        to: toPhone,
        templateName,
        language: templateLanguage,
        components,
      });
      wamid = sent.wamid;
    } catch (sendErr) {
      const waError = toWhatsAppError(sendErr);
      console.error(
        "[dispatch] Kapso sendTemplate error:",
        formatErrorForLog(waError),
      );

      // Igual que en dispatchText: el detalle técnico va a message_errors, no
      // al meta que el cliente sí puede leer.
      const { data: failed, error: failedInsertError } = await supabase
        .from("messages")
        .insert({
          workspace_id: workspaceId,
          conversation_id: conversationId,
          direction: "out",
          type: "template",
          body: templateName,
          status: "failed",
          error_message: waError.message,
          sender_user_id: senderUserId ?? null,
          meta: {
            template_name: templateName,
          },
        })
        .select("id")
        .maybeSingle();

      if (failed?.id) {
        await recordMessageError(supabase, waError, workspaceId, failed.id);
      } else {
        // Mismo criterio que dispatchText: el fallo de escritura se loguea
        // server-side y el resultado sigue contando el fallo real de envío.
        console.error(
          "[dispatch] failed-template insert error:",
          failedInsertError?.message ?? "insert devolvió 0 filas",
        );
      }

      return { ok: false, error: waError.message, errorCode: "SEND_FAILED" };
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
    // Mismo criterio que dispatchText: un envío real ya fue aceptado por Kapso
    // ('sent'); solo la api key placeholder del modo dev queda en 'queued'.
    status: realSend ? "sent" : "queued",
    sender_user_id: senderUserId ?? null,
    meta: {
      template_name: templateName,
      template_language: templateLanguage,
      dev_mode: realSend ? undefined : true,
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
