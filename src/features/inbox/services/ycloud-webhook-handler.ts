import { createHmac, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";

/**
 * Verifies a YCloud webhook signature.
 *
 * Header format: "t={unixSeconds},s={hmacSha256Hex}"
 * Signed material: HMAC-SHA256(secret, timestamp + "." + rawBody)
 * Anti-replay window: 300 seconds.
 */
export function verifyYCloudSignature(
  rawBody: string,
  header: string | null,
  secret: string,
): boolean {
  try {
    if (!header) return false;

    // Parse "t=1234567890,s=abcdef..."
    const tMatch = header.match(/t=(\d+)/);
    const sMatch = header.match(/s=([0-9a-f]+)/i);
    if (!tMatch || !sMatch) return false;

    const ts = tMatch[1];
    const receivedSig = sMatch[1];

    // Anti-replay: reject if timestamp is more than 300s from now
    const nowSec = Math.floor(
      (performance.timeOrigin + performance.now()) / 1000,
    );
    if (Math.abs(nowSec - parseInt(ts, 10)) > 300) return false;

    // Compute expected HMAC
    const message = `${ts}.${rawBody}`;
    const expectedHex = createHmac("sha256", secret)
      .update(message)
      .digest("hex");

    // Constant-time comparison (pad to equal length if lengths differ — mismatched
    // lengths leak info, so we pad before comparing)
    const a = Buffer.from(expectedHex.padEnd(receivedSig.length, "0"), "utf8");
    const b = Buffer.from(receivedSig.padEnd(expectedHex.length, "0"), "utf8");

    // timingSafeEqual requires same-length buffers
    const len = Math.max(a.length, b.length);
    const aBuf = Buffer.alloc(len);
    const bBuf = Buffer.alloc(len);
    a.copy(aBuf);
    b.copy(bBuf);

    return (
      timingSafeEqual(aBuf, bBuf) && expectedHex.length === receivedSig.length
    );
  } catch {
    return false;
  }
}

export interface NormalizedInbound {
  /** The workspace phone number (E.164) that received the message */
  workspacePhone: string;
  /** Sender phone number (E.164) */
  from: string;
  /** Message type as reported by YCloud */
  type: string;
  /** Sanitised raw message type, retained for diagnostics */
  rawType: string;
  /** Text content, the media caption, or "[Multimedia]" when neither exists */
  text: string | null;
  /** YCloud WhatsApp message ID */
  wamid: string;
  /** Display name from customer profile, if available */
  customerName: string | null;
  /** ISO creation timestamp from the event root */
  createTime: string;
  /** YCloud media download URL (api.ycloud.com) for media messages */
  mediaLink: string | null;
  /** YCloud media id, when present */
  mediaId: string | null;
  /** Declared MIME type of the media */
  mediaMime: string | null;
  /** Original filename (document messages) */
  mediaFilename: string | null;
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

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sanitiseRawType(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 40) || "unknown";
}

function bodyLike(value: unknown): string | null {
  const direct = nonEmptyString(value);
  if (direct) return direct;
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return (
    nonEmptyString(record.body) ??
    nonEmptyString(record.text) ??
    nonEmptyString(record.title)
  );
}

/**
 * Extracts conversational text from YCloud's documented text, button and
 * interactive reply shapes. A few body fallbacks are accepted so a harmless
 * provider envelope change does not silently degrade a real message to the
 * generic multimedia placeholder.
 */
function extractConversationalText(
  message: Record<string, unknown>,
  rawType: string,
): string | null {
  const plainText =
    bodyLike(message.text) ??
    nonEmptyString(message.body) ??
    (typeof message.message === "object" && message.message !== null
      ? bodyLike((message.message as Record<string, unknown>).text) ??
        bodyLike((message.message as Record<string, unknown>).body)
      : null);
  if (plainText) return plainText;

  if (rawType === "button") {
    return bodyLike(message.button);
  }

  if (rawType === "interactive") {
    const interactive = message.interactive;
    if (typeof interactive !== "object" || interactive === null) return null;
    const value = interactive as Record<string, unknown>;
    return (
      bodyLike(value.button_reply) ??
      bodyLike(value.list_reply) ??
      bodyLike(value.nfm_reply) ??
      bodyLike(value.body)
    );
  }

  return null;
}

function inferRawType(message: Record<string, unknown>): string {
  if (extractConversationalText(message, "text")) return "text";
  for (const type of MEDIA_TYPES) {
    if (typeof message[type] === "object" && message[type] !== null) return type;
  }
  for (const type of ["button", "interactive", "location"] as const) {
    if (typeof message[type] === "object" && message[type] !== null) return type;
  }
  return "unknown";
}

/**
 * Clamp YCloud's raw message type to a valid message_type enum value so the
 * INSERT never fails — an out-of-enum value (e.g. WhatsApp voice notes arriving
 * as 'voice', or the 'unknown' fallback) would otherwise raise 22P02 and the
 * inbound message would be silently dropped. Voice notes → 'audio'
 * (consolidateBatch handles both); anything unrecognized → 'text'. The RAW type
 * is still used above for media extraction (wimObj[msgType]).
 */
function toMessageType(raw: string): string {
  if (raw === "voice") return "audio";
  return MESSAGE_TYPE_ENUM.has(raw) ? raw : "text";
}

/**
 * Parses and normalises a raw YCloud webhook body.
 * Returns null if the event is not an inbound message or is malformed.
 */
export function parseInbound(body: unknown): NormalizedInbound | null {
  try {
    if (typeof body !== "object" || body === null) return null;

    const event = body as Record<string, unknown>;

    // Only process inbound message events
    if (event.type !== "whatsapp.inbound_message.received") return null;

    // Guard against echo messages
    if (typeof event.type === "string" && event.type.includes("echo"))
      return null;

    const wim = event.whatsappInboundMessage;
    if (typeof wim !== "object" || wim === null) return null;

    const wimObj = wim as Record<string, unknown>;

    const wamid = wimObj.wamid;
    if (typeof wamid !== "string" || !wamid) return null;

    const from = wimObj.from;
    if (typeof from !== "string" || !from) return null;

    const to = wimObj.to;
    if (typeof to !== "string" || !to) return null;

    const declaredType = nonEmptyString(wimObj.type);
    const msgType = sanitiseRawType(declaredType ?? inferRawType(wimObj));

    const createTime =
      typeof event.createTime === "string"
        ? event.createTime
        : new Date().toISOString();

    let customerName: string | null = null;
    const profile = wimObj.customerProfile;
    if (typeof profile === "object" && profile !== null) {
      const profileObj = profile as Record<string, unknown>;
      customerName =
        typeof profileObj.name === "string" ? profileObj.name : null;
    }

    let text: string | null = null;
    let mediaLink: string | null = null;
    let mediaId: string | null = null;
    let mediaMime: string | null = null;
    let mediaFilename: string | null = null;

    const conversationalText = extractConversationalText(wimObj, msgType);

    if (msgType === "text") {
      text = conversationalText ?? "[Mensaje de texto vacío o no compatible]";
    } else if (msgType === "button") {
      text = conversationalText ?? "[Respuesta de botón sin texto]";
    } else if (msgType === "interactive") {
      text = conversationalText ?? "[Respuesta interactiva sin texto]";
    } else if (MEDIA_TYPES.includes(msgType)) {
      // YCloud nests the media object under the message type, e.g.
      // whatsappInboundMessage.image = { id, link, mimeType, caption, ... }.
      // Field casing varies (mimeType vs mime_type), so read both.
      const mediaObj = wimObj[msgType];
      if (typeof mediaObj === "object" && mediaObj !== null) {
        const m = mediaObj as Record<string, unknown>;
        mediaLink = typeof m.link === "string" ? m.link : null;
        mediaId = typeof m.id === "string" ? m.id : null;
        mediaMime =
          typeof m.mimeType === "string"
            ? m.mimeType
            : typeof m.mime_type === "string"
              ? m.mime_type
              : null;
        mediaFilename = typeof m.filename === "string" ? m.filename : null;
        // Prefer the caption as the message body when present
        if (typeof m.caption === "string" && m.caption.trim()) {
          text = m.caption;
        }
      }
      if (text === null) text = "[Multimedia]";
    } else if (msgType === "location") {
      text = "[Ubicación compartida]";
    } else if (conversationalText) {
      text = conversationalText;
    } else {
      text = `[Mensaje de WhatsApp no compatible: ${msgType}]`;
    }

    return {
      workspacePhone: to,
      from,
      type: toMessageType(msgType),
      rawType: msgType,
      text,
      wamid,
      customerName,
      createTime,
      mediaLink,
      mediaId,
      mediaMime,
      mediaFilename,
    };
  } catch {
    return null;
  }
}
