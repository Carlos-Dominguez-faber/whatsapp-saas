import assert from "node:assert/strict";
import { test } from "node:test";
import { inboundContentText } from "./inbound-content.ts";

test("a template button tap reads its text, then its payload", () => {
  assert.equal(
    inboundContentText({ button: { payload: "qa", text: "Confirmar" } }, "button"),
    "Confirmar",
  );
  assert.equal(inboundContentText({ button: { payload: "SI" } }, "button"), "SI");
  assert.equal(inboundContentText({}, "button"), "[Respuesta de botón sin texto]");
});

test("interactive replies read the button, list or flow reply", () => {
  assert.equal(
    inboundContentText(
      { interactive: { type: "button_reply", button_reply: { id: "a", title: "Sí, continuar" } } },
      "interactive",
    ),
    "Sí, continuar",
  );
  assert.equal(
    inboundContentText(
      { interactive: { type: "list_reply", list_reply: { id: "b", title: "Martes 10am" } } },
      "interactive",
    ),
    "Martes 10am",
  );
  assert.equal(
    inboundContentText({ interactive: { nfm_reply: { body: "Enviado" } } }, "interactive"),
    "Enviado",
  );
  assert.equal(inboundContentText({}, "interactive"), "[Respuesta interactiva sin texto]");
});

test("orders and locations become readable text", () => {
  assert.equal(
    inboundContentText({ order: { text: "2 pasteles" } }, "order"),
    "[Pedido del catálogo]: 2 pasteles",
  );
  assert.equal(
    inboundContentText(
      { location: { latitude: 1, longitude: 2, name: "Clínica Centro", address: "Av. 5" } },
      "location",
    ),
    "[Ubicación compartida: Clínica Centro, Av. 5]",
  );
  assert.equal(inboundContentText({ location: {} }, "location"), "[Ubicación compartida]");
});

test("an unknown type is named, sanitised, instead of passing as media", () => {
  assert.equal(
    inboundContentText({}, "unsupported"),
    "[Mensaje de WhatsApp no compatible: unsupported]",
  );
  assert.equal(
    inboundContentText({}, "Weird<script>Type"),
    "[Mensaje de WhatsApp no compatible: weirdscripttype]",
  );
});

test("a reaction names its emoji", () => {
  assert.equal(inboundContentText({ reaction: { emoji: "👍" } }, "reaction"), "[Reacción: 👍]");
  assert.equal(inboundContentText({ reaction: {} }, "reaction"), "[Reacción retirada]");
});
