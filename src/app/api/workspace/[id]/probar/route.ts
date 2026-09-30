import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireWorkspaceMember } from "@/lib/auth/workspace-access";
import { getActiveAgent } from "@/features/agents/services/active-agent";
import { runAgentPlayground } from "@/features/agents/services/agent-playground";

// POST /api/workspace/[id]/probar
//
// The /probar chat: any active member of the workspace — a viewer account
// handed to a client included — talks to the workspace's ACTIVE agent (the
// server picks it; the caller can't point at another one), with its published
// prompt and model and read-only tools only. Nothing goes out by WhatsApp and
// nothing is stored as a conversation. It spends the workspace's OpenRouter
// key, so every call is reserved against the daily budget and hourly caps
// per person and per workspace (guardClientTestChat), and the input is kept
// small. The answer carries only the text: no model, prompt or token counts.
//
// It isolates nothing else: the same account can open the inbox, the
// dashboard and the prompts (see INSTALAR.md).

const MAX_TOTAL_CHARS = 8_000;

const Schema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().min(1).max(1_000),
      }),
    )
    .min(1)
    .max(20),
});

const UNAVAILABLE = "El agente no está disponible para pruebas en este momento.";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const member = await requireWorkspaceMember(workspaceId, { minRole: "viewer" });
  if (!member.ok) return member.response;

  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Escribe un mensaje de hasta 1,000 caracteres." },
      { status: 400 },
    );
  }
  const totalChars = parsed.data.messages.reduce((sum, m) => sum + m.content.length, 0);
  if (totalChars > MAX_TOTAL_CHARS) {
    return NextResponse.json(
      { error: "La conversación de prueba es demasiado larga. Empieza una nueva." },
      { status: 400 },
    );
  }

  const agent = await getActiveAgent(workspaceId);
  if (!agent) {
    return NextResponse.json(
      { error: "Todavía no hay un agente activo para probar." },
      { status: 404 },
    );
  }

  const result = await runAgentPlayground({
    surface: "client_test_chat",
    workspaceId,
    agentId: agent.id,
    userId: member.userId,
    role: member.role,
    messages: parsed.data.messages,
    maxOutputTokens: 500,
  });

  if (result.ok) return NextResponse.json({ text: result.text });

  switch (result.reason) {
    case "refused":
      return result.response;
    case "agent_not_found":
      return NextResponse.json(
        { error: "Todavía no hay un agente activo para probar." },
        { status: 404 },
      );
    case "model_not_in_catalog":
      // An admin fixes this in Settings; the person testing only needs to know
      // it isn't available.
      console.warn(`[probar] workspace=${workspaceId} agent model ${result.model} is outside the catalog`);
      return NextResponse.json({ error: UNAVAILABLE }, { status: 503 });
    case "generation_failed":
      return NextResponse.json(
        { error: "No se pudo generar la respuesta. Intenta de nuevo." },
        { status: 502 },
      );
  }
}
