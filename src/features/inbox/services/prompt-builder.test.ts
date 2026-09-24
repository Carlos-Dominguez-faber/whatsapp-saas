import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSystemPrompt } from "./prompt-builder.ts";

const TOOL_HONESTY_HEADING = "## Honestidad sobre tus capacidades";

test("TOOL_HONESTY_NOTE is always present, even with only the required parts", () => {
  const result = buildSystemPrompt({
    nowContext: "now",
    bizContext: "biz",
    promptBase: "base",
  });

  assert.match(result, new RegExp(TOOL_HONESTY_HEADING));
  assert.match(
    result,
    /NUNCA prometas una acción/,
    "expected the never-promise instruction to be present",
  );
  // Sin esto el modelo enumera sus limitaciones ante un simple "Hola".
  assert.match(
    result,
    /NUNCA anuncies, enumeres ni aclares tus limitaciones/,
    "expected the tool-honesty note to be explicitly reactive",
  );
});

test("TOOL_HONESTY_NOTE comes after the guardrails block when guardrails are configured", () => {
  const result = buildSystemPrompt({
    nowContext: "now",
    bizContext: "biz",
    promptBase: "base",
    guardrails: {
      rules: ["siempre ofrece enviar confirmación por correo"],
    },
  });

  const guardrailsIndex = result.indexOf("REGLAS ESTRICTAS");
  const honestyIndex = result.indexOf(TOOL_HONESTY_HEADING);

  assert.ok(guardrailsIndex >= 0, "expected the guardrails block to be present");
  assert.ok(honestyIndex >= 0, "expected the tool-honesty note to be present");
  assert.ok(
    honestyIndex > guardrailsIndex,
    "expected the tool-honesty note to come after the guardrails block, so a workspace rule can't override it",
  );
});
