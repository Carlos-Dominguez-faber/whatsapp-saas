import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

/**
 * Mientras HubSpot no tenga agenda propia, desactivar HighLevel también apaga el agendamiento de citas. No es obvio del botón
 * "Desactivar", así que se avisa ANTES de ejecutarlo.
 *
 * El proyecto no tiene runner de componentes (node --test, sin jsdom), así que igual que
 * crm-panel.test.ts el contrato se afirma sobre el fuente: es lo único que se pone rojo si
 * alguien saca el aviso o lo mueve después del PUT.
 */
const source = readFileSync(new URL("./integrations-tab.tsx", import.meta.url), "utf8");

test("desactivar HighLevel avisa del impacto en el agendamiento ANTES de mandar el PUT", () => {
  const start = source.indexOf("async function handleDisable()");
  assert.notEqual(start, -1, "no encontré handleDisable en integrations-tab.tsx");
  const putCall = source.indexOf("crmDisableBody(\"highlevel\")", start);
  assert.notEqual(putCall, -1, "no encontré el PUT de desactivar HighLevel");
  const before = source.slice(start, putCall);

  assert.ok(before.includes("window.confirm("), "falta el confirm antes del PUT");
  assert.match(before, /agend/i, "el aviso tiene que mencionar el agendamiento");
  assert.ok(before.includes("return;"), "sin confirmar, no debe seguir hacia el PUT");
});
