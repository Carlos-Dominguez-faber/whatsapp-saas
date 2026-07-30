// F1-E1: Human agent sends a free-text message from the inbox composer.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";
import { dispatchText } from "@/features/inbox/services/dispatch";
import { applyTransition } from "@/features/inbox/services/decision-engine";
import { getActiveAgent } from "@/features/agents/services/active-agent";
import { readJsonBody } from "@/lib/auth/workspace-access";

const BodySchema = z.object({
  body: z.string().min(1).max(4096),
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

  // 2. Validate request body
  const parsed_body = await readJsonBody(req);
  if (!parsed_body.ok) return parsed_body.response;
  const parsed = BodySchema.safeParse(parsed_body.body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  // 3. Load conversation to get workspace_id
  const { data: conv } = await supabase
    .from("conversations")
    .select("workspace_id, window_expires_at, ai_enabled")
    .eq("id", conversationId)
    .single();

  if (!conv) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // 4. Dispatch via the single exit point
  const result = await dispatchText({
    workspaceId: conv.workspace_id,
    conversationId,
    body: parsed.data.body,
    senderUserId: user.id,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 422 });
  }

  // Sleep the bot when a human intervenes (configurable per agent, default on).
  // Transition ai_active → human_active so the AI stops replying this thread.
  if (conv.ai_enabled) {
    try {
      const activeAgent = await getActiveAgent(conv.workspace_id);
      const sleepOnManual = activeAgent?.config.sleepOnManualMessage !== false;
      if (sleepOnManual) {
        await applyTransition(conversationId, "human_active", {
          userId: user.id,
        });
      }
    } catch (e) {
      // Non-fatal: the message was already sent. Most likely the conversation
      // wasn't in a state that allows the transition (already human_active).
      console.warn(
        "[messages] sleep-on-manual skipped:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  return NextResponse.json({ ok: true, wamid: result.wamid });
}
