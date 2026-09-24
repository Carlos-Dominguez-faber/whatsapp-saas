// Toggle the AI for one conversation.
//
// This used to write `ai_enabled` directly and left
// `state` untouched, breaking the invariant `ai_enabled === (state ===
// 'ai_active')` that decision-engine relies on — a conversation could end up
// "AI on" but silent (state human_active), or "AI off" but still replying.
// Every state change now goes through applyTransition(), the single choke
// point, so the invariant and the events log stay consistent.

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  readJsonBody,
  requireConversationUpdate,
} from "@/lib/auth/workspace-access";
import { applyTransition } from "@/features/inbox/services/decision-engine";

const toggleAiSchema = z.object({
  ai_enabled: z.boolean(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    // 1. Parse and validate body
    const parsedBody = await readJsonBody(request);
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = toggleAiSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "ai_enabled debe ser verdadero o falso" },
        { status: 400 },
      );
    }
    const { ai_enabled } = parsed.data;

    // 2. Verify authenticated user session
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "No autorizado" }, { status: 401 });
    }

    // 3. Load the conversation through RLS — a non-member sees nothing.
    const { id } = await params;
    const { data: conv, error: convError } = await supabase
      .from("conversations")
      .select("state, workspace_id, assigned_to")
      .eq("id", id)
      .single();

    if (convError || !conv) {
      return NextResponse.json(
        { error: "Conversación no encontrada" },
        { status: 404 },
      );
    }

    // 3b. applyTransition writes with the service role; enforce the
    // conversations UPDATE policy here instead.
    const auth = await requireConversationUpdate(
      conv as { workspace_id: string; assigned_to: string | null },
    );
    if (!auth.ok) return auth.response;

    const currentState = conv.state as string;
    const target = ai_enabled ? "ai_active" : "human_active";

    // 4. Idempotent: nothing to do if the AI is already where the caller wants it.
    if (currentState === target) {
      return NextResponse.json({ ok: true, ai_enabled, state: currentState });
    }

    if (currentState === "closed") {
      return NextResponse.json(
        { error: "La conversación está cerrada; no se puede cambiar la IA" },
        { status: 422 },
      );
    }

    // 5. Single choke point for state changes.
    await applyTransition(id, target, {
      userId: user.id,
      trigger: "manual",
      workspaceId: conv.workspace_id as string,
    });

    return NextResponse.json({ ok: true, ai_enabled, state: target });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[toggle-ai] error:", message);
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
