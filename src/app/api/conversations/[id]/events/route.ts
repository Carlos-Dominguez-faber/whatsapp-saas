// F8-D2: GET /api/conversations/[id]/events
// Returns metrics + last 20 events for a conversation.
// Admins and managers of the conversation's workspace only — the same rule as
// the events SELECT policy, since the reads below use the service role.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireWorkspaceMember } from "@/lib/auth/workspace-access";
import {
  getConversationMetrics,
  getConversationEvents,
} from "@/features/inbox/services/observability";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    // 1. Auth
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "No autorizado" }, { status: 401 });
    }

    const { id: conversationId } = await params;

    // 2. Load through RLS — a non-member sees nothing (404). This also works
    //    for users in several workspaces, unlike picking a first membership.
    const { data: conversation, error: convError } = await supabase
      .from("conversations")
      .select("id, workspace_id")
      .eq("id", conversationId)
      .single();

    if (convError || !conversation) {
      return NextResponse.json(
        { error: "Conversación no encontrada" },
        { status: 404 },
      );
    }

    // 3. Events are for admins and managers (events_select policy).
    const auth = await requireWorkspaceMember(
      conversation.workspace_id as string,
      { minRole: "manager" },
    );
    if (!auth.ok) return auth.response;

    // 4. Fetch metrics and events
    const [metrics, events] = await Promise.all([
      getConversationMetrics(conversationId),
      getConversationEvents(conversationId, 20),
    ]);

    return NextResponse.json({ metrics, events });
  } catch (err) {
    console.error(
      "[GET /api/conversations/[id]/events]:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json(
      { error: "Error interno del servidor" },
      { status: 500 },
    );
  }
}
