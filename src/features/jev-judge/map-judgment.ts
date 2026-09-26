export type Decision = "respond" | "handoff" | "abstain";
export type StageWrite = "engaged" | "qualified" | "lost" | null;

export interface RawJudgment {
  action: Decision;
  actionConfidence: number;
  intentScore: number;
  autoReplyProbability: number;
  optOutProbability: number;
}

export interface MappedJudgment {
  decision: Decision;
  stage: StageWrite;
  autoReply: boolean;
  rule: string;
}

const NOUL_YES = 0.5;
const INTENT_READY = 1.5;
const INTENT_CURIOUS = 0.5;

export function mapJudgment(
  raw: RawJudgment,
  choiceCutoff: number | null,
): MappedJudgment {
  if (raw.optOutProbability > NOUL_YES) return optOut();
  if (belowCutoff(raw.actionConfidence, choiceCutoff)) return lowConfidence();
  if (raw.action !== "respond") return passThrough(raw.action);
  return mapRespond(raw);
}

/** A customer stage is never overwritten. Null means the CRM stays put. */
export function stageToPersist(
  mappedStage: StageWrite,
  currentStage: string | null | undefined,
): StageWrite {
  if (!mappedStage || currentStage === "customer") return null;
  return mappedStage;
}

function optOut(): MappedJudgment {
  return { decision: "abstain", stage: "lost", autoReply: false, rule: "opt-out" };
}

function lowConfidence(): MappedJudgment {
  return {
    decision: "abstain",
    stage: null,
    autoReply: false,
    rule: "confianza",
  };
}

function passThrough(action: "handoff" | "abstain"): MappedJudgment {
  return { decision: action, stage: null, autoReply: false, rule: action };
}

function mapRespond(raw: RawJudgment): MappedJudgment {
  const stage = stageForIntent(raw.intentScore);
  if (raw.autoReplyProbability <= NOUL_YES) {
    return { decision: "handoff", stage, autoReply: false, rule: "respond-sin-redactor" };
  }
  return {
    decision: "respond",
    stage,
    autoReply: true,
    rule: ruleForStage(stage),
  };
}

function ruleForStage(stage: StageWrite): string {
  if (stage === "qualified") return "respond-caliente";
  if (stage === "engaged") return "respond-curioso";
  return "respond-frio";
}

function stageForIntent(score: number): StageWrite {
  if (score >= INTENT_READY) return "qualified";
  if (score >= INTENT_CURIOUS) return "engaged";
  return null;
}

function belowCutoff(confidence: number, cutoff: number | null): boolean {
  return cutoff !== null && confidence < cutoff;
}
