import type { KapsoComponent } from "@/features/settings/lib/template-form";

/**
 * Kapso's WhatsApp API mirrors Meta's Graph API, so the sender is identified by
 * `phone_number_id` in the PATH (not a `from` field in the body, as YCloud did)
 * and template operations are scoped to a WABA id.
 */
const KAPSO_WA_BASE = "https://api.kapso.ai/meta/whatsapp/v24.0";
const KAPSO_PLATFORM_BASE = "https://api.kapso.ai/platform/v1";

export class KapsoError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "KapsoError";
  }
}

/**
 * Pulls a human-readable message out of an error body.
 *
 * Kapso is inconsistent here: its own errors come back as a bare
 * `{"error": "Active sandbox session required to send messages"}` while the Meta
 * mirror returns Graph's `{"error": {"message": …, "error_user_msg": …}}`. Miss
 * the string form and the operator only ever sees "error 403".
 */
function extractKapsoErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  if (typeof obj.error === "string" && obj.error) return obj.error;
  if (typeof obj.message === "string") return obj.message;
  const error = obj.error as Record<string, unknown> | undefined;
  if (error && typeof error === "object") {
    if (typeof error.error_user_msg === "string") return error.error_user_msg;
    if (typeof error.message === "string") return error.message;
  }
  return null;
}

/** Single place where every Kapso call parses its response and raises. */
async function kapsoFetch(
  url: string,
  apiKey: string,
  init: RequestInit,
  context: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      "X-API-Key": apiKey,
      ...init.headers,
    },
  });

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = null;
  }

  if (!response.ok) {
    throw new KapsoError(
      response.status,
      responseBody,
      extractKapsoErrorMessage(responseBody) ??
        `Kapso ${context} error ${response.status}`,
    );
  }

  return (responseBody ?? {}) as Record<string, unknown>;
}

/**
 * Reads the wamid out of a Meta send response:
 *   { messaging_product, contacts: [{ wa_id }], messages: [{ id }] }
 * `messages[0].id` IS the wamid — Kapso returns no separate provider id and no
 * status, unlike YCloud's { id, wamid, status }.
 */
function wamidFromSendResponse(data: Record<string, unknown>): string {
  const messages = data.messages;
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const first = messages[0] as Record<string, unknown> | undefined;
  return typeof first?.id === "string" ? first.id : "";
}

export interface SendTextResult {
  id: string;
  wamid: string;
  status: string;
}

interface SendTextParams {
  apiKey: string;
  /** Meta phone number ID (e.g. "123456789012345") — NOT the E.164 number */
  phoneNumberId: string;
  to: string;
  body: string;
}

/**
 * Sends a text message via the Kapso WhatsApp API.
 * Throws KapsoError on non-2xx responses.
 */
export async function sendText(
  params: SendTextParams,
): Promise<SendTextResult> {
  const { apiKey, phoneNumberId, to, body } = params;

  const data = await kapsoFetch(
    `${KAPSO_WA_BASE}/${encodeURIComponent(phoneNumberId)}/messages`,
    apiKey,
    {
      method: "POST",
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      }),
    },
    "sendText",
  );

  const wamid = wamidFromSendResponse(data);

  // Kapso reports no id/status of its own. A 2xx means accepted for delivery;
  // the delivered/read webhooks advance it from there.
  return { id: wamid, wamid, status: "accepted" };
}

// ──────────────────────────────────────────────────────────────────────────────
// sendTemplate
// ──────────────────────────────────────────────────────────────────────────────

export interface TemplateParams {
  apiKey: string;
  /** Meta phone number ID */
  phoneNumberId: string;
  to: string; // E.164
  templateName: string;
  /** Default 'es'. NEVER 'es_PA' — Movinsa production gotcha */
  language?: string;
  /**
   * FLAT array per component (Movinsa gotcha).
   * Each parameters entry must be a flat { type: 'text', text: string }.
   */
  components?: Array<{
    type: "header" | "body" | "footer" | "button";
    parameters: Array<{ type: "text"; text: string }>;
  }>;
}

export interface SendTemplateResult {
  id: string;
  wamid: string;
  status: string;
}

/**
 * Sends a template message via the Kapso WhatsApp API.
 * Templates bypass the 24h window restriction.
 * Throws KapsoError on non-2xx responses.
 */
export async function sendTemplate(
  params: TemplateParams,
): Promise<SendTemplateResult> {
  const {
    apiKey,
    phoneNumberId,
    to,
    templateName,
    language = "es",
    components,
  } = params;

  const data = await kapsoFetch(
    `${KAPSO_WA_BASE}/${encodeURIComponent(phoneNumberId)}/messages`,
    apiKey,
    {
      method: "POST",
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: templateName,
          language: { code: language },
          ...(components ? { components } : {}),
        },
      }),
    },
    "sendTemplate",
  );

  const wamid = wamidFromSendResponse(data);
  return { id: wamid, wamid, status: "accepted" };
}

// ──────────────────────────────────────────────────────────────────────────────
// fetchKapsoTemplates
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Fetches WhatsApp templates for a WABA.
 * Meta returns { data: [...], paging }, so we read `data` (YCloud used `records`).
 */
export async function fetchKapsoTemplates(
  apiKey: string,
  wabaId: string,
): Promise<unknown[]> {
  const data = await kapsoFetch(
    `${KAPSO_WA_BASE}/${encodeURIComponent(wabaId)}/message_templates?limit=100`,
    apiKey,
    { method: "GET" },
    "fetchTemplates",
  );

  return Array.isArray(data.data) ? data.data : [];
}

// ──────────────────────────────────────────────────────────────────────────────
// createKapsoTemplate
// ──────────────────────────────────────────────────────────────────────────────

export interface CreateTemplatePayload {
  name: string;
  language: string;
  category: string; // UPPERCASE: UTILITY | MARKETING | AUTHENTICATION
  components: KapsoComponent[];
}

export interface CreateTemplateResult {
  id: string;
  status: string;
}

/**
 * Submits a WhatsApp template for Meta approval.
 * The WABA id goes in the path (YCloud took `wabaId` in the body instead).
 */
export async function createKapsoTemplate(
  apiKey: string,
  wabaId: string,
  payload: CreateTemplatePayload,
): Promise<CreateTemplateResult> {
  const data = await kapsoFetch(
    `${KAPSO_WA_BASE}/${encodeURIComponent(wabaId)}/message_templates`,
    apiKey,
    { method: "POST", body: JSON.stringify(payload) },
    "createTemplate",
  );

  return {
    id: typeof data.id === "string" ? data.id : "",
    status: typeof data.status === "string" ? data.status : "PENDING",
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// listPhoneNumbers — doubles as the connection test
// ──────────────────────────────────────────────────────────────────────────────

export interface KapsoPhoneNumber {
  id: string;
  display_phone_number: string;
  verified_name: string | null;
}

/**
 * Lists the phone numbers registered under a WABA. Kapso has no /balance
 * equivalent to YCloud's, so this is what "test connection" calls — it proves
 * the API key works AND surfaces the phone_number_id for the settings UI.
 */
export async function listPhoneNumbers(
  apiKey: string,
  wabaId: string,
): Promise<KapsoPhoneNumber[]> {
  const data = await kapsoFetch(
    `${KAPSO_WA_BASE}/${encodeURIComponent(wabaId)}/phone_numbers`,
    apiKey,
    { method: "GET" },
    "listPhoneNumbers",
  );

  const items = Array.isArray(data.data)
    ? (data.data as Array<Record<string, unknown>>)
    : [];

  return items.map((p) => ({
    id: typeof p.id === "string" ? p.id : "",
    display_phone_number:
      typeof p.display_phone_number === "string" ? p.display_phone_number : "",
    verified_name: typeof p.verified_name === "string" ? p.verified_name : null,
  }));
}

// ──────────────────────────────────────────────────────────────────────────────
// listAllPhoneNumbers — project-wide discovery (Platform API)
// ──────────────────────────────────────────────────────────────────────────────

export interface KapsoDiscoveredNumber {
  phone_number_id: string;
  /** The WABA id — Kapso calls it business_account_id here */
  waba_id: string;
  display_phone_number: string | null;
  verified_name: string | null;
  /** "CONNECTED" for a live number; null on sandbox entries */
  status: string | null;
  /** "production" | "sandbox" */
  kind: string | null;
}

/**
 * Lists every WhatsApp number in the Kapso project, with no WABA id needed.
 *
 * This is the Platform API rather than the Meta mirror, and it is what makes
 * setup safe: it hands back the phone_number_id AND the waba_id together, so
 * neither has to be copied by hand. Typing the E.164 number into the
 * phone_number_id field is the single most likely way to break sending, and
 * this removes the opportunity.
 */
export async function listAllPhoneNumbers(
  apiKey: string,
): Promise<KapsoDiscoveredNumber[]> {
  const data = await kapsoFetch(
    `${KAPSO_PLATFORM_BASE}/whatsapp/phone_numbers`,
    apiKey,
    { method: "GET" },
    "listAllPhoneNumbers",
  );

  const items = Array.isArray(data.data)
    ? (data.data as Array<Record<string, unknown>>)
    : [];

  return items.map((p) => ({
    phone_number_id:
      typeof p.phone_number_id === "string"
        ? p.phone_number_id
        : typeof p.id === "string"
          ? p.id
          : "",
    waba_id:
      typeof p.business_account_id === "string" ? p.business_account_id : "",
    display_phone_number:
      typeof p.display_phone_number === "string"
        ? p.display_phone_number
        : null,
    verified_name: typeof p.verified_name === "string" ? p.verified_name : null,
    status: typeof p.status === "string" ? p.status : null,
    kind: typeof p.kind === "string" ? p.kind : null,
  }));
}

// ──────────────────────────────────────────────────────────────────────────────
// getMediaUrl
// ──────────────────────────────────────────────────────────────────────────────

export interface KapsoMediaUrl {
  url: string;
  mime_type: string | null;
  /** Pre-signed download URL — the token is embedded, so send NO API key */
  download_url: string;
  /** The download_url expires; download immediately, never persist it */
  download_url_expires_at: string | null;
}

/**
 * Resolves a media id to a short-lived download URL.
 * Unlike YCloud, the inbound payload carries no permanent media link.
 */
export async function getMediaUrl(
  apiKey: string,
  mediaId: string,
): Promise<KapsoMediaUrl | null> {
  const data = await kapsoFetch(
    `${KAPSO_WA_BASE}/${encodeURIComponent(mediaId)}`,
    apiKey,
    { method: "GET" },
    "getMediaUrl",
  );

  const downloadUrl =
    typeof data.download_url === "string"
      ? data.download_url
      : typeof data.url === "string"
        ? data.url
        : null;

  if (!downloadUrl) return null;

  return {
    url: typeof data.url === "string" ? data.url : downloadUrl,
    mime_type: typeof data.mime_type === "string" ? data.mime_type : null,
    download_url: downloadUrl,
    download_url_expires_at:
      typeof data.download_url_expires_at === "string"
        ? data.download_url_expires_at
        : null,
  };
}
