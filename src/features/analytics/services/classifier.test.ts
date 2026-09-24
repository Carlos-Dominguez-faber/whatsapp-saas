import assert from "node:assert/strict";
import { mock, test } from "node:test";

type GenerateImpl = (opts: Record<string, unknown>) => Promise<unknown>;
let generateImpl: GenerateImpl = async () => ({ output: { matches: [] }, usage: { inputTokens: 10, outputTokens: 2 } });
let lastOpts: Record<string, unknown> | null = null;

class FakeNoObjectGeneratedError extends Error {
  usage = { inputTokens: 7, outputTokens: 3 };
  constructor() {
    super("no object");
    this.name = "AI_NoObjectGeneratedError";
  }
}

// El de verdad NO trae usage (index.d.ts:4811-4814): por eso el usage tiene que
// venir de result.usage, leído antes de tocar result.output.
class FakeNoOutputGeneratedError extends Error {
  constructor() {
    super("no output");
    this.name = "AI_NoOutputGeneratedError";
  }
}

// Forma de @ai-sdk/provider: statusCode ausente = la red se cayó
// (provider-utils `handleFetchError`).
class FakeAPICallError extends Error {
  statusCode?: number;
  constructor(statusCode?: number) {
    super(`api ${statusCode}`);
    this.statusCode = statusCode;
    this.name = "AI_APICallError";
  }
}

mock.module("ai", {
  exports: {
    APICallError: { isInstance: (e: unknown) => e instanceof FakeAPICallError },
    generateText: (opts: Record<string, unknown>) => {
      lastOpts = opts;
      return generateImpl(opts);
    },
    Output: { object: (cfg: unknown) => ({ kind: "object", cfg }) },
    NoObjectGeneratedError: {
      isInstance: (e: unknown) => e instanceof FakeNoObjectGeneratedError,
    },
    NoOutputGeneratedError: {
      isInstance: (e: unknown) => e instanceof FakeNoOutputGeneratedError,
    },
  },
});

mock.module("@ai-sdk/openai", {
  exports: { createOpenAI: () => ({ chat: (id: string) => ({ modelId: id }) }) },
});

let keyImpl: () => Promise<string> = async () => "sk-test";
mock.module("@/features/inbox/services/openrouter.ts", {
  exports: { getOpenRouterApiKey: () => keyImpl() },
});

const { classifyConversation, classificationTokenCeiling, CLASSIFY_MODEL, MAX_OUTPUT_TOKENS, PROMPT_OVERHEAD_TOKENS } =
  await import("./classifier.ts");
const { CLASSIFY_DAILY_TOKEN_CAP } = await import("./classify-topics.ts");
const { buildClassificationPrompt, ClassificationOutputSchema, MAX_PROMPT_CHARS, MAX_PROMPT_MESSAGES } = await import(
  "../lib/classify-prompt.ts"
);
const { z } = await import("zod");

const topics = [{ id: "topic-price", name: "Precio", description: "Objeción de precio" }];
const messages = [
  { id: "m1", direction: "in" as const, sender_user_id: null, body: "está caro", created_at: "2026-09-01T10:00:00Z" },
];

function call() {
  return classifyConversation({
    workspaceId: "ws-1",
    topics,
    messages,
    abortSignal: new AbortController().signal,
  });
}

test("éxito: resuelve claves a ids, usa el modelo barato y reporta tokens", async () => {
  generateImpl = async () => ({
    output: { matches: [{ topic: "T1", message: 1 }] },
    usage: { inputTokens: 120, outputTokens: 8 },
  });
  const r = await call();
  assert.deepEqual(r, {
    ok: true,
    matches: [{ topic_id: "topic-price", message_id: "m1" }],
    usage: { promptTokens: 120, completionTokens: 8 },
  });
  assert.deepEqual(lastOpts?.model, { modelId: CLASSIFY_MODEL });
  assert.equal(lastOpts?.temperature, 0);
  assert.ok(lastOpts?.abortSignal instanceof AbortSignal);
  // El techo de gasto depende de estos dos. Sin maxRetries: 0 el SDK
  // hace hasta 3 peticiones por clasificación.
  assert.equal(lastOpts?.maxRetries, 0);
  assert.equal(lastOpts?.maxOutputTokens, MAX_OUTPUT_TOKENS);
});

test("tema inventado por el modelo se descarta sin fallar", async () => {
  generateImpl = async () => ({ output: { matches: [{ topic: "T7", message: 1 }] }, usage: { inputTokens: 1, outputTokens: 1 } });
  const r = await call();
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.matches, []);
});

test("salida con forma inválida → invalid_output con tokens", async () => {
  generateImpl = async () => ({ output: { matches: "ninguno" }, usage: { inputTokens: 5, outputTokens: 1 } });
  assert.deepEqual(await call(), { ok: false, code: "invalid_output", usage: { promptTokens: 5, completionTokens: 1 } });
});

test("el SDK no logra parsear el objeto → invalid_output con los tokens del error", async () => {
  generateImpl = async () => {
    throw new FakeNoObjectGeneratedError();
  };
  assert.deepEqual(await call(), { ok: false, code: "invalid_output", usage: { promptTokens: 7, completionTokens: 3 } });
});

test("respuesta truncada: el getter de output lanza, pero el consumo NO se pierde", async () => {
  // finishReason "length": el SDK resolvió la llamada (y el proveedor la
  // cobró), pero `result.output` lanza NoOutputGeneratedError, que no trae
  // usage. El usage tiene que salir de result.usage, leído antes.
  generateImpl = async () => ({
    usage: { inputTokens: 1234, outputTokens: 400 },
    get output() {
      throw new FakeNoOutputGeneratedError();
    },
  });
  assert.deepEqual(await call(), {
    ok: false,
    code: "invalid_output",
    usage: { promptTokens: 1234, completionTokens: 400 },
  });
});

// Formas REALES de `result.usage` en ai 6.0.198 +
// @ai-sdk/openai 3.0.68 (asLanguageModelUsage ∘ convertOpenAIChatUsage).
const sdkUsage = (raw: Record<string, unknown> | undefined) =>
  raw === undefined
    ? { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined, raw: undefined }
    : { inputTokens: Number(raw.prompt_tokens ?? 0), outputTokens: Number(raw.completion_tokens ?? 0), raw };

test("respuesta sin usage → usage null (la reserva conserva la estimación), no ceros", async () => {
  generateImpl = async () => ({ output: { matches: [] }, usage: sdkUsage(undefined) });
  assert.deepEqual(await call(), { ok: true, matches: [], usage: null });
});

test("usage con UN solo conteo → null: el SDK rellena el otro con 0 y subcontaría", async () => {
  for (const raw of [{ prompt_tokens: 120 }, { completion_tokens: 8 }, { total_tokens: 128 }, { prompt_tokens: 120, completion_tokens: null }]) {
    generateImpl = async () => ({ output: { matches: [] }, usage: sdkUsage(raw) });
    assert.deepEqual(await call(), { ok: true, matches: [], usage: null }, JSON.stringify(raw));
  }
  // Y en el camino de error, que lee el usage del error del SDK.
  generateImpl = async () => {
    const err = new FakeNoObjectGeneratedError();
    (err as { usage: unknown }).usage = sdkUsage({ prompt_tokens: 50 });
    throw err;
  };
  assert.deepEqual(await call(), { ok: false, code: "invalid_output", usage: null });
});

test("usage completo con raw → se liquida lo real, incluido un 0 informado", async () => {
  generateImpl = async () => ({ output: { matches: [] }, usage: sdkUsage({ prompt_tokens: 120, completion_tokens: 0 }) });
  assert.deepEqual(await call(), { ok: true, matches: [], usage: { promptTokens: 120, completionTokens: 0 } });
});

test("error desconocido → provider_unavailable, sin propagar el mensaje", async () => {
  generateImpl = async () => {
    throw new Error("401 invalid api key sk-live-123");
  };
  const r = await call();
  assert.deepEqual(r, { ok: false, code: "provider_unavailable", usage: null });
  assert.doesNotMatch(JSON.stringify(r), /sk-live/);
});

test("caída del proveedor (5xx, 429, 408, red, clave, créditos) → provider_unavailable", async () => {
  for (const status of [500, 502, 503, 429, 408, 409, 401, 402, 403, 404, undefined]) {
    generateImpl = async () => {
      throw new FakeAPICallError(status);
    };
    assert.deepEqual(await call(), { ok: false, code: "provider_unavailable", usage: null }, `status ${status}`);
  }
});

test("el proveedor rechaza ESTE contenido (400, 413, 422) → provider_error, que sí gasta intento", async () => {
  for (const status of [400, 413, 422]) {
    generateImpl = async () => {
      throw new FakeAPICallError(status);
    };
    assert.deepEqual(await call(), { ok: false, code: "provider_error", usage: null }, `status ${status}`);
  }
});

// ── Techo de tokens───────────────────────────
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

test("techo: cubre los bytes del prompt real + overhead + salida", () => {
  const long = [{ ...messages[0], body: "ñandú €".repeat(200) }];
  const p = buildClassificationPrompt(topics, long);
  assert.equal(
    classificationTokenCeiling(topics, long),
    bytes(p.system) + bytes(p.user) + PROMPT_OVERHEAD_TOKENS + MAX_OUTPUT_TOKENS,
  );
  // Un prompt más largo nunca estima menos.
  assert.ok(classificationTokenCeiling(topics, long) > classificationTokenCeiling(topics, messages));
});

test("techo: el overhead cubre el JSON schema que viaja en response_format", () => {
  const schema = JSON.stringify(z.toJSONSchema(ClassificationOutputSchema));
  // + ~4 tokens de framing por cada uno de los 2 mensajes y el nombre del schema.
  assert.ok(bytes(schema) + 100 < PROMPT_OVERHEAD_TOKENS, `schema de ${bytes(schema)} bytes`);
});

test("techo: el peor caso posible (60 × 800 unidades de 3 bytes, 10 temas llenos) cabe en un día vacío", () => {
  // "€" = 1 unidad UTF-16 y 3 bytes UTF-8: el máximo de bytes por unidad.
  const worstTopics = Array.from({ length: 10 }, (_, i) => ({
    id: `t${i}`,
    name: "€".repeat(60),
    description: "€".repeat(500),
  }));
  const worstMessages = Array.from({ length: MAX_PROMPT_MESSAGES + 5 }, (_, i) => ({
    id: `m${i}`,
    direction: "in" as const,
    sender_user_id: null,
    body: "€".repeat(MAX_PROMPT_CHARS * 2),
    created_at: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
  }));
  const worst = classificationTokenCeiling(worstTopics, worstMessages);
  assert.ok(worst < CLASSIFY_DAILY_TOKEN_CAP, `peor caso ${worst}`);
});

test("abort por tiempo → timeout", async () => {
  const controller = new AbortController();
  generateImpl = async () => {
    controller.abort();
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  };
  const r = await classifyConversation({ workspaceId: "ws-1", topics, messages, abortSignal: controller.signal });
  assert.deepEqual(r, { ok: false, code: "timeout", usage: null });
});

test("clave de OpenRouter ilegible → provider_unavailable (configuración), no lanza y no llama al modelo", async () => {
  keyImpl = async () => {
    throw new Error("openrouter_key_unreadable");
  };
  lastOpts = null;
  const r = await call();
  keyImpl = async () => "sk-test";
  assert.deepEqual(r, { ok: false, code: "provider_unavailable", usage: null });
  assert.equal(lastOpts, null);
});
