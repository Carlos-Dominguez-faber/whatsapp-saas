import type { MetaTemplateComponent } from "@/features/settings/lib/template-form";
import { matchesOwnNumber } from "./phone";

const YCLOUD_BASE_URL = "https://api.ycloud.com/v2";
const YCLOUD_MESSAGES_URL = `${YCLOUD_BASE_URL}/whatsapp/messages`;
const YCLOUD_TEMPLATES_URL = `${YCLOUD_BASE_URL}/whatsapp/templates`;
const YCLOUD_PHONE_NUMBERS_URL = `${YCLOUD_BASE_URL}/whatsapp/phoneNumbers`;

// A send that hangs must not eat the function's time budget. Past this, the
// message may or may not have left: dispatch treats it as a final failure.
const SEND_TIMEOUT_MS = 20_000;

export class YCloudError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(
    status: number,
    body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "YCloudError";
    this.status = status;
    this.body = body;
  }
}

export interface SendTextResult {
  id: string;
  wamid: string;
  status: string;
}

interface SendTextParams {
  apiKey: string;
  from: string;
  to: string;
  body: string;
}

/**
 * Sends a text message via the YCloud WhatsApp API.
 * Throws YCloudError on non-2xx responses.
 */
export async function sendText(
  params: SendTextParams,
): Promise<SendTextResult> {
  const { apiKey, from, to, body } = params;

  const response = await fetch(YCLOUD_MESSAGES_URL, {
    method: "POST",
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({
      type: "text",
      from,
      to,
      text: { body },
    }),
  });

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = null;
  }

  if (!response.ok) {
    throw new YCloudError(
      response.status,
      responseBody,
      `YCloud API error ${response.status}`,
    );
  }

  const data = responseBody as Record<string, unknown>;

  return {
    id: typeof data.id === "string" ? data.id : "",
    wamid: typeof data.wamid === "string" ? data.wamid : "",
    status: typeof data.status === "string" ? data.status : "accepted",
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// sendTemplate
// ──────────────────────────────────────────────────────────────────────────────

export interface TemplateParams {
  apiKey: string;
  from: string; // E.164
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
 * Sends a template message via the YCloud WhatsApp API.
 * Templates bypass the 24h window restriction.
 * Throws YCloudError on non-2xx responses.
 */
export async function sendTemplate(
  params: TemplateParams,
): Promise<SendTemplateResult> {
  const {
    apiKey,
    from,
    to,
    templateName,
    language = "es",
    components,
  } = params;

  const response = await fetch(YCLOUD_MESSAGES_URL, {
    method: "POST",
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({
      type: "template",
      from,
      to,
      template: {
        name: templateName,
        language: { code: language },
        ...(components ? { components } : {}),
      },
    }),
  });

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = null;
  }

  if (!response.ok) {
    throw new YCloudError(
      response.status,
      responseBody,
      `YCloud sendTemplate error ${response.status}`,
    );
  }

  const data = responseBody as Record<string, unknown>;

  return {
    id: typeof data.id === "string" ? data.id : "",
    wamid: typeof data.wamid === "string" ? data.wamid : "",
    status: typeof data.status === "string" ? data.status : "accepted",
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// fetchYCloudTemplates
// ──────────────────────────────────────────────────────────────────────────────

/** YCloud pages the list (100 per page at most); more than this is cut. */
const TEMPLATE_PAGE_SIZE = 100;
const MAX_TEMPLATE_PAGES = 10;

export interface YCloudTemplatePage {
  items: unknown[];
  /** True when the account has more templates than were read. */
  truncated: boolean;
}

/**
 * Fetches the WhatsApp templates of ONE WhatsApp Business Account. The API
 * key reaches every WABA of the YCloud account, so without the filter another
 * number's templates would be imported into this workspace. Reads every page,
 * up to MAX_TEMPLATE_PAGES, and says when that cut the list.
 */
export async function fetchYCloudTemplates(
  apiKey: string,
  wabaId: string,
): Promise<YCloudTemplatePage> {
  const items: unknown[] = [];
  let total: number | null = null;

  for (let page = 1; page <= MAX_TEMPLATE_PAGES; page++) {
    const params = new URLSearchParams({
      page: String(page),
      limit: String(TEMPLATE_PAGE_SIZE),
      includeTotal: "true",
      "filter.wabaId": wabaId,
    });
    const response = await fetch(`${YCLOUD_TEMPLATES_URL}?${params.toString()}`, {
      method: "GET",
      headers: { "X-API-Key": apiKey },
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      responseBody = null;
    }

    if (!response.ok) {
      throw new YCloudError(
        response.status,
        responseBody,
        `YCloud fetchTemplates error ${response.status}`,
      );
    }

    const pageItems = templateListItems(responseBody);
    const reported = (responseBody as { total?: unknown } | null)?.total;
    if (typeof reported === "number") total = reported;
    items.push(...pageItems);

    const done =
      pageItems.length < TEMPLATE_PAGE_SIZE ||
      (total !== null && items.length >= total);
    if (done) return { items, truncated: false };
  }

  console.warn(
    `[ycloud] template list cut at ${items.length}${total !== null ? ` of ${total}` : ""} templates`,
  );
  return { items, truncated: true };
}

/**
 * The list endpoint returns its page as `items` (YCloud's paginated shape).
 * `records` is accepted as a fallback; anything else is logged — keys only,
 * never the payload — so a changed envelope doesn't sync 0 templates silently.
 */
export function templateListItems(body: unknown): unknown[] {
  const data = (body ?? {}) as Record<string, unknown>;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.records)) {
    console.warn("[ycloud] template list came back as `records`, not `items`");
    return data.records;
  }
  console.warn(
    "[ycloud] template list has neither `items` nor `records`; keys:",
    Object.keys(data),
  );
  return [];
}

/**
 * The template's id for Meta. YCloud reports it as `officialTemplateId`; `id`
 * is only a fallback for shapes that carry Meta's id there.
 */
export function templateOfficialId(template: unknown): string | null {
  const t = (template ?? {}) as Record<string, unknown>;
  for (const value of [t.officialTemplateId, t.id]) {
    if (typeof value === "string" && value) return value;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Phone numbers and resolveWabaId
// ──────────────────────────────────────────────────────────────────────────────

const PHONE_NUMBER_PAGE_SIZE = 100;
const MAX_PHONE_NUMBER_PAGES = 10;

/** The configured number isn't on the YCloud account (message for the team). */
export class WabaNotFoundError extends Error {
  constructor() {
    super(
      "No encontramos el número de WhatsApp de este espacio entre los de tu cuenta de YCloud. Revisa el número en Integraciones.",
    );
    this.name = "WabaNotFoundError";
  }
}

export interface YCloudPhoneNumber {
  phoneNumber: string;
  wabaId: string | null;
}

/**
 * Every WhatsApp number on the key's account (all pages, up to 1,000), as
 * YCloud lists them. Throws YCloudError on a non-2xx.
 */
export async function listYCloudPhoneNumbers(
  apiKey: string,
): Promise<YCloudPhoneNumber[]> {
  const numbers: YCloudPhoneNumber[] = [];
  let total: number | null = null;

  for (let page = 1; page <= MAX_PHONE_NUMBER_PAGES; page++) {
    const params = new URLSearchParams({
      page: String(page),
      limit: String(PHONE_NUMBER_PAGE_SIZE),
      includeTotal: "true",
    });
    const response = await fetch(`${YCLOUD_PHONE_NUMBERS_URL}?${params.toString()}`, {
      method: "GET",
      headers: { "X-API-Key": apiKey },
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      responseBody = null;
    }

    if (!response.ok) {
      throw new YCloudError(
        response.status,
        responseBody,
        `YCloud phoneNumbers error ${response.status}`,
      );
    }

    const data = (responseBody ?? {}) as Record<string, unknown>;
    // { items: [...] }; older shapes used `records`/`data`.
    const items = (
      Array.isArray(data.items)
        ? data.items
        : Array.isArray(data.records)
          ? data.records
          : Array.isArray(data.data)
            ? data.data
            : []
    ) as Array<Record<string, unknown>>;
    if (typeof data.total === "number") total = data.total;

    for (const item of items) {
      if (typeof item.phoneNumber !== "string") continue;
      numbers.push({
        phoneNumber: item.phoneNumber,
        wabaId: typeof item.wabaId === "string" ? item.wabaId : null,
      });
    }

    const done =
      items.length < PHONE_NUMBER_PAGE_SIZE ||
      (total !== null && page * PHONE_NUMBER_PAGE_SIZE >= total);
    if (done) break;
  }

  return numbers;
}

/**
 * Resolves the WhatsApp Business Account ID for the workspace's number.
 * Template creation (POST /v2/whatsapp/templates) requires `wabaId`, and the
 * template list is filtered by it; we don't store it, so it is looked up from
 * the configured number each time. Throws when no number on the account is
 * that one: falling back to another number's WABA would read or create
 * templates on a line that isn't the workspace's.
 */
export async function resolveWabaId(
  apiKey: string,
  configuredPhone: string,
): Promise<string> {
  const numbers = await listYCloudPhoneNumbers(apiKey);
  const match = numbers.find((n) => matchesOwnNumber(configuredPhone, n.phoneNumber));

  if (!match?.wabaId) throw new WabaNotFoundError();

  return match.wabaId;
}

// ──────────────────────────────────────────────────────────────────────────────
// createYCloudTemplate
// ──────────────────────────────────────────────────────────────────────────────

export interface CreateTemplatePayload {
  wabaId: string;
  name: string;
  language: string;
  category: string; // UPPERCASE: UTILITY | MARKETING | AUTHENTICATION
  components: MetaTemplateComponent[];
}

export interface CreateTemplateResult {
  id: string;
  status: string;
}

/**
 * Submits a WhatsApp template to YCloud for Meta approval.
 * Returns the provider template id + initial status (usually "PENDING").
 * Throws YCloudError (with the parsed YCloud error body) on non-2xx.
 */
export async function createYCloudTemplate(
  apiKey: string,
  payload: CreateTemplatePayload,
): Promise<CreateTemplateResult> {
  const response = await fetch(YCLOUD_TEMPLATES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify(payload),
  });

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = null;
  }

  if (!response.ok) {
    const message = extractYCloudErrorMessage(responseBody);
    throw new YCloudError(
      response.status,
      responseBody,
      message ?? `YCloud createTemplate error ${response.status}`,
    );
  }

  const data = (responseBody ?? {}) as Record<string, unknown>;
  return {
    id: templateOfficialId(data) ?? "",
    status: typeof data.status === "string" ? data.status : "PENDING",
  };
}

/** Pulls a human-readable message out of a YCloud error envelope. */
function extractYCloudErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  if (typeof obj.message === "string") return obj.message;
  const error = obj.error as Record<string, unknown> | undefined;
  if (error && typeof error.message === "string") return error.message;
  return null;
}
