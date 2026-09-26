import {
  APITimeoutError,
  AuthenticationError,
  RateLimitError,
  TypeSafeClient,
} from "@typesafe-ai/sdk";
import type { Decision } from "@/features/jev-judge/map-judgment";
import { QUESTIONS } from "@/features/jev-judge/prompts";

const MODEL = "jev-latest";

export interface JevCall {
  model: string;
  action: Decision;
  actionConfidence: number;
  intentScore: number;
  autoReplyProbability: number;
  optOutProbability: number;
  inputTokens: number;
  outputTokens: number;
}

export async function callJev(text: string): Promise<JevCall> {
  const client = new TypeSafeClient({
    defaultModel: MODEL,
    timeout: 8000,
    retry: { maxRetries: 0 },
  });
  const response = await client.systemOne({
    state: text,
    model: MODEL,
    questions: QUESTIONS,
  });
  return {
    model: response.model,
    action: response.answers.action.choice,
    actionConfidence: response.answers.action.confidence,
    intentScore: response.answers.intent.score,
    autoReplyProbability: response.answers.auto_reply.noul,
    optOutProbability: response.answers.opt_out.noul,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

export function jevFailureCode(error: unknown): string {
  if (error instanceof RateLimitError) return "rate_limit";
  if (error instanceof APITimeoutError) return "timeout";
  if (error instanceof AuthenticationError) return "auth";
  return "error";
}

export function publicJevError(code: string): string {
  if (code === "missing_api_key") return "Falta TYPESAFE_API_KEY en el servidor.";
  if (code === "rate_limit") return "Jev limitó las llamadas. Espera un momento.";
  if (code === "auth") return "La key del servidor fue rechazada.";
  if (code === "timeout") return "Jev no respondió a tiempo.";
  return "Jev no respondió.";
}
