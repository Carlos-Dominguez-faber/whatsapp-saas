// F3-T2: Manual handoff — request or cancel a handoff for a conversation.
//
// Security: the conversation is loaded with the
// caller's RLS client BEFORE anything runs with service role. A conversation
// the caller cannot see is a 404 — the same answer as "does not exist", so
// the endpoint cannot be used to probe other tenants' ids.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { readJsonBody } from "@/lib/auth/workspace-access";
import { applyTransition } from "@/features/inbox/services/decision-engine";

const bodySchema = z.object({
  action: z.enum(["request", "cancel"]),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // 1. Auth
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  // 2. Validate body
  const parsedBody = await readJsonBody(req);
  if (!parsedBody.ok) return parsedBody.response;
  const parsed = bodySchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "La acción debe ser 'request' o 'cancel'" },
      { status: 400 },
    );
  }

  const { id: conversationId } = await params;
  const { action } = parsed.data;

  // 3. Load the conversation through RLS — a non-member sees nothing.
  const { data: conv, error: convError } = await supabase
    .from("conversations")
    .select("workspace_id")
    .eq("id", conversationId)
    .single();

  if (convError || !conv) {
    return NextResponse.json(
      { error: "Conversación no encontrada" },
      { status: 404 },
    );
  }

  try {
    // 4. Determine target state
    // 'request' → handoff_pending (from ai_active or human_active)
    // 'cancel'  → ai_active (from handoff_pending)
    const to = action === "request" ? "handoff_pending" : "ai_active";

    await applyTransition(conversationId, to, {
      userId: user.id,
      trigger: "manual",
      workspaceId: conv.workspace_id as string,
    });

    // 5. Return updated state
    return NextResponse.json({ ok: true, state: to });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/conversations/[id]/handoff]:", message);

    // Surface transition validation errors as 422
    if (message.startsWith("Invalid transition:")) {
      return NextResponse.json(
        { error: "La conversación no admite ese cambio en su estado actual" },
        { status: 422 },
      );
    }

    return NextResponse.json(
      { error: "Error interno del servidor" },
      { status: 500 },
    );
  }
}
