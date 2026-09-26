import { estimateCostUsd } from "@/features/jev-judge/cost";

export interface JudgmentMetrics {
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  success: boolean;
  fallbackUsed: boolean;
  error?: string;
}

export function trackJudgment(metrics: JudgmentMetrics): void {
  console.log(
    JSON.stringify({
      event: "ai_request",
      feature: "jev-judge",
      timestamp: new Date().toISOString(),
      ...metrics,
      estimatedCostUsd: estimateCostUsd(metrics.inputTokens),
    }),
  );
}
