// F3-T2: Agent takes a conversation — handoff_pending → human_active.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { applyTransition } from "@/features/inbox/services/decision-engine";

export async function POST(
  _req: NextRequest,
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

  const { id: conversationId } = await params;

  // 2. Validate current state is handoff_pending
  const { data: conv, error: convError } = await supabase
    .from("conversations")
    .select("state")
    .eq("id", conversationId)
    .single();

  if (convError || !conv) {
    return NextResponse.json(
      { error: "Conversación no encontrada" },
      { status: 404 },
    );
  }

  if (conv.state !== "handoff_pending") {
    return NextResponse.json(
      {
        error: `Solo se puede tomar una conversación en estado handoff_pending. Estado actual: ${conv.state}`,
      },
      { status: 422 },
    );
  }

  try {
    // 3. Transition to human_active, assign to current user
    await applyTransition(conversationId, "human_active", { userId: user.id });

    return NextResponse.json({ ok: true, state: "human_active" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/conversations/[id]/take]:", message);

    if (message.startsWith("Invalid transition:")) {
      return NextResponse.json({ error: message }, { status: 422 });
    }

    return NextResponse.json(
      { error: "Error interno del servidor" },
      { status: 500 },
    );
  }
}
