import { NextRequest, NextResponse } from "next/server";
import { createClient as svcClient } from "@supabase/supabase-js";
import {
  readJsonBody,
  requireWorkspaceMember,
} from "@/lib/auth/workspace-access";
import { callJev, jevFailureCode, publicJevError } from "@/features/jev-judge/judge";
import { applyUses, readJevUses, type JevUses } from "@/features/jev-judge/uses";
import { trackJudgment } from "@/features/jev-judge/observe";
import { previewWithoutJev } from "@/features/jev-judge/preview";
import { checkBenchRateLimit } from "@/features/jev-judge/rate-limit";
import { BenchTextSchema, JudgeViewSchema } from "@/features/jev-judge/schema";

const MODEL = "jev-latest";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const auth = await requireWorkspaceMember(workspaceId, { minRole: "manager" });
  if (!auth.ok) return auth.response;

  const parsedBody = await readJsonBody(req);
  if (!parsedBody.ok) return parsedBody.response;
  const parsed = BenchTextSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Escribe un mensaje de hasta 2000 caracteres." },
      { status: 400 },
    );
  }

  const without = previewWithoutJev(parsed.data.text);
  const limit = checkBenchRateLimit(workspaceId);
  if (!limit.allowed) {
    return NextResponse.json(
      {
        without,
        with: null,
        error: `Demasiadas pruebas. Vuelve a comparar en ${limit.retryAfterSeconds} segundos.`,
      },
      { status: 429 },
    );
  }
  if (!process.env.TYPESAFE_API_KEY) {
    return NextResponse.json({
      without,
      with: null,
      error: publicJevError("missing_api_key"),
    });
  }

  const started = Date.now();
  try {
    const judged = await callJev(parsed.data.text);
    const mapped = applyUses(judged, await savedUses(workspaceId));
    const withJev = JudgeViewSchema.parse({
      model: judged.model,
      action: judged.action,
      actionConfidence: judged.actionConfidence,
      intentScore: judged.intentScore,
      autoReplyProbability: judged.autoReplyProbability,
      optOutProbability: judged.optOutProbability,
      decision: mapped.decision,
      stage: mapped.stage,
      autoReply: mapped.autoReply,
      rule: mapped.rule,
    });
    trackJudgment({
      model: judged.model,
      inputTokens: judged.inputTokens,
      outputTokens: judged.outputTokens,
      latencyMs: Date.now() - started,
      success: true,
      fallbackUsed: false,
    });
    return NextResponse.json({ without, with: withJev, error: null });
  } catch (error: unknown) {
    const code = jevFailureCode(error);
    trackJudgment({
      model: MODEL,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - started,
      success: false,
      fallbackUsed: true,
      error: code,
    });
    return NextResponse.json({
      without,
      with: null,
      error: publicJevError(code),
    });
  }
}

async function savedUses(workspaceId: string): Promise<JevUses> {
  const svc = svcClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { data } = await svc
    .from("integrations")
    .select("config")
    .eq("workspace_id", workspaceId)
    .eq("provider", "ycloud")
    .maybeSingle();
  return readJevUses(data?.config);
}
