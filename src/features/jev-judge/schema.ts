import { z } from "zod";

export const PROMPT_VERSION = "v1.0.0";

export const DecisionSchema = z.enum(["respond", "handoff", "abstain"]);
export const StageSchema = z.enum(["engaged", "qualified", "lost"]).nullable();

export const JudgeViewSchema = z.object({
  model: z.string(),
  action: DecisionSchema,
  actionConfidence: z.number().min(0).max(1),
  intentScore: z.number().min(0).max(2),
  autoReplyProbability: z.number().min(0).max(1),
  optOutProbability: z.number().min(0).max(1),
  decision: DecisionSchema,
  stage: StageSchema,
  autoReply: z.boolean(),
  rule: z.string(),
});

export type JudgeView = z.infer<typeof JudgeViewSchema>;

export const BenchTextSchema = z.object({
  text: z.string().trim().min(1).max(2000),
});

export const JevPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    stage: z.boolean().optional(),
    reply: z.boolean().optional(),
    optOut: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: "Nada que guardar",
  });
