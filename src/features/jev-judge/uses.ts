import {
  mapJudgment,
  type MappedJudgment,
  type RawJudgment,
  type StageWrite,
} from "@/features/jev-judge/map-judgment";

export interface JevUses {
  stage: boolean;
  reply: boolean;
  optOut: boolean;
}

export interface JevEffect {
  suppressReply: boolean;
  ownsStage: boolean;
}

export const JEV_USES_ON: JevUses = { stage: true, reply: true, optOut: true };

/** Missing keys stay on, so a workspace that never picked a use keeps today's behavior. */
export function readJevUses(config: unknown): JevUses {
  const row = asRecord(config);
  return {
    stage: row.jev_stage !== false,
    reply: row.jev_reply !== false,
    optOut: row.jev_opt_out !== false,
  };
}

export function writeJevPatch(
  config: Record<string, unknown>,
  patch: { enabled?: boolean; stage?: boolean; reply?: boolean; optOut?: boolean },
): Record<string, unknown> {
  const next = { ...config };
  if (patch.enabled !== undefined) next.jev_enabled = patch.enabled;
  if (patch.stage !== undefined) next.jev_stage = patch.stage;
  if (patch.reply !== undefined) next.jev_reply = patch.reply;
  if (patch.optOut !== undefined) next.jev_opt_out = patch.optOut;
  return next;
}

/** With every use on, the result is the same mapping the class already demos. */
export function applyUses(
  raw: RawJudgment,
  uses: JevUses,
  choiceCutoff: number | null = null,
): MappedJudgment {
  const source = uses.optOut ? raw : { ...raw, optOutProbability: 0 };
  return gateUses(mapJudgment(source, choiceCutoff), uses);
}

export function jevEffect(mapped: MappedJudgment, uses: JevUses): JevEffect {
  return {
    suppressReply: mapped.decision !== "respond",
    ownsStage: uses.stage || mapped.rule === "opt-out",
  };
}

function gateUses(mapped: MappedJudgment, uses: JevUses): MappedJudgment {
  if (mapped.rule === "opt-out") return mapped;
  const stage = uses.stage ? mapped.stage : null;
  if (!uses.reply) return replyStays(stage);
  if (!uses.stage) return { ...mapped, stage: null, rule: stageOffRule(mapped) };
  return mapped;
}

function replyStays(stage: StageWrite): MappedJudgment {
  return {
    decision: "respond",
    stage,
    autoReply: true,
    rule: replyOffRule(stage),
  };
}

function stageOffRule(mapped: MappedJudgment): string {
  if (mapped.rule.startsWith("respond-") && mapped.rule !== "respond-sin-redactor") {
    return "respond-sin-etapa";
  }
  return mapped.rule;
}

function replyOffRule(stage: StageWrite): string {
  if (stage === "qualified") return "etapa-caliente";
  if (stage === "engaged") return "etapa-curioso";
  if (stage === "lost") return "etapa-perdido";
  return "redactor-sigue";
}

function asRecord(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== "object") return {};
  return config as Record<string, unknown>;
}
