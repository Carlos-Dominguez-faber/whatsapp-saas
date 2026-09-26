import assert from "node:assert/strict";
import { test } from "node:test";
import { whatsappSender } from "./whatsapp-sender.ts";

// A sender without the id it sends from must say so — before calling the
// provider, whose answer to an empty id is opaque.

let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls++;
  return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 });
}) as typeof fetch;

test("Kapso without phone_number_id names the missing setting", async () => {
  fetchCalls = 0;
  const sender = whatsappSender("kapso", { kapso_api_key: "kp" }, { phone_number_id: "" });
  await assert.rejects(sender.sendText("+15550001111", "hola"), /Falta el Phone Number ID de Kapso/);
  await assert.rejects(
    sender.sendTemplate({ to: "+15550001111", templateName: "t" }),
    /Falta el Phone Number ID de Kapso/,
  );
  assert.equal(fetchCalls, 0, "the provider is never called");
});

test("YCloud without its number names the missing setting", async () => {
  fetchCalls = 0;
  const sender = whatsappSender("ycloud", { ycloud_api_key: "yk" }, {});
  await assert.rejects(sender.sendText("+5215550001111", "hola"), /Falta el número de WhatsApp de YCloud/);
  assert.equal(fetchCalls, 0);
});

test("a configured Kapso sender still sends", async () => {
  fetchCalls = 0;
  const sender = whatsappSender("kapso", { kapso_api_key: "kp" }, { phone_number_id: "pn_1" });
  const sent = await sender.sendText("+15550001111", "hola");
  assert.equal(sent.wamid, "wamid.1");
  assert.equal(fetchCalls, 1);
});
