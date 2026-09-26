/**
 * inbound-content.ts — text for inbound WhatsApp messages that are not plain
 * text or media: template button taps, interactive replies (buttons, lists,
 * flows), catalog orders and shared locations.
 *
 * YCloud and Kapso both relay Meta's message object, so the shapes are the
 * same and both parsers share this. Before, all of these reached the agent as
 * "[Multimedia]": a customer tapping "Confirmar" on a template was invisible.
 *
 * Pure module: no `@/`, no Supabase, so it runs under `node --test`.
 */

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** First non-empty text among a reply object's usual fields. */
function replyText(value: unknown): string | null {
  const rec = record(value);
  if (!rec) return text(value);
  return text(rec.title) ?? text(rec.text) ?? text(rec.body);
}

/** Only letters, digits and a few separators: the type ends up in the text. */
function safeType(type: string): string {
  return type.toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 40) || "desconocido";
}

/**
 * Text for a non-text, non-media inbound message of type `type`, read from
 * the Meta message object. Always returns something the agent can read.
 */
export function inboundContentText(
  message: Record<string, unknown>,
  type: string,
): string {
  switch (type) {
    case "button":
      // A tap on a template's quick-reply button.
      return (
        replyText(message.button) ??
        text(record(message.button)?.payload) ??
        "[Respuesta de botón sin texto]"
      );
    case "interactive": {
      const interactive = record(message.interactive);
      return (
        replyText(interactive?.button_reply) ??
        replyText(interactive?.list_reply) ??
        replyText(interactive?.nfm_reply) ??
        "[Respuesta interactiva sin texto]"
      );
    }
    case "order": {
      const order = text(record(message.order)?.text);
      return order ? `[Pedido del catálogo]: ${order}` : "[Pedido del catálogo]";
    }
    case "location": {
      const location = record(message.location);
      const place = [text(location?.name), text(location?.address)]
        .filter(Boolean)
        .join(", ");
      return place ? `[Ubicación compartida: ${place}]` : "[Ubicación compartida]";
    }
    case "reaction": {
      const emoji = text(record(message.reaction)?.emoji);
      return emoji ? `[Reacción: ${emoji}]` : "[Reacción retirada]";
    }
    default:
      return `[Mensaje de WhatsApp no compatible: ${safeType(type)}]`;
  }
}
