// G1: AI template generation — uses OpenRouter to draft a WhatsApp template body.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { generateReply } from "@/features/inbox/services/openrouter";
import { TEMPLATE_CATEGORIES } from "@/features/settings/lib/template-form";

// ── Shared auth helper ────────────────────────────────────────────────────────

async function resolveMember(
  supabase: Awaited<ReturnType<typeof createClient>>,
  workspaceId: string,
  userId: string,
) {
  const { data } = await supabase
    .from("memberships")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  return data;
}

// ── Validation ────────────────────────────────────────────────────────────────

// `authentication` is still accepted by the schema only so we can answer with a
// clear reason: Meta requires those templates to come from Cloud API's template
// library (one-time-password button, no URLs/media/emojis), which this generator
// does not build — sending free text under that category is a guaranteed reject.
const GenerateSchema = z.object({
  description: z
    .string()
    .min(10, "La descripción debe tener al menos 10 caracteres")
    .max(500),
  category: z.enum([...TEMPLATE_CATEGORIES, "authentication"]),
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

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const member = await resolveMember(supabase, workspaceId, user.id);
  if (!member) {
    return NextResponse.json({ error: "Acceso denegado" }, { status: 403 });
  }

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

  if (category === "authentication") {
    return NextResponse.json(
      {
        error:
          "Las plantillas de autenticación (códigos de verificación) las tiene que crear WhatsApp desde su biblioteca oficial, no se pueden redactar con IA. Elige Utilidad o Marketing.",
      },
      { status: 400 },
    );
  }

  const userMessage = `Crea una plantilla de WhatsApp para: ${description}. Categoría: ${category}. Caso de uso: ${useCase}. Devuelve SOLO el texto de la plantilla, sin explicaciones.`;

  try {
    const result = await generateReply({
      systemPrompt: SYSTEM_PROMPT,
      userMessage,
      workspaceId,
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
