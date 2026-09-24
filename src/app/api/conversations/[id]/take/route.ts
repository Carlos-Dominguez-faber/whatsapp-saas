// F3-T2: Agent takes a conversation — handoff_pending → human_active.
//
// Authorization is deliberately NOT the conversations UPDATE policy: that
// policy only lets an agent update conversations already assigned to them,
// and taking is precisely how an agent gets a pending, unassigned
// conversation assigned. Instead it mirrors the operator set of the other
// write policies (admin/manager/agent): any active operator of the workspace
// may take a pending handoff. A viewer is read-only and may not.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireWorkspaceMember } from "@/lib/auth/workspace-access";
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

  // 2. Load through RLS — a non-member sees nothing (404).
  const { data: conv, error: convError } = await supabase
    .from("conversations")
    .select("state, workspace_id")
    .eq("id", conversationId)
    .single();

  if (convError || !conv) {
    return NextResponse.json(
      { error: "Conversación no encontrada" },
      { status: 404 },
    );
  }

  const workspaceId = conv.workspace_id as string;
  const auth = await requireWorkspaceMember(workspaceId, { minRole: "agent" });
  if (!auth.ok) return auth.response;

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
    await applyTransition(conversationId, "human_active", {
      userId: user.id,
      workspaceId,
    });

    return NextResponse.json({ ok: true, state: "human_active" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/conversations/[id]/take]:", message);

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
