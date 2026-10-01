import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceMember } from "@/lib/auth/workspace-access";
import {
  getCalComConfig,
  listCalComEventTypes,
} from "@/features/inbox/services/calcom-client";

// POST /api/workspace/[id]/integrations/calcom/test
// Verifies the saved API key by listing its event types. Manager+, like
// reading the integrations: it uses the stored key and returns only a count.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const auth = await requireWorkspaceMember(workspaceId, {
    minRole: "manager",
  });
  if (!auth.ok) return auth.response;

  const cfg = await getCalComConfig(workspaceId);
  if (!cfg) {
    return NextResponse.json({
      ok: false,
      error: "Falta la API key de Cal.com, o la integración está desactivada.",
    });
  }

  const eventTypes = await listCalComEventTypes(cfg.apiKey);
  if (!eventTypes) {
    return NextResponse.json({
      ok: false,
      error: "Cal.com no respondió o rechazó la API key. Revísala.",
    });
  }
  return NextResponse.json({ ok: true, eventTypeCount: eventTypes.length });
}
