import { createOpenAI } from "@ai-sdk/openai";
import { APICallError, generateText, NoObjectGeneratedError, NoOutputGeneratedError, Output } from "ai";
import {
  buildClassificationPrompt,
  ClassificationOutputSchema,
  resolveMatches,
  type PromptMessage,
  type PromptTopic,
  type TopicMatch,
} from "../lib/classify-prompt";

// Modelo fijo. Por workspace si algún cliente lo pide.
export const CLASSIFY_MODEL = "openai/gpt-4o-mini";

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
}

/** Techo de salida por petición. Sin techo de salida no hay techo de gasto. */
export const MAX_OUTPUT_TOKENS = 400;

/**
 * UNA petición HTTP por clasificación. Con el
 * default del SDK (maxRetries 2, ai/dist/index.mjs `prepareRetries`), un 503
 * haría 3 peticiones por conversación y el techo de gasto se triplicaría. Una
 * caída del proveedor corta la fase, y el reintento es la corrida
 * siguiente del cron (5 min).
 */
const MAX_RETRIES = 0;

/**
 * Framing del chat (roles y separadores, ~4 tokens por mensaje) más el JSON
 * schema que el SDK manda en `response_format` (@ai-sdk/openai, `json_schema`).
 * El schema serializado ocupa ~380 bytes; classifier.test.ts verifica que
 * este margen lo cubre.
 */
export const PROMPT_OVERHEAD_TOKENS = 1_000;

/**
 * Techo REAL de tokens de una clasificación, para reservarlo antes
 * de llamar. Se calcula sobre el prompt que de verdad se va a mandar:
 * gpt-4o-mini usa un BPE a nivel de byte (o200k), así que cada token cubre al
 * menos un byte y `tokens ≤ bytes UTF-8`. Es pesimista a propósito (el español
 * rinde ~4 bytes por token) y no depende de ningún promedio. El peor caso con
 * las constantes (60 × 800 unidades a 3 bytes + 10 temas) está en el test y
 * queda bajo CLASSIFY_DAILY_TOKEN_CAP: una conversación siempre cabe en un día
 * vacío.
 */
export function classificationTokenCeiling(topics: PromptTopic[], messages: PromptMessage[]): number {
  const prompt = buildClassificationPrompt(topics, messages);
  const bytes = Buffer.byteLength(prompt.system, "utf8") + Buffer.byteLength(prompt.user, "utf8");
  return (MAX_RETRIES + 1) * (bytes + PROMPT_OVERHEAD_TOKENS + MAX_OUTPUT_TOKENS);
}

/**
 * Every outcome falls in exactly one class of the run's failure model
 * (classify-topics.ts, header):
 * - `invalid_output` / `content_rejected` (400, 413, 422, moderation, or an
 *   answer that isn't an HTTP error, can't be read and carries no error):
 *   this text. The conversation spends an attempt. A 200 that carries an
 *   error, or finish_reason "error", is the provider failing after the
 *   headers: classified by the error's code like a status (errorInsideOk).
 * - `key_rejected` (401, 402, 403 other than moderation, 404 — OpenRouter's
 *   "no endpoints match your data policy" —, 429 and any other 4xx): the key
 *   the call ran on. That key goes down.
 * - `provider_unavailable` (5xx, 408, 409, 425, the network) and `timeout`:
 *   transient. They count toward the key's streak, and the conversation
 *   waits, no attempt spent.
 */
export type ClassifyErrorCode =
  | "invalid_output"
  | "content_rejected"
  | "key_rejected"
  | "provider_unavailable"
  | "timeout";

/** The key a call ran on: the workspace's own, or the platform's. */
export type KeyScope = "own" | "platform";

/**
 * `usage`: what to settle the reservation with. A number (0 included) is
 * known; null means unknown, and the reservation keeps its estimate.
 */
export type ClassifyResult =
  | { ok: true; matches: TopicMatch[]; usage: LlmUsage | null; keyScope: KeyScope }
  | { ok: false; code: ClassifyErrorCode; usage: LlmUsage | null; keyScope: KeyScope };

/**
 * Estados HTTP que culpan al CONTENIDO (petición mal formada por lo que
 * trae, demasiado grande). Lista blanca, como `isDataRejection`. Un 400 por un
 * parámetro nuestro mal configurado sí gasta intentos (eso lo delata un smoke
 * antes de desplegar).
 */
const CONTENT_REJECTED = new Set([400, 413, 422]);

/**
 * HTTP answers that say "try again": the provider (or its route to the model)
 * is failing now. Any other 4xx says the KEY the call ran on can't be used
 * now: invalid or revoked (401), out of credit (402), not allowed (403), no
 * endpoint for its account's data policy (404), rate limited (429).
 */
const TRANSIENT_STATUS = new Set([408, 409, 425]);
const isTransientStatus = (status: number) => status >= 500 || TRANSIENT_STATUS.has(status);

/**
 * OpenRouter answers a moderation refusal with 403 and says so in the body
 * ("…requires moderation…", "flagged"). That is about this text, not the key.
 */
function isModeration(status: number, body: string | undefined): boolean {
  return status === 403 && /moderat|flagged/i.test(body ?? "");
}

/** The class of an error the provider reported, by its HTTP-like code. */
function classOf(status: number, body: string | undefined): "content_rejected" | "provider_unavailable" | "key_rejected" {
  if (CONTENT_REJECTED.has(status) || isModeration(status, body)) return "content_rejected";
  if (isTransientStatus(status)) return "provider_unavailable";
  return "key_rejected";
}

/**
 * A provider that fails AFTER OpenRouter sent the headers can't change the
 * status: OpenRouter answers 200 with `{"error": {"code", "message"}}` and no
 * choices (or a choice with finish_reason "error" and its own `error`). That
 * is the provider failing, not this text: it is classified by that code, and
 * with no code at all it is transient. Returns null when there is no error in
 * the body — only then is an unreadable 200 this text's fault.
 */
function errorInsideOk(body: unknown): { status: number | null; text: string } | null {
  let parsed = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
  }
  const b = parsed as { error?: { code?: unknown }; choices?: Array<{ error?: { code?: unknown } }> } | null;
  const error = b?.error ?? b?.choices?.[0]?.error;
  if (!error || typeof error !== "object") return null;
  const code = Number(error.code);
  return {
    status: Number.isInteger(code) && code >= 400 && code <= 599 ? code : null,
    text: typeof body === "string" ? body : JSON.stringify(parsed),
  };
}

/** A failure the provider reported inside a 200: the estimate stays (it may have billed). */
function providerFailed(inside: { status: number | null; text: string } | null, usage: LlmUsage | null, keyScope: KeyScope): ClassifyResult {
  const code = inside?.status == null ? "provider_unavailable" : classOf(inside.status, inside.text);
  return { ok: false, code, usage, keyScope };
}

/** finish_reason "error" (OpenRouter), which the SDK reports as "other". */
const failedMidGeneration = (unified: string | undefined, raw: string | undefined) =>
  unified === "other" || raw === "error";

/**
 * An HTTP error answer (4xx or 5xx) means no generation was billed, so the
 * caller settles the reservation at 0. No answer at all (timeout, network)
 * leaves it unknown: the reservation keeps its estimate, a ceiling.
 */
const REFUSED_USAGE: LlmUsage = { promptTokens: 0, completionTokens: 0 };

/**
 * `null` si el proveedor NO informó los dos conteos,
 * y el caller deja la reserva con la estimación. Liquidar un campo ausente
 * como 0 subcontaría el tope duro. Dos trampas del SDK (ai 6.0.198,
 * @ai-sdk/openai 3.0.68):
 * - `result.usage` nunca es falsy: sin `usage` en la respuesta llega un objeto
 *   con `inputTokens`/`outputTokens` undefined (convertOpenAIChatUsage).
 * - Con `usage` presente pero sin `prompt_tokens` o `completion_tokens`, el
 *   SDK rellena ese campo con 0. Solo `raw` (el `usage` sin normalizar) lo
 *   delata, así que se exige el número también ahí cuando viene.
 */
function toUsage(
  u: { inputTokens?: number; outputTokens?: number; raw?: unknown } | undefined | null,
): LlmUsage | null {
  if (typeof u?.inputTokens !== "number" || typeof u.outputTokens !== "number") return null;
  const raw = u.raw as { prompt_tokens?: unknown; completion_tokens?: unknown } | null | undefined;
  if (raw != null && (typeof raw.prompt_tokens !== "number" || typeof raw.completion_tokens !== "number")) {
    return null;
  }
  return { promptTokens: u.inputTokens, completionTokens: u.outputTokens };
}

/** Nunca lanza: el cron registra el código y sigue con la siguiente conversación. */
export async function classifyConversation(params: {
  workspaceId: string;
  topics: PromptTopic[];
  messages: PromptMessage[];
  abortSignal: AbortSignal;
  /** Resolved by the caller (resolveOpenRouterKey), once per workspace and run. */
  key: { scope: KeyScope; key: string };
}): Promise<ClassifyResult> {
  const prompt = buildClassificationPrompt(params.topics, params.messages);
  const keyScope = params.key.scope;

  try {
    const openrouter = createOpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: params.key.key,
      headers: {
        "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
        "X-Title": "Agente WhatsApp",
      },
    });

    const result = await generateText({
      model: openrouter.chat(CLASSIFY_MODEL),
      system: prompt.system,
      prompt: prompt.user,
      output: Output.object({ schema: ClassificationOutputSchema }),
      temperature: 0,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      maxRetries: MAX_RETRIES,
      abortSignal: params.abortSignal,
    });

    // `result.usage` PRIMERO. `result.output` es un getter que lanza
    // NoOutputGeneratedError cuando el finishReason no dejó salida estructurada
    // (index.mjs:4728, :4854), y ese error no trae usage. Si se lee después, se
    // pierden tokens ya pagados y el presupuesto autoriza más gasto del real.
    const usage = toUsage(result.usage);

    // The provider failed mid-generation (finish_reason "error"): transient,
    // with what it reports it spent (or the estimate).
    if (failedMidGeneration(result.finishReason, result.rawFinishReason)) {
      return providerFailed(errorInsideOk(result.response?.body), usage, keyScope);
    }

    let output: unknown;
    try {
      output = result.output;
    } catch (outputErr) {
      if (NoOutputGeneratedError.isInstance(outputErr) || NoObjectGeneratedError.isInstance(outputErr)) {
        return { ok: false, code: "invalid_output", usage, keyScope };
      }
      throw outputErr;
    }

    const matches = resolveMatches(output, prompt);
    if (matches === null) return { ok: false, code: "invalid_output", usage, keyScope };
    return { ok: true, matches, usage, keyScope };
  } catch (err) {
    // El mismo par de errores puede salir de `generateText` en vez del getter.
    if (NoObjectGeneratedError.isInstance(err)) {
      if (failedMidGeneration(err.finishReason, undefined)) return providerFailed(null, toUsage(err.usage), keyScope);
      return { ok: false, code: "invalid_output", usage: toUsage(err.usage), keyScope };
    }
    if (NoOutputGeneratedError.isInstance(err)) {
      return { ok: false, code: "invalid_output", usage: null, keyScope };
    }
    if (params.abortSignal.aborted || (err instanceof Error && err.name === "AbortError")) {
      return { ok: false, code: "timeout", usage: null, keyScope };
    }
    if (APICallError.isInstance(err) && err.statusCode != null) {
      const status = err.statusCode;
      // Not an HTTP error: a 200 whose body the SDK couldn't take. With an
      // error inside, the provider failed after the headers (classified by
      // its code, the estimate kept: it may have billed); without one, this
      // text is what failed.
      if (status < 400 || status > 599) {
        const inside = errorInsideOk(err.responseBody);
        if (inside) return providerFailed(inside, null, keyScope);
        return { ok: false, code: "invalid_output", usage: null, keyScope };
      }
      // Below, an HTTP error answer: nothing was generated.
      const code = classOf(status, err.responseBody);
      return { ok: false, code, usage: REFUSED_USAGE, keyScope };
    }
    // The network down or anything unknown: transient, usage unknown.
    return { ok: false, code: "provider_unavailable", usage: null, keyScope };
  }
}
