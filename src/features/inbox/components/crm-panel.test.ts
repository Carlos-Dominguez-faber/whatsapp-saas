import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

/**
 * El proyecto no tiene runner de componentes (node --test, sin jsdom, y el glob de tests es
 * `*.test.ts`), así que el contrato se afirma sobre el fuente.
 */
const source = readFileSync(
  new URL("./crm-panel.tsx", import.meta.url),
  "utf8",
);

// Un sync manual exitoso puede rellenar nombre/email en el servidor (pull de HubSpot); sin
// refrescar, el panel se queda mostrando el snapshot viejo hasta recargar a mano.
test("un sync CRM exitoso refresca la página (router.refresh), no solo el toast", () => {
  const start = source.indexOf("function handleSyncCrm()");
  assert.notEqual(start, -1, "no encontré handleSyncCrm en crm-panel.tsx");
  const end = source.indexOf("\n  }", start);
  assert.notEqual(end, -1, "no encontré el cierre de handleSyncCrm");
  const body = source.slice(start, end);

  assert.ok(body.includes("result.ok"), "el refresh tiene que condicionarse al éxito");
  const okBranchStart = body.indexOf("if (result.ok)");
  const okBranchEnd = body.indexOf("} else", okBranchStart);
  const okBranch = body.slice(okBranchStart, okBranchEnd);
  assert.ok(
    okBranch.includes("router.refresh()"),
    "el branch de éxito tiene que llamar router.refresh(), no solo el toast",
  );
});

test("el sync manual no manda el workspace desde el cliente", () => {
  assert.ok(source.includes("syncContactCrm(contact.id)"), "el workspace se deriva en el servidor");
});
