import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceMember } from "@/lib/auth/workspace-access";
import {
  getCalComConfig,
  calcomHeaders,
  CALCOM_BASE_URL,
  CALCOM_API_VERSION,
} from "@/features/inbox/services/calcom-client";

// POST /api/workspace/[id]/integrations/calcom/test
// Verifies the saved API key by listing event types.
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
      error: "Falta la API key de Cal.com",
    });
  }

  try {
    const res = await fetch(`${CALCOM_BASE_URL}/v2/event-types`, {
      headers: calcomHeaders(cfg.apiKey, CALCOM_API_VERSION.eventTypes),
    });

    if (!res.ok) {
      return NextResponse.json({
        ok: false,
        error: `Cal.com respondió ${res.status}. Revisa la API key.`,
      });
    }

    const data = (await res.json()) as {
      data?: { id: number; title: string }[];
    };
    const count = data.data?.length ?? 0;

    return NextResponse.json({
      ok: true,
      eventTypeCount: count,
    });
  } catch (err) {
    console.error(
      "[integrations/calcom/test] error:",
      err instanceof Error ? err.message : "unknown",
    );
    return NextResponse.json({
      ok: false,
      error: "No se pudo conectar con Cal.com",
    });
  }
}
