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

/**
 * A Flow's answers (`nfm_reply.response_json`, a JSON string) as short
 * "campo: valor" pairs; `flow_token` is plumbing, not an answer.
 */
function flowSummary(nfm: Record<string, unknown> | null): string | null {
  const raw = nfm?.response_json;
  if (typeof raw !== "string") return null;
  let answers: Record<string, unknown>;
  try {
    answers = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!answers || typeof answers !== "object") return null;
  const pairs = Object.entries(answers)
    .filter(([key, value]) => key !== "flow_token" && value !== null && value !== "")
    .map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
  if (pairs.length === 0) return null;
  const summary = pairs.join("; ");
  return summary.length > 400 ? `${summary.slice(0, 400)}…` : summary;
}

/** "SKU ×2, SKU2 ×1" for a catalog order's items (the webhook has no names). */
function orderItems(order: Record<string, unknown> | null): string | null {
  const items = Array.isArray(order?.product_items) ? order.product_items : [];
  if (items.length === 0) return null;
  const listed = items.slice(0, 10).map((item) => {
    const rec = record(item);
    const id = text(rec?.product_retailer_id) ?? "producto";
    const qty = typeof rec?.quantity === "number" ? rec.quantity : Number(rec?.quantity) || 1;
    return `${id} ×${qty}`;
  });
  const more = items.length > 10 ? ` y ${items.length - 10} más` : "";
  return `${items.length} producto${items.length === 1 ? "" : "s"}: ${listed.join(", ")}${more}`;
}

function coordinate(value: unknown): string | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n.toFixed(5) : null;
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
      const flow = flowSummary(record(interactive?.nfm_reply));
      return (
        replyText(interactive?.button_reply) ??
        replyText(interactive?.list_reply) ??
        (flow ? `[Formulario enviado]: ${flow}` : null) ??
        replyText(interactive?.nfm_reply) ??
        "[Respuesta interactiva sin texto]"
      );
    }
    case "order": {
      const order = record(message.order);
      const items = orderItems(order);
      const note = text(order?.text);
      const head = items ? `[Pedido del catálogo, ${items}]` : "[Pedido del catálogo]";
      return note ? `${head}: ${note}` : head;
    }
    case "location": {
      const location = record(message.location);
      const place = [text(location?.name), text(location?.address)]
        .filter(Boolean)
        .join(", ");
      if (place) return `[Ubicación compartida: ${place}]`;
      // A bare pin: its coordinates are all there is.
      const lat = coordinate(location?.latitude);
      const lng = coordinate(location?.longitude);
      return lat && lng
        ? `[Ubicación compartida: ${lat}, ${lng}]`
        : "[Ubicación compartida]";
    }
    case "reaction": {
      const emoji = text(record(message.reaction)?.emoji);
      return emoji ? `[Reacción: ${emoji}]` : "[Reacción retirada]";
    }
    default:
      return `[Mensaje de WhatsApp no compatible: ${safeType(type)}]`;
  }
}
