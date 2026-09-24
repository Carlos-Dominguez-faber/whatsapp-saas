import { createOpenAI } from "@ai-sdk/openai";
import { APICallError, generateText, NoObjectGeneratedError, NoOutputGeneratedError, Output } from "ai";
import { getOpenRouterApiKey } from "@/features/inbox/services/openrouter";
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
 * `provider_unavailable` NO es culpa de la conversación: el caller lo
 * trata como infraestructura. `provider_error` queda para cuando el proveedor
 * rechazó ESTE contenido.
 */
export type ClassifyErrorCode = "invalid_output" | "provider_error" | "provider_unavailable" | "timeout";

export type ClassifyResult =
  | { ok: true; matches: TopicMatch[]; usage: LlmUsage | null }
  | { ok: false; code: ClassifyErrorCode; usage: LlmUsage | null };

/**
 * Estados HTTP que culpan al CONTENIDO (petición mal formada por lo que
 * trae, demasiado grande). Lista blanca, como `isDataRejection`: 5xx, 408, 409 y
 * 429 (`APICallError.isRetryable`, @ai-sdk/provider), la red caída (el SDK la
 * envuelve en APICallError sin statusCode, provider-utils `handleFetchError`),
 * 401/402/403/404 (clave, créditos, modelo: configuración) y cualquier error
 * desconocido son del proveedor. Techos conocidos: un 403 de moderación de
 * OpenRouter cuenta como caída y corta la fase en vez de gastar intentos, y un
 * 400 por un parámetro nuestro mal configurado sí gasta intentos (eso lo
 * delata un smoke antes de desplegar).
 */
const CONTENT_REJECTED = new Set([400, 413, 422]);

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
}): Promise<ClassifyResult> {
  const prompt = buildClassificationPrompt(params.topics, params.messages);

  try {
    const openrouter = createOpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: await getOpenRouterApiKey(params.workspaceId),
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

    let output: unknown;
    try {
      output = result.output;
    } catch (outputErr) {
      if (NoOutputGeneratedError.isInstance(outputErr) || NoObjectGeneratedError.isInstance(outputErr)) {
        return { ok: false, code: "invalid_output", usage };
      }
      throw outputErr;
    }

    const matches = resolveMatches(output, prompt);
    if (matches === null) return { ok: false, code: "invalid_output", usage };
    return { ok: true, matches, usage };
  } catch (err) {
    // El mismo par de errores puede salir de `generateText` en vez del getter.
    if (NoObjectGeneratedError.isInstance(err)) {
      return { ok: false, code: "invalid_output", usage: toUsage(err.usage) };
    }
    if (NoOutputGeneratedError.isInstance(err)) {
      return { ok: false, code: "invalid_output", usage: null };
    }
    if (params.abortSignal.aborted || (err instanceof Error && err.name === "AbortError")) {
      return { ok: false, code: "timeout", usage: null };
    }
    if (APICallError.isInstance(err) && err.statusCode != null && CONTENT_REJECTED.has(err.statusCode)) {
      return { ok: false, code: "provider_error", usage: null };
    }
    // Incluye la clave de OpenRouter ilegible: es configuración, no la conversación.
    return { ok: false, code: "provider_unavailable", usage: null };
  }
}
