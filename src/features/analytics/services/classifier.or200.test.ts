import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyConversation } from "./classifier.ts";

// REVIEW r4 M1: OpenRouter documents that when the provider fails after the
// headers went out, a non-streaming request answers 200 with only an `error`
// (or a choice with finish_reason "error"). The real SDK, fetch stubbed: that
// is the provider failing (transient, the estimate kept), never this text.

const call = () =>
  classifyConversation({
    workspaceId: "ws",
    topics: [{ id: "00000000-0000-0000-0000-000000000001", name: "Precio", description: "pregunta precio" }],
    messages: [
      { id: "00000000-0000-0000-0000-0000000000a1", direction: "in", sender_user_id: null, body: "hola, cuánto cuesta?", created_at: "2026-09-29T10:00:00Z" },
    ] as never,
    abortSignal: AbortSignal.timeout(5_000),
    key: { scope: "platform", key: "sk-test" },
  });

async function answering(body: unknown) {
  const real = globalThis.fetch;
  let hits = 0;
  globalThis.fetch = (async () => {
    hits++;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    return { r: await call(), hits };
  } finally {
    globalThis.fetch = real;
  }
}

test("200 with only {error} (the provider failed after the headers) → TRANSIENT, estimate kept", async () => {
  const { r, hits } = await answering({ error: { code: 502, message: "Provider returned error", metadata: { provider_name: "OpenAI" } } });
  assert.equal(hits, 1);
  assert.deepEqual(r, { ok: false, code: "provider_unavailable", usage: null, keyScope: "platform" });
});

test("200 with {error} is classified by its code like a status", async () => {
  for (const [code, want] of [
    [408, "provider_unavailable"],
    [429, "key_rejected"],
    [402, "key_rejected"],
    [400, "content_rejected"],
  ] as const) {
    const { r } = await answering({ error: { code, message: "x" } });
    assert.equal((r as { code: string }).code, want, `code ${code}`);
    assert.equal(r.usage, null, "a 200 may have billed: the estimate stays");
  }
});

test("200 with a choice whose finish_reason is \"error\" → TRANSIENT, with what the provider reports", async () => {
  const { r } = await answering({
    id: "x",
    choices: [{ index: 0, finish_reason: "error", message: { role: "assistant", content: '{"matc' }, error: { code: 502, message: "upstream" } }],
    usage: { prompt_tokens: 100, completion_tokens: 3, total_tokens: 103 },
  });
  assert.deepEqual(r, { ok: false, code: "provider_unavailable", usage: { promptTokens: 100, completionTokens: 3 }, keyScope: "platform" });
});

test("a 200 that can't be read and carries no error is still this text's fault (CONTENT)", async () => {
  const { r } = await answering("<html>not json</html>");
  assert.deepEqual(r, { ok: false, code: "invalid_output", usage: null, keyScope: "platform" });
});
