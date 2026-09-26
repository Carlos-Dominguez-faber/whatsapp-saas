import { detectsHandoffTrigger } from "@/features/inbox/services/state-machine";

export interface WithoutJevPreview {
  decision: "respond" | "handoff";
  reason: "keyword" | "sin-keyword";
}

/** Message-only view of today's path. Does not read state or rate limits. */
export function previewWithoutJev(text: string): WithoutJevPreview {
  if (detectsHandoffTrigger(text)) {
    return { decision: "handoff", reason: "keyword" };
  }
  return { decision: "respond", reason: "sin-keyword" };
}

const RULE_COPY: Record<string, string> = {
  "opt-out": "No contesta. La etapa pasaría a lost.",
  confianza: "Confianza baja. No contesta y la etapa no se mueve.",
  handoff: "Pasa a una persona. La etapa no se mueve.",
  abstain: "No contesta. La etapa no se mueve.",
  "respond-sin-redactor": "No redacta solo. Pasa a una persona.",
  "respond-caliente": "Contesta el redactor. La etapa pasaría a qualified.",
  "respond-curioso": "Contesta el redactor. La etapa pasaría a engaged.",
  "respond-frio": "Contesta el redactor. La etapa no se mueve.",
  "respond-sin-etapa": "Contesta el redactor. La etapa no se mueve.",
  "etapa-caliente": "El redactor contesta. La etapa pasaría a qualified.",
  "etapa-curioso": "El redactor contesta. La etapa pasaría a engaged.",
  "etapa-perdido": "El redactor contesta. La etapa pasaría a lost.",
  "redactor-sigue": "El redactor contesta. La etapa no se mueve.",
};

export function ruleCopy(rule: string): string {
  return RULE_COPY[rule] ?? rule;
}
