import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createClient as svcClient } from "@supabase/supabase-js";
import {
  generateChatReply,
  getWorkspaceModel,
} from "@/features/inbox/services/openrouter";
import { resolveSystemPrompt } from "@/features/inbox/services/prompt-resolver";
import {
  buildSystemPrompt,
  type PromptGuardrails,
} from "@/features/inbox/services/prompt-builder";
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
import { workspaceSchedulingTimeZone } from "@/features/inbox/services/scheduling-timezone";
import { getEnabledTools } from "@/features/tools/services/tool-configs";
import type { AgentConfig } from "@/features/agents/types";
import { isCatalogModel } from "@/features/agents/lib/model-catalog";
import { guardWorkspaceLlmCall } from "@/features/inbox/services/llm-call-guard";
import { recordWorkspaceLlmCall } from "@/features/inbox/services/cost-tracker";
import { enforceModelPolicy } from "@/features/inbox/services/model-policy";

// POST /api/workspace/[id]/agents/[agentId]/test-chat
// In-UI playground: replies with the agent's model + (draft or published) prompt
// WITHOUT sending WhatsApp or persisting a conversation. Token cost is logged to
// `events` (type='agent_test_chat'), never to recordLlmUsage; those rows count
// toward the workspace's daily budget and an hourly cap.

// The whole conversation the playground may send in one request.
const MAX_TOTAL_CHARS = 40_000;

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
  draftPromptBody: z.string().max(50_000).optional(),
  // Only the curated catalog: the playground spends the workspace's key.
  modelOverride: z
    .string()
    .refine((id) => isCatalogModel(id), "Modelo no permitido")
    .optional(),
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

  // Require admin/manager.
  const { data: membership } = await supabase
    .from("memberships")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .eq("is_active", true)
    .maybeSingle();
  const role = (membership as { role?: string } | null)?.role;
  if (role !== "admin" && role !== "manager") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Datos inválidos" },
      { status: 400 },
    );
  }

  const totalChars = parsed.data.messages.reduce(
    (sum, m) => sum + m.content.length,
    0,
  );
  if (totalChars > MAX_TOTAL_CHARS) {
    return NextResponse.json(
      { error: "La conversación de prueba es demasiado larga. Reiníciala." },
      { status: 400 },
    );
  }

  const db = svc();

  // Load the agent and defend against IDOR (workspace mismatch).
  const { data: agent } = await db
    .from("agents")
    .select("id, workspace_id, type, name, model, config")
    .eq("id", agentId)
    .maybeSingle();
  if (!agent || agent.workspace_id !== workspaceId) {
    return NextResponse.json(
      { error: "Agente no encontrado" },
      { status: 404 },
    );
  }

  // Resolve model + system prompt. The playground spends the workspace's key,
  // so an agent model outside the catalog is refused here (production turns
  // keep using it). The workspace default is validated when it is saved.
  const agentModel = agent.model as string | null;
  if (!parsed.data.modelOverride && agentModel && !isCatalogModel(agentModel)) {
    return NextResponse.json(
      {
        error: `El modelo de este agente (${agentModel}) ya no está en el catálogo. Elige uno del catálogo para probarlo.`,
      },
      { status: 400 },
    );
  }
  // The resolved model also goes through the runtime policy: on the platform
  // key a workspace default outside the catalog (a legacy config.model, or a
  // direct write) is swapped for the platform default.
  const model = await enforceModelPolicy(
    db,
    workspaceId,
    parsed.data.modelOverride ??
      agentModel ??
      (await getWorkspaceModel(workspaceId)),
    "agent_test_chat",
  );

  // Budget and hourly cap before anything that spends, KB embeddings included.
  const guard = await guardWorkspaceLlmCall(workspaceId, "agent_test_chat");
  if (!guard.ok) return guard.response;

  let promptBody = parsed.data.draftPromptBody;
  let guardrails: PromptGuardrails | null = null;
  if (!promptBody) {
    const resolved = await resolveSystemPrompt(workspaceId, {
      mode: agent.type as string,
    });
    promptBody =
      resolved?.body ??
      "Eres un asistente de WhatsApp. Responde de forma concisa y útil en español.";
    guardrails = resolved?.guardrails ?? null;
  }

  // Mirror production (buffer.ts) exactly via the shared builder: business info,
  // KB search, response style, variable substitution and strict guardrails.
  const info = await getBusinessInfo(workspaceId);
  const businessName =
    ((info?.structured as { name?: string } | null)?.name as string) ??
    "tu negocio";
  const bizContext = buildBusinessInfoContext(info);
  const timeZone = await workspaceSchedulingTimeZone(workspaceId, info);

  // KB: search with the latest user message, just like buffer.ts.
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
    // An admin tests with every tool the workspace has on, writes included
    // (booking — the playground has no contact to cancel or reschedule for —
    // and the n8n write workflows): they are the ones who turned them on. A
    // manager gets only the read-only ones (checking availability, an n8n
    // lookup): they must not book or fire the admin's write workflows from
    // here, with a draft prompt of their own. The role comes from the
    // membership read above, never from the request. The seed gives every
    // call of this request the same idempotency key base, and
    // generateChatReply doesn't retry a turn after a write.
    const enabled = await getEnabledTools(workspaceId);
    const tools = role === "admin" ? enabled : enabled.filter((t) => t.sensitivity === "read");
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
        batchId: `playground:${randomUUID()}`,
        // A write acts only on what the tester typed (schedule_highlevel's
        // phone), and leaves a trace with who ran it.
        playground: {
          userId: user.id,
          userMessages: parsed.data.messages
            .filter((m) => m.role === "user")
            .map((m) => m.content),
        },
      },
    });

    // Fills in the reserved row; its total_tokens counts toward the daily
    // budget. Never throws.
    await recordWorkspaceLlmCall({
      reservationId: guard.reservationId,
      workspaceId,
      type: "agent_test_chat",
      model,
      promptTokens: reply.promptTokens,
      completionTokens: reply.completionTokens,
      extra: { agent_id: agentId },
    });

    return NextResponse.json({
      text: reply.text,
      inputTokens: reply.promptTokens,
      outputTokens: reply.completionTokens,
      model,
      writeTools: role === "admin",
    });
  } catch (err) {
    console.error("[agents/test-chat]", err);
    // A turn that already ran a write (a booking, an n8n write) must not be
    // sent again blindly: it would run it again.
    if ((err as { wroteSomething?: unknown } | null)?.wroteSomething === true) {
      return NextResponse.json(
        {
          error:
            "La respuesta falló después de que se ejecutó una acción (por ejemplo, agendar). Revisa en el calendario o en n8n qué quedó hecho antes de reintentar.",
          wroteSomething: true,
        },
        { status: 502 },
      );
    }
    // Admin/manager playground — surface the real reason so it's diagnosable
    // (model id, rate limit, upstream 502…) instead of a generic message.
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `No se pudo generar la respuesta (${model}): ${detail}` },
      { status: 502 },
    );
  }
}
