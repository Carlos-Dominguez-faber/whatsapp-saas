import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies a Kapso webhook signature.
 *
 * Header: "X-Webhook-Signature"
 * Signed material: HMAC-SHA256(secret, rawBody) as lowercase hex.
 *
 * Unlike YCloud there is NO timestamp and therefore no anti-replay window. We
 * lean on the existing dedup instead: messages.wamid carries a unique index, so
 * a replayed inbound message inserts nothing new.
 *
 * IMPORTANT: `rawBody` must be the exact bytes as received (request.text()).
 * Kapso's own Node example shows JSON.stringify(req.body), which re-serialises a
 * parsed object and changes key order/whitespace — the signature would never match.
 */
export function verifyKapsoSignature(
  rawBody: string,
  header: string | null,
  secret: string,
): boolean {
  try {
    if (!header) return false;

    // Tolerate a "sha256=" prefix if Kapso ever emits one.
    const received = header.trim().replace(/^sha256=/i, "");
    if (!/^[0-9a-f]+$/i.test(received)) return false;

    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");

    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(received.toLowerCase(), "utf8");

    // timingSafeEqual throws on length mismatch. A differing length already
    // means "not a valid HMAC hex digest", which leaks nothing about the secret.
    if (a.length !== b.length) return false;

    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export interface NormalizedInbound {
  /** Meta phone number ID that received the message — our routing identity */
  phoneNumberId: string | null;
  /** Sender phone number (E.164) */
  from: string;
  /** Message type as reported by Kapso */
  type: string;
  /** Text content, the media caption, or "[Multimedia]" when neither exists */
  text: string | null;
  /** WhatsApp message ID */
  wamid: string;
  /** Display name from the Kapso conversation contact, if available */
  customerName: string | null;
  /** ISO creation timestamp */
  createTime: string;
  /**
   * Ready-to-use media download URL from message.kapso.media_url. The token is
   * embedded and it EXPIRES — download now, never persist it.
   */
  mediaLink: string | null;
  /** Meta media id, when present — used to re-resolve an expired media_url */
  mediaId: string | null;
  /** Declared MIME type of the media */
  mediaMime: string | null;
  /** Original filename (document messages) */
  mediaFilename: string | null;
  /** Transcript Kapso already produced for voice notes, when present */
  transcript: string | null;
}

/** Inbound message types that carry a downloadable media payload. */
const MEDIA_TYPES = ["image", "audio", "voice", "video", "document", "sticker"];

/** Valid public.message_type enum values — the DB rejects anything else. */
const MESSAGE_TYPE_ENUM = new Set([
  "text",
  "audio",
  "image",
  "document",
  "video",
  "sticker",
  "location",
  "template",
  "system",
]);

/**
 * Clamp the raw message type to a valid message_type enum value so the INSERT
 * never fails — an out-of-enum value (e.g. WhatsApp voice notes arriving as
 * 'voice', or the 'unknown' fallback) would otherwise raise 22P02 and the
 * inbound message would be silently dropped. Voice notes → 'audio'
 * (consolidateBatch handles both); anything unrecognized → 'text'. The RAW type
 * is still used for media extraction.
 */
function toMessageType(raw: string): string {
  if (raw === "voice") return "audio";
  return MESSAGE_TYPE_ENUM.has(raw) ? raw : "text";
}

/** Kapso sends timestamps as Unix seconds (string); YCloud sent ISO. */
function toIsoTimestamp(raw: unknown): string {
  if (typeof raw === "string" && /^\d+$/.test(raw)) {
    const ms = Number(raw) * 1000;
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return new Date(raw * 1000).toISOString();
  }
  if (typeof raw === "string" && raw) {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * Resolves the event name for a webhook request.
 *
 * Kapso sends it in the `X-Webhook-Event` HEADER — an unbuffered request body
 * carries no top-level `type` at all (only `message.type`, which is "text" /
 * "image" / …). The body-level `type` exists solely on the batch envelope, so
 * it is used only as a fallback.
 */
export function resolveEventName(
  header: string | null,
  body: unknown,
): string | null {
  if (header && header.trim()) return header.trim();
  const event = asRecord(body);
  return asString(event?.type);
}

/**
 * Parses and normalises a raw Kapso webhook body.
 * Returns null if the event is not an inbound message or is malformed.
 *
 * `eventName` comes from resolveEventName() — never from body.type, which real
 * payloads do not have.
 *
 * Kapso docs warn explicitly: "Do not assume phone_number, from, to, or wa_id
 * are always present" — so every field below is read defensively.
 */
export function parseInbound(
  body: unknown,
  eventName: string | null,
): NormalizedInbound | null {
  try {
    const event = asRecord(body);
    if (!event) return null;

    // Kapso can batch events into { type, batch: true, data: [...] }. Our own
    // buffer already groups messages, so batching must stay OFF in Kapso — but
    // fail loudly rather than silently dropping every message if it gets turned on.
    if (event.batch === true) {
      console.error(
        "[kapso] webhook batching is ON — turn it off in Kapso, messages are being dropped",
      );
      return null;
    }

    if (eventName !== "whatsapp.message.received") return null;

    const message = asRecord(event.message);
    if (!message) return null;

    // Kapso echoes outbound messages through the same event shape.
    const kapso = asRecord(message.kapso);
    if (kapso?.direction === "outbound") return null;

    const wamid = asString(message.id);
    if (!wamid) return null;

    const from = asString(message.from);
    if (!from) return null;

    const conversation = asRecord(event.conversation);

    // Routing identity: the BUSINESS number's Meta id. Never read
    // conversation.phone_number here — that is the CONTACT's number.
    const phoneNumberId =
      asString(event.phone_number_id) ??
      asString(conversation?.phone_number_id);

    const msgType = asString(message.type) ?? "unknown";
    const createTime = toIsoTimestamp(message.timestamp);

    const customerName = asString(asRecord(conversation?.kapso)?.contact_name);

    let text: string | null = null;
    let mediaLink: string | null = null;
    let mediaId: string | null = null;
    let mediaMime: string | null = null;
    let mediaFilename: string | null = null;

    if (msgType === "text") {
      text = asString(asRecord(message.text)?.body);
    } else if (MEDIA_TYPES.includes(msgType)) {
      // Meta nests the media object under the message type, e.g.
      // message.image = { id, mime_type, caption, sha256 }.
      const mediaObj = asRecord(message[msgType]);
      if (mediaObj) {
        mediaId = asString(mediaObj.id);
        mediaMime =
          asString(mediaObj.mime_type) ?? asString(mediaObj.mimeType);
        mediaFilename = asString(mediaObj.filename);
        const caption = asString(mediaObj.caption);
        if (caption?.trim()) text = caption;
      }

      // Kapso pre-resolves a download URL on the enrichment object. It carries a
      // signed token and expires, so it is used immediately or not at all.
      if (kapso) {
        mediaLink = asString(kapso.media_url);
        const mediaData = asRecord(kapso.media_data);
        if (mediaData) {
          mediaMime = mediaMime ?? asString(mediaData.content_type);
          mediaFilename = mediaFilename ?? asString(mediaData.filename);
        }
      }

      if (text === null) text = "[Multimedia]";
    } else {
      text = "[Multimedia]";
    }

    // Kapso transcribes voice notes for us; media-understanding can skip the
    // call when this is already present.
    const transcriptObj = asRecord(kapso?.transcript);
    const transcript =
      asString(transcriptObj?.text) ?? asString(kapso?.transcript);

    return {
      phoneNumberId,
      from,
      type: toMessageType(msgType),
      text,
      wamid,
      customerName,
      createTime,
      mediaLink,
      mediaId,
      mediaMime,
      mediaFilename,
      transcript,
    };
  } catch {
    return null;
  }
}

export interface OutboundEcho {
  /** Contact phone the business replied to */
  to: string;
  /** WhatsApp message ID of the human's message */
  wamid: string;
  /** Clamped message_type enum value */
  type: string;
  /** Text body, or "[Multimedia]" */
  text: string | null;
  /** ISO timestamp */
  createTime: string;
  phoneNumberId: string | null;
}

/**
 * Parses a message the business sent from the WhatsApp Business App.
 *
 * In coexistence mode the same number is used by both this app and the Business
 * App on someone's phone. Kapso echoes those human replies back as
 * `whatsapp.message.sent` with kapso.origin = 'business_app'. Without this they
 * are invisible to us: the inbox would show an unanswered conversation and the
 * agent would happily reply on top of the person already handling it.
 *
 * Returns null for our own sends (origin 'cloud_api') and for history backfills
 * ('history_sync'), which are not live human activity.
 */
export function parseOutboundEcho(
  body: unknown,
  eventName: string | null,
): OutboundEcho | null {
  try {
    const event = asRecord(body);
    if (!event) return null;
    if (eventName !== "whatsapp.message.sent") return null;

    const message = asRecord(event.message);
    if (!message) return null;

    const kapso = asRecord(message.kapso);
    if (kapso?.origin !== "business_app") return null;

    const wamid = asString(message.id);
    if (!wamid) return null;

    const conversation = asRecord(event.conversation);
    const to =
      asString(message.to) ?? asString(conversation?.phone_number);
    if (!to) return null;

    const msgType = asString(message.type) ?? "unknown";

    let text: string | null = null;
    if (msgType === "text") {
      text = asString(asRecord(message.text)?.body);
    } else {
      const mediaObj = asRecord(message[msgType]);
      const caption = asString(mediaObj?.caption);
      text = caption?.trim() ? caption : "[Multimedia]";
    }
    // Kapso's own text rendering is a decent fallback for exotic types.
    if (text === null) text = asString(kapso?.content) ?? "[Multimedia]";

    return {
      to,
      wamid,
      type: toMessageType(msgType),
      text,
      createTime: toIsoTimestamp(message.timestamp),
      phoneNumberId:
        asString(event.phone_number_id) ??
        asString(conversation?.phone_number_id),
    };
  } catch {
    return null;
  }
}

/** Status events Kapso emits for outbound messages, mapped to our statuses. */
const STATUS_EVENTS: Record<string, string> = {
  "whatsapp.message.sent": "sent",
  "whatsapp.message.delivered": "delivered",
  "whatsapp.message.read": "read",
  "whatsapp.message.failed": "failed",
};

export interface ParsedStatus {
  wamid: string;
  status: string;
}

/**
 * Parses a Kapso outbound status event. Kapso splits what YCloud sent as a
 * single `whatsapp.message.updated` into one event per status.
 * Returns null when the event is not a status update or carries no wamid.
 */
export function parseStatusUpdate(
  body: unknown,
  eventName: string | null,
): ParsedStatus | null {
  try {
    const event = asRecord(body);
    if (!event) return null;
    if (!eventName) return null;

    const status = STATUS_EVENTS[eventName];
    if (!status) return null;

    const message = asRecord(event.message);
    const wamid = asString(message?.id) ?? asString(event.message_id);
    if (!wamid) return null;

    return { wamid, status };
  } catch {
    return null;
  }
}

/** True when the event is one of Kapso's outbound status events. */
export function isStatusEvent(eventName: string | null): boolean {
  return eventName !== null && eventName in STATUS_EVENTS;
}
