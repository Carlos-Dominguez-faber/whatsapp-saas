import assert from "node:assert/strict";
import { test, mock } from "node:test";

let ownKey: string | null = null;
mock.module("./openrouter.ts", {
  exports: { readWorkspaceOpenRouterKey: async () => ownKey },
});
const emitted: unknown[][] = [];
mock.module("./daily-events.ts", {
  exports: { emitEventOncePerDay: async (...args: unknown[]) => void emitted.push(args) },
});

const { enforceModelPolicy } = await import("./model-policy.ts");
const sb = {} as never;

function reset() {
  ownKey = null;
  emitted.length = 0;
  delete process.env.OPENROUTER_DEFAULT_MODEL;
}

test("catalog models and the platform default pass through untouched", async () => {
  reset();
  assert.equal(await enforceModelPolicy(sb, "ws_1", "anthropic/claude-sonnet-4.6", "agent_turn"), "anthropic/claude-sonnet-4.6");
  assert.equal(await enforceModelPolicy(sb, "ws_1", "openai/gpt-4o-mini", "agent_turn"), "openai/gpt-4o-mini");
  process.env.OPENROUTER_DEFAULT_MODEL = "google/gemini-3.5-flash";
  assert.equal(await enforceModelPolicy(sb, "ws_1", "google/gemini-3.5-flash", "agent_turn"), "google/gemini-3.5-flash");
  assert.equal(emitted.length, 0);
  reset();
});

test("on the platform key a model outside the catalog is replaced and reported", async () => {
  reset();
  const model = await enforceModelPolicy(sb, "ws_1", "openai/o1-pro", "agent_test_chat");
  assert.equal(model, "openai/gpt-4o-mini");
  assert.equal(emitted.length, 1);
  const [, ws, type, level, payload] = emitted[0];
  assert.equal(ws, "ws_1");
  assert.equal(type, "model_outside_catalog");
  assert.equal(level, "warn");
  assert.deepEqual(payload, {
    model: "openai/o1-pro",
    replaced_with: "openai/gpt-4o-mini",
    source: "agent_test_chat",
  });
});

test("a workspace paying with its own OpenRouter key may use any model", async () => {
  reset();
  ownKey = "sk-or-own";
  assert.equal(await enforceModelPolicy(sb, "ws_1", "openai/o1-pro", "agent_turn"), "openai/o1-pro");
  assert.equal(emitted.length, 0);
});
