import assert from "node:assert/strict";
import { test, mock } from "node:test";

// La tool NO debe tocar la base: el traspaso lo aplica buffer.ts después de
// despachar la respuesta (el guard de estado previo al envío descartaría la
// despedida). Si alguien le agrega una escritura, este createClient explota y
// el test falla.
mock.module("@supabase/supabase-js", {
  exports: {
    createClient: () => {
      throw new Error("handoff_human no debe tocar la base");
    },
  },
});

const { handoffHumanTool } = await import("./handoff-human.ts");

const ctx = {
  workspaceId: "ws_1",
  conversationId: "conv_1",
  contactId: "contact_1",
};

test("reason válido devuelve la marca de traspaso y no escribe en la base", async () => {
  for (const reason of ["customer_request", "agent_stuck"] as const) {
    const parsed = handoffHumanTool.schema.safeParse({ reason });
    assert.equal(parsed.success, true);
    const result = await handoffHumanTool.run({ reason }, ctx);
    assert.deepEqual(result, { ok: true, output: { handoff: true, reason } });
  }
});

test("reason inválido o ausente lo rechaza el schema, sin llegar a run", () => {
  for (const args of [
    { reason: "porque si" },
    { reason: "" },
    {},
    { reason: 42 },
    null,
  ]) {
    assert.equal(
      handoffHumanTool.schema.safeParse(args).success,
      false,
      `debió rechazar ${JSON.stringify(args)}`,
    );
  }
});

test("es sensitivity 'write': registry.runTool no la reintenta", () => {
  assert.equal(handoffHumanTool.sensitivity, "write");
});
