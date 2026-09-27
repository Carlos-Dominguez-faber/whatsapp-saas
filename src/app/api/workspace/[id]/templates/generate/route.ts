// G1: AI template generation — uses OpenRouter to draft a WhatsApp template body.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireWorkspaceMember } from "@/lib/auth/workspace-access";
import { generateReply } from "@/features/inbox/services/openrouter";
import { guardWorkspaceLlmCall } from "@/features/inbox/services/llm-call-guard";
import { recordWorkspaceLlmCall } from "@/features/inbox/services/cost-tracker";

// Drafts are created by whoever manages templates; the model the route uses
// is the env default (generateReply without a model).
const DRAFT_MODEL =
  process.env.OPENROUTER_DEFAULT_MODEL ?? "openai/gpt-4o-mini";

// ── Validation ────────────────────────────────────────────────────────────────

const GenerateSchema = z.object({
  description: z
    .string()
    .min(10, "La descripción debe tener al menos 10 caracteres")
    .max(500),
  category: z.enum(["marketing", "utility", "authentication"]),
  useCase: z.string().min(1).max(100),
});

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Eres un experto en plantillas de WhatsApp Business. Genera plantillas que cumplan las políticas de Meta. No uses emojis excesivos. Las variables se formatean como {{1}}, {{2}}.

Reglas estrictas:
- El texto debe ser claro, profesional y directo.
- Para categoría "marketing": incluir footer de opt-out sugerido al final entre paréntesis.
- Máximo 1024 caracteres en el cuerpo.
- Las variables deben estar numeradas en orden: {{1}}, {{2}}, etc.
- No incluyas explicaciones, solo el texto de la plantilla.
- El texto DEBE estar en español.`;

// ── POST /api/workspace/[id]/templates/generate ───────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  // Each draft spends the workspace's OpenRouter key: managers and admins only.
  const auth = await requireWorkspaceMember(workspaceId, { minRole: "manager" });
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido" }, { status: 400 });
  }

  const parsed = GenerateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { description, category, useCase } = parsed.data;

  // Meta only takes authentication templates from its own library (a one-time
  // password button, no free text), so drafting one would be rejected anyway.
  if (category === "authentication") {
    return NextResponse.json(
      {
        error:
          "Las plantillas de autenticación (códigos de verificación) las tiene que crear WhatsApp desde su biblioteca oficial; no se pueden redactar con IA. Elige Utilidad o Marketing.",
      },
      { status: 400 },
    );
  }

  const userMessage = `Crea una plantilla de WhatsApp para: ${description}. Categoría: ${category}. Caso de uso: ${useCase}. Devuelve SOLO el texto de la plantilla, sin explicaciones.`;

  const guard = await guardWorkspaceLlmCall(workspaceId, "template_generate");
  if (!guard.ok) return guard.response;

  try {
    const result = await generateReply({
      systemPrompt: SYSTEM_PROMPT,
      userMessage,
      workspaceId,
    });

    await recordWorkspaceLlmCall({
      reservationId: guard.reservationId,
      workspaceId,
      type: "template_generate",
      model: DRAFT_MODEL,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      extra: { user_id: auth.userId },
    });

    return NextResponse.json({ body: result.text.trim() });
  } catch (err) {
    console.error("[POST /api/workspace/[id]/templates/generate]:", err);
    return NextResponse.json(
      { error: "El modelo no pudo generar la plantilla. Intenta de nuevo." },
      { status: 500 },
    );
  }
}
