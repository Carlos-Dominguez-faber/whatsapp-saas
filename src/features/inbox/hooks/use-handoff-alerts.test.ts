import assert from "node:assert/strict";
import { test } from "node:test";
import { getBaseTitle, __resetBaseTitleForTests } from "./use-handoff-alerts.ts";

/**
 * Un saneador por regex del título se comería prefijos "(N)" legítimos del
 * título real — "(2026) Inbox" quedaría en "Inbox", "(24)7 Soporte" en
 * "7 Soporte". Por eso el título base se captura UNA sola vez por documento,
 * en una variable de módulo, y todas las instancias del hook reusan ese mismo
 * valor — no hay nada que sanear porque nunca se vuelve a leer
 * `document.title` después de la primera vez.
 */

function setDocumentTitle(title: string) {
  (globalThis as unknown as { document: { title: string } }).document = {
    title,
  };
}

test("getBaseTitle captura document.title la primera vez que se pide", () => {
  __resetBaseTitleForTests();
  setDocumentTitle("Agente WhatsApp");
  assert.equal(getBaseTitle(), "Agente WhatsApp");
});

test("un título que arranca con paréntesis ya no se mutila", () => {
  __resetBaseTitleForTests();
  setDocumentTitle("(2026) Inbox");
  assert.equal(getBaseTitle(), "(2026) Inbox");

  __resetBaseTitleForTests();
  setDocumentTitle("(24)7 Soporte");
  assert.equal(getBaseTitle(), "(24)7 Soporte");
});

test("dos montajes no acumulan contador: la segunda lectura no vuelve a tocar document.title", () => {
  __resetBaseTitleForTests();
  const doc = { title: "Agente WhatsApp" };
  (globalThis as unknown as { document: typeof doc }).document = doc;

  const first = getBaseTitle();
  assert.equal(first, "Agente WhatsApp");

  // Instancia A "monta" y deja el contador puesto en el título real.
  doc.title = "(1) Agente WhatsApp";

  // Instancia B monta después: como el original ya quedó cacheado en la
  // primera llamada, no vuelve a leer document.title y no hereda el prefijo
  // que dejó A.
  const second = getBaseTitle();
  assert.equal(second, "Agente WhatsApp");
});
