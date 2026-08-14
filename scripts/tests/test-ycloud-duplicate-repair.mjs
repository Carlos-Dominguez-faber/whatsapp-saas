import assert from "node:assert/strict";
import { buildDuplicateRepairPatch } from "../../src/features/inbox/services/ycloud-duplicate-repair.ts";

function normalized(overrides = {}) {
  return {
    workspacePhone: "+51900000002",
    from: "+51900000001",
    type: "text",
    rawType: "text",
    rawSubtype: null,
    diagnosticCodes: [],
    text: "PRUEBA YCLOUD TEXTO 806",
    wamid: "wamid.qa-repair",
    customerName: "QA",
    createTime: "2026-08-06T20:11:36.000Z",
    mediaLink: null,
    mediaId: null,
    mediaMime: null,
    mediaFilename: null,
    ...overrides,
  };
}

const textRepair = buildDuplicateRepairPatch(
  { type: "text", body: "[Multimedia]", meta: {} },
  normalized(),
);
assert.ok(textRepair);
assert.equal(textRepair.body, "PRUEBA YCLOUD TEXTO 806");
assert.equal(textRepair.type, undefined);
assert.equal(textRepair.meta?.raw_ycloud_type, "text");
assert.equal(textRepair.meta?.from_name, "QA");

const unsupportedRepair = buildDuplicateRepairPatch(
  { type: "text", body: "[Multimedia]", meta: {} },
  normalized({
    rawType: "unsupported",
    rawSubtype: "poll_creation",
    diagnosticCodes: ["131051"],
    text: "[Mensaje de WhatsApp no compatible: unsupported/poll_creation]",
  }),
);
assert.equal(
  unsupportedRepair?.body,
  "[Mensaje de WhatsApp no compatible: unsupported/poll_creation]",
);
assert.equal(unsupportedRepair?.meta?.raw_ycloud_subtype, "poll_creation");
assert.deepEqual(unsupportedRepair?.meta?.provider_error_codes, ["131051"]);

const preserveRealText = buildDuplicateRepairPatch(
  {
    type: "text",
    body: "Texto real existente",
    meta: { raw_ycloud_type: "text" },
  },
  normalized({
    rawType: "unsupported",
    text: "[Mensaje de WhatsApp no compatible: unsupported]",
  }),
);
assert.equal(preserveRealText?.body, undefined);
assert.equal(preserveRealText?.meta?.raw_ycloud_type, "unsupported");

const mediaTypeRepair = buildDuplicateRepairPatch(
  { type: "text", body: "[Multimedia]", meta: {} },
  normalized({ type: "image", rawType: "image", text: "[Multimedia]" }),
);
assert.equal(mediaTypeRepair?.type, "image");
assert.equal(mediaTypeRepair?.body, undefined);

const idempotent = buildDuplicateRepairPatch(
  {
    type: "text",
    body: "PRUEBA YCLOUD TEXTO 806",
    meta: { from_name: "QA", raw_ycloud_type: "text" },
  },
  normalized(),
);
assert.equal(idempotent, null);

console.log(JSON.stringify({ ok: true, assertions: 13 }));
