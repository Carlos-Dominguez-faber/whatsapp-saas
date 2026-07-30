// F3-T2: Manual handoff — request or cancel a handoff for a conversation.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
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
  const body = await req.json();
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { id: conversationId } = await params;
  const { action } = parsed.data;

  try {
    // 3. Determine target state
    // 'request' → handoff_pending (from ai_active or human_active)
    // 'cancel'  → ai_active (from handoff_pending)
    const to = action === "request" ? "handoff_pending" : "ai_active";

    await applyTransition(conversationId, to, {
      userId: user.id,
      trigger: "manual",
    });

    // 4. Return updated state
    return NextResponse.json({ ok: true, state: to });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/conversations/[id]/handoff]:", message);

    // Surface transition validation errors as 422
    if (message.startsWith("Invalid transition:")) {
      return NextResponse.json({ error: message }, { status: 422 });
    }

    return NextResponse.json(
      { error: "Error interno del servidor" },
      { status: 500 },
    );
  }
}
