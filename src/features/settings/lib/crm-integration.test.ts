import assert from "node:assert/strict";
import { test } from "node:test";
import {
  crmBlockedBy,
  crmBlockedMessage,
  crmControls,
  crmDisableBody,
  hubSpotSaveBody,
} from "./crm-integration.ts";

test("un CRM activo bloquea al otro, en las dos direcciones; Cal.com y los inactivos no bloquean", () => {
  const hl = { provider: "highlevel", enabled: true };
  const hs = { provider: "hubspot", enabled: true };
  assert.equal(crmBlockedBy([hl], "hubspot"), "HighLevel");
  assert.equal(crmBlockedBy([hs], "highlevel"), "HubSpot");
  assert.equal(crmBlockedBy([{ ...hl, enabled: false }, { provider: "caldotcom", enabled: true }], "hubspot"), null);
  assert.equal(crmBlockedBy([hs], "hubspot"), null, "uno no se bloquea a sí mismo");
});

test("el aviso dice lo mismo que el 409 del servidor", () => {
  assert.equal(crmBlockedMessage("HighLevel", "hubspot"), "Ya tienes HighLevel conectado como CRM. Desactívalo antes de conectar HubSpot.");
  assert.equal(crmBlockedMessage("HubSpot", "highlevel"), "Ya tienes HubSpot conectado como CRM. Desactívalo antes de conectar HighLevel.");
});

test("bloqueado: no se puede guardar ni probar; Desactivar aparece solo si está habilitado", () => {
  assert.deepEqual(crmControls({ blockedBy: "HighLevel", enabled: false, saving: false, testing: false }), {
    canSave: false,
    canTest: false,
    showDisable: false,
    testHint: null,
  });
  assert.deepEqual(crmControls({ blockedBy: null, enabled: true, saving: false, testing: false }), {
    canSave: true,
    canTest: true,
    showDisable: true,
    testHint: null,
  });
  assert.deepEqual(crmControls({ blockedBy: null, enabled: false, saving: true, testing: true }), {
    canSave: false,
    canTest: false,
    showDisable: false,
    testHint: null,
  });
});

// "Probar conexión" de HubSpot deshabilitado con el token editado y sin
// guardar, con el hint que le dice al admin qué hacer.
test("token editado sin guardar: no se puede probar, con el hint de guardarlo primero", () => {
  assert.deepEqual(crmControls({ blockedBy: null, enabled: true, saving: false, testing: false, tokenDirty: true }), {
    canSave: true,
    canTest: false,
    showDisable: true,
    testHint: "Guarda el token antes de probar",
  });
  // Guardar limpia tokenDirty (lo hace el componente): vuelve a poder probar.
  assert.equal(
    crmControls({ blockedBy: null, enabled: true, saving: false, testing: false, tokenDirty: false }).canTest,
    true,
  );
});

test("guardar el pipeline después de probar NO reenvía el token (no invalida la conexión)", () => {
  // Secuencia: pegar token → Guardar → Probar → elegir pipeline → Guardar.
  const first = hubSpotSaveBody({ token: "pat-na1-x ", tokenDirty: true, pipelineId: "", stageId: "" });
  assert.deepEqual(first, {
    provider: "hubspot",
    enabled: true,
    credentials: { hubspot_token: "pat-na1-x" },
    config: { pipeline_id: "", deal_stage_id: "" },
  });
  // Tras guardar, el componente pone tokenDirty=false (el texto pegado sigue en el estado).
  const second = hubSpotSaveBody({ token: "pat-na1-x", tokenDirty: false, pipelineId: "pl_1", stageId: "st_1" });
  assert.deepEqual(second, { provider: "hubspot", enabled: true, config: { pipeline_id: "pl_1", deal_stage_id: "st_1" } });
});

test("un token editado pero vacío no se envía", () => {
  assert.equal("credentials" in hubSpotSaveBody({ token: "  ", tokenDirty: true, pipelineId: "", stageId: "" }), false);
});

test("desactivar manda solo provider y enabled:false", () => {
  assert.deepEqual(crmDisableBody("highlevel"), { provider: "highlevel", enabled: false });
});
