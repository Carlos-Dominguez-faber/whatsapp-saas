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
  /**
   * Solo con errorCode "SEND_FAILED": true cuando Meta/Kapso indica que
   * reintentar el mismo envío tiene sentido (rate limit, caída transitoria).
   * Refleja WhatsAppError.retryable para que el buffer reencole en vez de
   * dar la respuesta por perdida.
   */
  retryable?: boolean;
  /**
   * Código numérico de Meta (`waError.code`), solo con errorCode "SEND_FAILED".
   * Uso interno del motor (ej. distinguir 132015 = plantilla pausada): NUNCA
   * mostrarlo en UI, toast, respuesta HTTP ni columna que lea un miembro del
   * workspace. undefined si Meta no lo mandó o no era numérico.
   */
  providerCode?: number;
}

/**
 * Traduce el fallo de un envío: KapsoError trae el body completo (Graph o el
 * string suelto de Kapso); `sendErr.message` solo traía el título.
 */
function toWhatsAppError(sendErr: unknown): WhatsAppError {
  if (sendErr instanceof KapsoError) {
    return parseWhatsAppError(sendErr.body, sendErr.status);
  }
  // No es KapsoError: sendText/sendTemplate falló antes de recibir una
  // respuesta HTTP (red caída, DNS, timeout) — el patrón de caída más común.
  // Tratarlo como retryable para que el buffer realmente reencole en vez
  // de dar la respuesta por perdida; un KapsoError con status permanente real
  // sigue yendo por el catálogo de arriba.
  return { ...parseWhatsAppError(null), retryable: true };
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

  return kapsoCredentials(workspaceId, data as IntegrationRow);
}

/**
 * Las dos credenciales de Kapso de una fila de `integrations`. Un solo lugar
 * porque `loadIntegration` y `prepareTemplateDispatch` las leen igual y
 * desincronizarlas es cómo se rompe el envío de una de las dos rutas.
 * Lanza si una credencial cifrada no se puede descifrar.
 */
async function kapsoCredentials(
  workspaceId: string,
  row: IntegrationRow,
): Promise<{ apiKey: string; phoneNumberId: string }> {
  const creds = await decryptCredentials(row.credentials, workspaceId, "kapso");
  return {
    apiKey: (creds.kapso_api_key as string | undefined) ?? "",
    // Kapso identifies the sender by Meta's phone_number_id in the request PATH,
    // not by the E.164 number. config.phone_number is kept for the UI/CRM only.
    phoneNumberId: (row.config.phone_number_id as string | undefined) ?? "",
  };
}

type LoadFailure =
  | { ok: false; errorCode: "DB_ERROR"; error: string }
  | { ok: false; errorCode: "CONFIG_ERROR"; error: string };

/**
 * Núcleo de la carga: conversación + teléfono + opt-in, filtrando por workspace
 * y SIN lanzar.
 *
 * Antes recargaba la conversación solo por id, y esto corre con service role
 * (sin RLS): un conversationId de otro tenant cargaba igual y su teléfono
 * recibía el mensaje. Y colapsaba "error de base" con "fila ausente" en un
 * `throw`, que es justo lo que impide al motor de automatizaciones distinguir
 * "configuración rota" de "base caída" ANTES de marcar el despacho.
 */
async function loadConversationAndPhoneResult(
  conversationId: string,
  workspaceId: string,
  supabase: ReturnType<typeof svc>,
): Promise<
  | {
      ok: true;
      window_expires_at: string | null;
      contactId: string;
      toPhone: string;
      optIn: boolean;
    }
  | LoadFailure
> {
  const { data: conv, error: convError } = await supabase
    .from("conversations")
    .select("window_expires_at, contact_id")
    .eq("id", conversationId)
    // Esto corre con service role (sin RLS): sin el filtro, un conversationId
    // de otro tenant cargaría igual y su teléfono recibiría el mensaje.
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  // Error de base ≠ fila ausente. El primero se reintenta, el segundo no se
  // arregla solo.
  if (convError) {
    return { ok: false, errorCode: "DB_ERROR", error: convError.message };
  }
  if (!conv) {
    return { ok: false, errorCode: "CONFIG_ERROR", error: "conversation_not_found" };
  }

  const convRow = conv as ConversationWindowRow;

  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    // El opt_in viene ACÁ para que el chequeo de opt-out no necesite una
    // SEGUNDA consulta a conversations + contacts.
    .select("phone, opt_in")
    .eq("id", convRow.contact_id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (contactError) {
    return { ok: false, errorCode: "DB_ERROR", error: contactError.message };
  }
  if (!contact) {
    return { ok: false, errorCode: "CONFIG_ERROR", error: "contact_not_found" };
  }

  const contactRow = contact as ContactPhoneRow;
  return {
    ok: true,
    window_expires_at: convRow.window_expires_at,
    contactId: convRow.contact_id,
    toPhone: contactRow.phone,
    optIn: contactRow.opt_in !== false,
  };
}

/**
 * Motivos de `loadConversationAndPhoneResult` que significan "no está en este
 * workspace" (o no existe). Para `dispatchText`/`dispatchTemplate` eso es
 * NOT_FOUND; el motor los sigue viendo como CONFIG_ERROR con su código.
 */
const NOT_FOUND_REASONS = new Set(["conversation_not_found", "contact_not_found"]);

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
  const loaded = await loadConversationAndPhoneResult(
    conversationId,
    workspaceId,
    supabase,
  );
  if (!loaded.ok) {
    if (NOT_FOUND_REASONS.has(loaded.error)) return NOT_FOUND;
    // Base caída: mismo contrato de siempre (lanza); el caller lo loguea.
    throw new Error(`[dispatch] ${loaded.errorCode}: ${loaded.error}`);
  }
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

      return {
        ok: false,
        error: waError.message,
        errorCode: "SEND_FAILED",
        retryable: waError.retryable,
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
/**
 * Todo lo que hay que LEER para mandar una plantilla, en un solo lugar y sin
 * lanzar nunca.
 *
 * Existe para que el motor de automatizaciones pueda escribir `dispatched_at`
 * INMEDIATAMENTE antes del POST y no antes de estas lecturas. Con el orden
 * anterior (marcar → dispatchTemplate → releer conversación, teléfono e
 * integración), una caída transitoria de la base después de marcar cerraba el
 * run como fallo sin reintento aunque jamás hubiera existido un request
 * externo: evitaba duplicados perdiendo mensajes legítimos.
 *
 * `retryable` distingue "se cayó la base" (sí) de "la integración no está
 * configurada" (no). Mirarlo acá es seguro porque todavía no se marcó nada.
 */
export interface PreparedTemplateDispatch {
  workspaceId: string;
  conversationId: string;
  templateName: string;
  templateLanguage: string;
  components?: TemplateParams["components"];
  senderUserId?: string;
  toPhone: string;
  apiKey: string;
  phoneNumberId: string;
}

export type PrepareTemplateResult =
  | { ok: true; prepared: PreparedTemplateDispatch }
  | {
      ok: false;
      error: string;
      errorCode: "OPT_OUT" | "DB_ERROR" | "CONFIG_ERROR";
      retryable: boolean;
    };

export async function prepareTemplateDispatch(
  params: DispatchTemplateParams,
): Promise<PrepareTemplateResult> {
  const {
    workspaceId,
    conversationId,
    templateName,
    templateLanguage = "es",
    components,
    senderUserId,
  } = params;

  const supabase = svc();

  // 1. Conversación + teléfono + opt-in, en una sola pasada (las plantillas se
  //    saltan el guard de ventana entero, pero NO el de opt-out).
  const loaded = await loadConversationAndPhoneResult(
    conversationId,
    workspaceId,
    supabase,
  );
  if (!loaded.ok) {
    return {
      ok: false,
      error: loaded.error,
      errorCode: loaded.errorCode,
      retryable: loaded.errorCode === "DB_ERROR",
    };
  }

  // Bloquear salientes a contactos con opt-out.
  if (!loaded.optIn) {
    return {
      ok: false,
      error: OPT_OUT_MESSAGE,
      errorCode: "OPT_OUT",
      retryable: false,
    };
  }

  // 2. Credenciales de Kapso.
  //
  // Credenciales faltantes = configuración rota, NO modo desarrollo.
  // `loadIntegration` rellena con "" y el camino viejo interpretaba ese vacío
  // como "modo dev": encolaba el mensaje y devolvía ok. Un motor desatendido no
  // puede tratar eso como un envío: el run quedaba `done` sin WhatsApp.
  const { data: integration, error: integrationError } = await supabase
    .from("integrations")
    .select("credentials, config")
    .eq("workspace_id", workspaceId)
    .eq("provider", "kapso")
    .eq("enabled", true)
    .maybeSingle();

  // Error de base ≠ integración ausente: la primera se reintenta.
  if (integrationError) {
    return {
      ok: false,
      error: integrationError.message,
      errorCode: "DB_ERROR",
      retryable: true,
    };
  }
  if (!integration) {
    return {
      ok: false,
      errorCode: "CONFIG_ERROR",
      error: "kapso_integration_not_found",
      retryable: false,
    };
  }

  let apiKey: string;
  let phoneNumberId: string;
  try {
    ({ apiKey, phoneNumberId } = await kapsoCredentials(
      workspaceId,
      integration as IntegrationRow,
    ));
  } catch (err) {
    // El detalle técnico va SOLO al log, nunca al `error` que lee el panel.
    console.error("[dispatch] Kapso credentials could not be decrypted", {
      workspaceId,
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      errorCode: "CONFIG_ERROR",
      error: "credentials_unreadable",
      retryable: false,
    };
  }

  if (!apiKey.trim() || !phoneNumberId.trim()) {
    console.error("[dispatch] Kapso integration enabled without credentials", {
      workspaceId,
      hasApiKey: Boolean(apiKey.trim()),
      hasPhoneNumberId: Boolean(phoneNumberId.trim()),
    });
    return {
      ok: false,
      errorCode: "CONFIG_ERROR",
      error: "missing_kapso_credentials",
      retryable: false,
    };
  }

  // Mismo criterio, un paso más allá: el centinela "placeholder" hace
  // que `sendPreparedTemplate` NO llame a Kapso y escriba el mensaje como
  // `queued` devolviendo ok. Eso es modo desarrollo, no un envío: fuera de
  // desarrollo el motor de automatizaciones cerraría el run como `done` sin que
  // saliera ningún WhatsApp. En desarrollo sigue encolando como siempre.
  //
  // `dispatchText` queda igual a propósito: la ruta de texto libre no la usa
  // el motor.
  if (apiKey === "placeholder" && process.env.NODE_ENV !== "development") {
    console.error("[dispatch] Kapso api key placeholder outside development", {
      workspaceId,
    });
    return {
      ok: false,
      errorCode: "CONFIG_ERROR",
      error: "missing_kapso_credentials",
      retryable: false,
    };
  }

  return {
    ok: true,
    prepared: {
      workspaceId,
      conversationId,
      templateName,
      templateLanguage,
      components,
      senderUserId,
      toPhone: loaded.toPhone,
      apiKey,
      phoneNumberId,
    },
  };
}

/**
 * El efecto externo y su persistencia: POST a Kapso + insert del mensaje. No
 * lee nada de la base antes del POST, que es lo que permite que el caller marque
 * `dispatched_at` justo antes de llamarla.
 */
export async function sendPreparedTemplate(
  prepared: PreparedTemplateDispatch,
): Promise<DispatchResult> {
  const {
    workspaceId,
    conversationId,
    templateName,
    templateLanguage,
    components,
    senderUserId,
    toPhone,
    apiKey,
    phoneNumberId,
  } = prepared;

  const supabase = svc();

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

      return {
        ok: false,
        error: waError.message,
        errorCode: "SEND_FAILED",
        retryable: waError.retryable,
        providerCode:
          typeof waError.code === "number" ? waError.code : undefined,
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
    .eq("id", conversationId)
    .eq("workspace_id", workspaceId);

  return { ok: true, wamid };
}

/**
 * Envoltorio que conserva el contrato de siempre para los callers que no
 * necesitan la costura: `executeSetterPostAction` (buffer.ts) y
 * `sendTemplateAction` (template-actions.ts). Ninguno de los dos cambia.
 */
export async function dispatchTemplate(
  params: DispatchTemplateParams,
): Promise<DispatchResult> {
  const prep = await prepareTemplateDispatch(params);
  if (!prep.ok) {
    // Conversación/contacto de otro workspace (o inexistente): NOT_FOUND, sin
    // tocar Kapso ni la tabla messages.
    if (NOT_FOUND_REASONS.has(prep.error)) return NOT_FOUND;
    return {
      ok: false,
      // Detalle técnico SOLO server-side: al operador le llega el motivo del
      // opt-out (que sí es accionable) o el mensaje genérico.
      error: prep.errorCode === "OPT_OUT" ? prep.error : GENERIC_SEND_ERROR,
      errorCode: prep.errorCode === "OPT_OUT" ? "OPT_OUT" : "DB_ERROR",
      retryable: prep.retryable,
    };
  }
  return sendPreparedTemplate(prep.prepared);
}
