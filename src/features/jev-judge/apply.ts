import type { SupabaseClient } from "@supabase/supabase-js";
import { applyTransition } from "@/features/inbox/services/decision-engine";
import { estimateCostUsd } from "@/features/jev-judge/cost";
import { callJev, jevFailureCode, type JevCall } from "@/features/jev-judge/judge";
import {
  stageToPersist,
  type MappedJudgment,
  type StageWrite,
} from "@/features/jev-judge/map-judgment";
import { trackJudgment } from "@/features/jev-judge/observe";
import { PROMPT_VERSION } from "@/features/jev-judge/schema";
import {
  applyUses,
  jevEffect,
  readJevUses,
  type JevUses,
} from "@/features/jev-judge/uses";
import { WHATSAPP_PROVIDER } from "@/features/inbox/services/whatsapp-provider";

const MODEL = "jev-latest";
const IDLE = { suppressReply: false, ownsStage: false };

export interface JevBatchEffect {
  suppressReply: boolean;
  ownsStage: boolean;
}

interface BatchInput {
  workspaceId: string;
  conversationId: string;
  contactId: string;
  mergedText: string;
}

export async function applyJevToBatch(
  supabase: SupabaseClient,
  input: BatchInput,
): Promise<JevBatchEffect> {
  try {
    return await runJevBatch(supabase, input);
  } catch (error: unknown) {
    console.error("[jev] apply failed:", jevFailureCode(error));
    return IDLE;
  }
}

async function runJevBatch(
  supabase: SupabaseClient,
  input: BatchInput,
): Promise<JevBatchEffect> {
  if (!input.mergedText.trim()) return IDLE;
  const runtime = await loadRuntime(supabase, input.workspaceId);
  if (!runtime.enabled) return IDLE;
  if (!process.env.TYPESAFE_API_KEY) {
    await recordFallback(supabase, input, "missing_api_key", 0);
    return IDLE;
  }
  return judgeBatch(supabase, input, runtime.uses);
}

async function judgeBatch(
  supabase: SupabaseClient,
  input: BatchInput,
  uses: JevUses,
): Promise<JevBatchEffect> {
  const started = Date.now();
  try {
    const judged = await callJev(input.mergedText);
    const mapped = applyUses(judged, uses);
    await persistJudgment(supabase, input, judged, mapped, uses);
    trackJudgment({
      model: judged.model,
      inputTokens: judged.inputTokens,
      outputTokens: judged.outputTokens,
      latencyMs: Date.now() - started,
      success: true,
      fallbackUsed: false,
    });
    return jevEffect(mapped, uses);
  } catch (error: unknown) {
    await recordFallback(supabase, input, jevFailureCode(error), Date.now() - started);
    return IDLE;
  }
}

async function loadRuntime(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<{ enabled: boolean; uses: JevUses }> {
  const { data } = await supabase
    .from("integrations")
    .select("config")
    .eq("workspace_id", workspaceId)
    .eq("provider", WHATSAPP_PROVIDER)
    .eq("enabled", true)
    .maybeSingle();
  const config = data?.config ?? null;
  const row = (config ?? {}) as { jev_enabled?: unknown };
  return { enabled: row.jev_enabled === true, uses: readJevUses(config) };
}

async function persistJudgment(
  supabase: SupabaseClient,
  input: BatchInput,
  judged: JevCall,
  mapped: MappedJudgment,
  uses: JevUses,
): Promise<void> {
  try {
    const written = await writeStage(supabase, input.contactId, mapped.stage);
    if (mapped.decision === "handoff") await moveToHandoff(input.conversationId);
    await insertJudgment(
      supabase,
      input,
      judged,
      mapped,
      written.stage,
      written.blockedCustomer,
      uses,
    );
  } catch (error: unknown) {
    console.error(
      "[jev] persist failed:",
      error instanceof Error ? error.message : "unknown",
    );
  }
}

async function writeStage(
  supabase: SupabaseClient,
  contactId: string,
  mappedStage: StageWrite,
): Promise<{ stage: StageWrite; blockedCustomer: boolean }> {
  const { data } = await supabase
    .from("contacts")
    .select("stage")
    .eq("id", contactId)
    .maybeSingle();
  const current = data?.stage as string | undefined;
  const stage = stageToPersist(mappedStage, current);
  const blockedCustomer = mappedStage !== null && stage === null && current === "customer";
  if (stage) {
    await supabase.from("contacts").update({ stage }).eq("id", contactId);
  }
  return { stage, blockedCustomer };
}

async function insertJudgment(
  supabase: SupabaseClient,
  input: BatchInput,
  judged: JevCall,
  mapped: MappedJudgment,
  stage: StageWrite,
  blockedCustomer: boolean,
  uses: JevUses,
): Promise<void> {
  await supabase.from("events").insert({
    type: "jev_judgment",
    level: "info",
    workspace_id: input.workspaceId,
    conversation_id: input.conversationId,
    payload: judgmentPayload(judged, mapped, stage, blockedCustomer, uses),
  });
}

function judgmentPayload(
  judged: JevCall,
  mapped: MappedJudgment,
  stage: StageWrite,
  blockedCustomer: boolean,
  uses: JevUses,
) {
  return {
    decision: mapped.decision,
    stage,
    blocked_customer: blockedCustomer,
    uses,
    rule: mapped.rule,
    action: judged.action,
    action_confidence: judged.actionConfidence,
    intent_score: judged.intentScore,
    auto_reply_probability: judged.autoReplyProbability,
    opt_out_probability: judged.optOutProbability,
    auto_reply: mapped.autoReply,
    model: judged.model,
    input_tokens: judged.inputTokens,
    output_tokens: judged.outputTokens,
    estimated_cost_usd: estimateCostUsd(judged.inputTokens),
    fallback: false,
    prompt_version: PROMPT_VERSION,
  };
}

async function moveToHandoff(conversationId: string): Promise<void> {
  try {
    await applyTransition(conversationId, "handoff_pending", { trigger: "jev" });
  } catch (error: unknown) {
    console.error(
      "[jev] handoff skipped:",
      error instanceof Error ? error.message : "unknown",
    );
  }
}

async function recordFallback(
  supabase: SupabaseClient,
  input: BatchInput,
  reason: string,
  latencyMs: number,
): Promise<void> {
  trackJudgment({
    model: MODEL,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs,
    success: false,
    fallbackUsed: true,
    error: reason,
  });
  const { error } = await supabase.from("events").insert({
    type: "jev_judgment",
    level: "warn",
    workspace_id: input.workspaceId,
    conversation_id: input.conversationId,
    payload: { fallback: true, reason },
  });
  if (error) console.error("[jev] fallback event failed:", error.message);
}
