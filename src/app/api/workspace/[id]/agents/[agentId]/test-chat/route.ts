import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { isCatalogModel } from "@/features/agents/lib/model-catalog";
import { runAgentPlayground } from "@/features/agents/services/agent-playground";

// POST /api/workspace/[id]/agents/[agentId]/test-chat
// In-UI playground: replies with the agent's model + (draft or published) prompt
// WITHOUT sending WhatsApp or persisting a conversation. Token cost is logged to
// `events` (type='agent_test_chat'), never to recordLlmUsage; those rows count
// toward the workspace's daily budget and an hourly cap. The pipeline is
// runAgentPlayground(), shared with /probar.

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

  const result = await runAgentPlayground({
    surface: "agent_test_chat",
    workspaceId,
    agentId,
    userId: user.id,
    role,
    messages: parsed.data.messages,
    draftPromptBody: parsed.data.draftPromptBody,
    modelOverride: parsed.data.modelOverride,
    maxOutputTokens: 700,
  });

  if (result.ok) {
    return NextResponse.json({
      text: result.text,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      model: result.model,
      writeTools: result.writeTools,
    });
  }

  switch (result.reason) {
    case "agent_not_found":
      return NextResponse.json(
        { error: "Agente no encontrado" },
        { status: 404 },
      );
    case "model_not_in_catalog":
      return NextResponse.json(
        {
          error: `El modelo de este agente (${result.model}) ya no está en el catálogo. Elige uno del catálogo para probarlo.`,
        },
        { status: 400 },
      );
    case "refused":
      return result.response;
    case "generation_failed":
      // A turn that already ran a write (a booking, an n8n write) must not be
      // sent again blindly: it would run it again.
      if (result.wroteSomething) {
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
      return NextResponse.json(
        { error: `No se pudo generar la respuesta (${result.model}): ${result.detail}` },
        { status: 502 },
      );
  }
}
