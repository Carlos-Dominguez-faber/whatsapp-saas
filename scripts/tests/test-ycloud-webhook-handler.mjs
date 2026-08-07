import assert from "node:assert/strict";
import { parseInbound } from "../../src/features/inbox/services/ycloud-webhook-handler.ts";

const base = {
  type: "whatsapp.inbound_message.received",
  createTime: "2026-08-06T19:42:00.000Z",
};

function inbound(overrides) {
  return {
    ...base,
    whatsappInboundMessage: {
      wamid: "wamid.qa-1",
      from: "+51900000001",
      to: "+51900000002",
      ...overrides,
    },
  };
}

const plain = parseInbound(
  inbound({ type: "text", text: { body: "PRUEBA FIBISER 806" } }),
);
assert.equal(plain?.type, "text");
assert.equal(plain?.rawType, "text");
assert.equal(plain?.text, "PRUEBA FIBISER 806");

const inferredNested = parseInbound(
  inbound({ type: undefined, message: { text: { body: "texto anidado" } } }),
);
assert.equal(inferredNested?.type, "text");
assert.equal(inferredNested?.rawType, "text");
assert.equal(inferredNested?.text, "texto anidado");

const malformedText = parseInbound(inbound({ type: "TEXT" }));
assert.equal(malformedText?.type, "text");
assert.equal(malformedText?.rawType, "text");
assert.equal(
  malformedText?.text,
  "[Mensaje de texto vacío o no compatible]",
);

const button = parseInbound(
  inbound({ type: "button", button: { payload: "qa", text: "Confirmar" } }),
);
assert.equal(button?.type, "text");
assert.equal(button?.rawType, "button");
assert.equal(button?.text, "Confirmar");

const interactive = parseInbound(
  inbound({
    type: "interactive",
    interactive: {
      type: "button_reply",
      button_reply: { id: "qa", title: "Sí, continuar" },
    },
  }),
);
assert.equal(interactive?.type, "text");
assert.equal(interactive?.rawType, "interactive");
assert.equal(interactive?.text, "Sí, continuar");

const voice = parseInbound(
  inbound({
    type: "voice",
    voice: {
      id: "media-qa",
      link: "https://api.ycloud.com/v2/whatsapp/media/download/media-qa",
      mime_type: "audio/ogg",
    },
  }),
);
assert.equal(voice?.type, "audio");
assert.equal(voice?.rawType, "voice");
assert.equal(voice?.text, "[Multimedia]");
assert.equal(voice?.mediaMime, "audio/ogg");

const unsupported = parseInbound(inbound({ type: "future_payload" }));
assert.equal(unsupported?.type, "text");
assert.equal(unsupported?.rawType, "future_payload");
assert.equal(
  unsupported?.text,
  "[Mensaje de WhatsApp no compatible: future_payload]",
);

// Current YCloud production shape when WhatsApp itself does not expose the
// original content. It must remain diagnosable and must never masquerade as
// downloadable media.
const providerUnsupported = parseInbound(
  inbound({
    type: "unsupported",
    unsupported: { type: "poll_creation" },
    errors: [{ code: 131051, title: "not persisted" }],
  }),
);
assert.equal(providerUnsupported?.type, "text");
assert.equal(providerUnsupported?.rawType, "unsupported");
assert.equal(providerUnsupported?.rawSubtype, "poll_creation");
assert.deepEqual(providerUnsupported?.diagnosticCodes, ["131051"]);
assert.equal(
  providerUnsupported?.text,
  "[Mensaje de WhatsApp no compatible: unsupported/poll_creation]",
);

const reaction = parseInbound(
  inbound({
    type: "reaction",
    reaction: { message_id: "wamid.original", emoji: "👍" },
  }),
);
assert.equal(reaction?.type, "text");
assert.equal(reaction?.rawType, "reaction");
assert.equal(reaction?.text, "[Reacción: 👍]");

const contacts = parseInbound(
  inbound({ type: "contacts", contacts: [{}, {}] }),
);
assert.equal(contacts?.type, "text");
assert.equal(contacts?.text, "[2 contacto(s) compartido(s)]");

const system = parseInbound(
  inbound({ type: "system", system: { body: "Cambio de número" } }),
);
assert.equal(system?.type, "system");
assert.equal(system?.text, "Cambio de número");

const order = parseInbound(
  inbound({ type: "order", order: { product_items: [{}, {}, {}] } }),
);
assert.equal(order?.type, "text");
assert.equal(order?.text, "[Pedido compartido: 3 producto(s)]");

const welcome = parseInbound(inbound({ type: "request_welcome" }));
assert.equal(welcome?.type, "text");
assert.equal(welcome?.text, "[Solicitud de bienvenida]");

assert.equal(parseInbound({ type: "whatsapp.message.updated" }), null);

console.log(
  JSON.stringify({
    ok: true,
    assertions: 39,
    covered: [
      "plain_text",
      "nested_text_fallback",
      "malformed_text_fallback",
      "button_reply",
      "interactive_reply",
      "voice_media",
      "future_type_fallback",
      "provider_unsupported_fallback",
      "reaction",
      "contacts",
      "system",
      "order",
      "request_welcome",
      "non_inbound_rejected",
    ],
  }),
);
