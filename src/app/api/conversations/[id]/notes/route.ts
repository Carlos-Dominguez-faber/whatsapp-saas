// Internal notes — stored as messages but never dispatched to Kapso.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";
import { readJsonBody } from "@/lib/auth/workspace-access";

const BodySchema = z.object({
  content: z.string().min(1).max(4096),
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
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: conversationId } = await params;

  // 2. Validate body
  const parsed_body = await readJsonBody(req);
  if (!parsed_body.ok) return parsed_body.response;
  const parsed = BodySchema.safeParse(parsed_body.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 },
    );
  }

  // 3. Load conversation to get workspace_id + verify existence
  const { data: conv } = await supabase
    .from("conversations")
    .select("workspace_id")
    .eq("id", conversationId)
    .single();

  if (!conv) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // 4. Insert internal note as a system message — NOT dispatched to Kapso
  const { error: insertError } = await supabase.from("messages").insert({
    workspace_id: conv.workspace_id,
    conversation_id: conversationId,
    direction: "out",
    type: "system",
    body: parsed.data.content,
    status: "sent",
    sender_user_id: user.id,
    meta: {
      internal: true,
      sender_email: user.email ?? null,
    },
  });

  if (insertError) {
    console.error("[POST /api/conversations/[id]/notes]:", insertError.message);
    return NextResponse.json(
      { error: "Error al guardar la nota" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
