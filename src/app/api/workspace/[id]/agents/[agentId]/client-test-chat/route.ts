import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createClient as svcClient } from "@supabase/supabase-js";
import {
  generateChatReply,
  getWorkspaceModel,
} from "@/features/inbox/services/openrouter";
import { resolveSystemPrompt } from "@/features/inbox/services/prompt-resolver";
import { buildSystemPrompt } from "@/features/inbox/services/prompt-builder";
import {
  searchKb,
  formatKbContext,
  listKbSourceLinks,
  formatKbReferenceLinks,
} from "@/features/inbox/services/kb-service";
import {
  getBusinessInfo,
  buildBusinessInfoContext,
  buildNowContext,
} from "@/features/inbox/services/business-info";
import { getEnabledTools } from "@/features/tools/services/tool-configs";
import type { AgentConfig } from "@/features/agents/types";

// POST /api/workspace/[id]/agents/[agentId]/client-test-chat
//
// The client-facing counterpart to .../agents/[agentId]/test-chat. Same
// generation pipeline, two deliberate differences:
//   1. Any ACTIVE member can call this (not just admin/manager) — this is
//      the one thing a "viewer"-role client account is allowed to do.
//   2. No draftPromptBody / modelOverride input — a client can only talk to
//      the agent's already-published prompt on its configured model, never
//      preview an unpublished draft or swap models.
// Nothing here returns prompt text, model name, or any other workspace
// config to the caller — only the assistant's reply.

const Schema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(8000),
      }),
    )
    .min(1)
    .max(20),
});

function svc() {
  return svcClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; agentId: string }> },
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const { id: workspaceId, agentId } = await params;

  // Any active membership qualifies — this route intentionally has no role
  // floor, since it's the only thing a low-privilege "client tester" account
  // is meant to reach.
  const { data: membership } = await supabase
    .from("memberships")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .eq("is_active", true)
    .maybeSingle();
  if (!membership) {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Datos inválidos" },
      { status: 400 },
    );
  }

  const db = svc();

  const { data: agent } = await db
    .from("agents")
    .select("id, workspace_id, type, name, model, is_active, config")
    .eq("id", agentId)
    .maybeSingle();
  if (!agent || agent.workspace_id !== workspaceId || !agent.is_active) {
    return NextResponse.json(
      { error: "Agente no encontrado" },
      { status: 404 },
    );
  }

  const model =
    (agent.model as string | null) ?? (await getWorkspaceModel(workspaceId));

  const resolved = await resolveSystemPrompt(workspaceId, {
    mode: agent.type as string,
  });
  const promptBody =
    resolved?.body ??
    "Eres un asistente de WhatsApp. Responde de forma concisa y útil en español.";
  const guardrails = resolved?.guardrails ?? null;

  const info = await getBusinessInfo(workspaceId);
  const businessName =
    ((info?.structured as { name?: string } | null)?.name as string) ??
    "tu negocio";
  const bizContext = buildBusinessInfoContext(info);
  const timeZone =
    ((info?.structured as { timezone?: string } | null)?.timezone as string) ??
    "America/Mexico_City";

  const lastUserMessage =
    [...parsed.data.messages].reverse().find((m) => m.role === "user")
      ?.content ?? "";
  const [kbResults, kbLinks] = await Promise.all([
    searchKb(workspaceId, lastUserMessage, 3),
    listKbSourceLinks(workspaceId),
  ]);
  const kbContext = [
    formatKbContext(kbResults),
    formatKbReferenceLinks(kbLinks),
  ]
    .filter(Boolean)
    .join("\n\n");

  const agentConfig = (agent.config ?? {}) as AgentConfig;
  const systemPrompt = buildSystemPrompt({
    nowContext: buildNowContext(timeZone),
    bizContext,
    promptBase: promptBody,
    kbContext,
    responseStyle: agentConfig.responseStyle ?? null,
    guardrails,
    vars: {
      agentName: agent.name as string,
      businessName,
      contactName: "",
    },
  });

  try {
    const tools = await getEnabledTools(workspaceId);
    const reply = await generateChatReply({
      model,
      systemPrompt,
      messages: parsed.data.messages,
      maxOutputTokens: 700,
      workspaceId,
      tools,
      toolContext: {
        workspaceId,
        conversationId: "",
        contactId: "",
      },
    });

    void db
      .from("events")
      .insert({
        workspace_id: workspaceId,
        type: "client_test_chat",
        payload: {
          agent_id: agentId,
          input_tokens: reply.promptTokens,
          output_tokens: reply.completionTokens,
        },
      })
      .then(
        () => undefined,
        () => undefined,
      );

    // Only the reply text leaves this handler — no model id, no prompt.
    return NextResponse.json({ text: reply.text });
  } catch (err) {
    console.error("[agents/client-test-chat]", err);
    return NextResponse.json(
      { error: "No se pudo generar la respuesta. Intenta de nuevo." },
      { status: 502 },
    );
  }
}
