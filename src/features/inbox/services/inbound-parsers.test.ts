import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInbound as parseYCloud } from "./ycloud-webhook-handler.ts";
import { parseInbound as parseKapso } from "./kapso-webhook-handler.ts";

function ycloud(message: Record<string, unknown>) {
  return parseYCloud({
    type: "whatsapp.inbound_message.received",
    createTime: "2026-09-26T19:42:00.000Z",
    whatsappInboundMessage: {
      wamid: "wamid.qa-1",
      from: "+51900000001",
      to: "+51900000002",
      ...message,
    },
  });
}

function kapso(message: Record<string, unknown>) {
  return parseKapso(
    {
      phone_number_id: "pn_1",
      message: { id: "wamid.k-1", from: "15550000001", timestamp: "1759000000", ...message },
    },
    "whatsapp.message.received",
  );
}

test("YCloud: a template button tap reaches the agent as its text", () => {
  const button = ycloud({ type: "button", button: { payload: "qa", text: "Confirmar" } });
  assert.equal(button?.type, "text");
  assert.equal(button?.text, "Confirmar");
});

test("YCloud: an interactive reply reaches the agent as the option chosen", () => {
  const reply = ycloud({
    type: "interactive",
    interactive: { type: "list_reply", list_reply: { id: "b", title: "Martes 10am" } },
  });
  assert.equal(reply?.text, "Martes 10am");
});

test("YCloud: a location keeps its enum type and reads as a place", () => {
  const loc = ycloud({ type: "location", location: { name: "Clínica", address: "Av. 5" } });
  assert.equal(loc?.type, "location");
  assert.equal(loc?.text, "[Ubicación compartida: Clínica, Av. 5]");
});

test("YCloud: media is untouched", () => {
  const voice = ycloud({
    type: "voice",
    voice: { id: "m1", link: "https://api.ycloud.com/v2/whatsapp/media/download/m1", mime_type: "audio/ogg" },
  });
  assert.equal(voice?.type, "audio");
  assert.equal(voice?.text, "[Multimedia]");
  assert.equal(voice?.mediaMime, "audio/ogg");
});

test("Kapso: button and interactive replies read the same way", () => {
  assert.equal(kapso({ type: "button", button: { text: "Sí" } })?.text, "Sí");
  assert.equal(
    kapso({
      type: "interactive",
      interactive: { type: "button_reply", button_reply: { id: "x", title: "Agendar" } },
    })?.text,
    "Agendar",
  );
  assert.equal(
    kapso({ type: "order", order: { text: "2 pasteles" } })?.text,
    "[Pedido del catálogo]: 2 pasteles",
  );
});
