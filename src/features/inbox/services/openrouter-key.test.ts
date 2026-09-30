import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveOpenRouterKey } from "./openrouter-key.ts";

function dbWith(row: unknown, error: unknown = null) {
  const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: row, error }) };
  return { from: () => q } as never;
}

test("the classifier's key: own, the platform's, own-but-unreadable, or a failed lookup", async () => {
  process.env.OPENROUTER_API_KEY = "sk-platform";
  assert.deepEqual(await resolveOpenRouterKey("ws", dbWith({ credentials: { openrouter_api_key: "sk-own" } })), {
    scope: "own",
    key: "sk-own",
  });
  assert.deepEqual(await resolveOpenRouterKey("ws", dbWith(null)), { scope: "platform", key: "sk-platform" });
  assert.deepEqual(await resolveOpenRouterKey("ws", dbWith({ credentials: {} })), { scope: "platform", key: "sk-platform" });
  // Stored encrypted, but it can't be decrypted: an error of THAT key, never the agency's.
  const broken = { credentials: { openrouter_api_key: "enc:not-a-real-ciphertext" } };
  const r = await resolveOpenRouterKey("ws", dbWith(broken));
  assert.equal(r.scope, "own");
  assert.equal(r.key, null);
  assert.deepEqual(await resolveOpenRouterKey("ws", dbWith(null, { code: "57014" })), {
    scope: null,
    key: null,
    problem: "lookup_failed",
  });
});
