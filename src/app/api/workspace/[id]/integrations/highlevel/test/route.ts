import { NextRequest, NextResponse } from "next/server";
import {
  getHLConfig,
  saveHLLocationTimeZone,
} from "@/features/inbox/services/highlevel-client";
import { requireWorkspaceMember } from "@/lib/auth/workspace-access";

// POST /api/workspace/[id]/integrations/highlevel/test
// Verifies the saved PIT + Location ID by calling GET /locations/{id}.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  // Reads the workspace's HighLevel integration with the service role: same
  // roles as the integrations SELECT policy (admin, manager).
  const auth = await requireWorkspaceMember(workspaceId, { minRole: "manager" });
  if (!auth.ok) return auth.response;

  const cfg = await getHLConfig(workspaceId);
  if (!cfg) {
    return NextResponse.json({
      ok: false,
      error: "Falta el PIT o el Location ID",
    });
  }

  try {
    const res = await fetch(
      `https://services.leadconnectorhq.com/locations/${cfg.locationId}`,
      {
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          // GET /locations/{locationId}, HighLevel's OpenAPI spec.
          Version: "2021-07-28",
        },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!res.ok) {
      return NextResponse.json({
        ok: false,
        error: `HighLevel respondió ${res.status}. Revisa el PIT y el Location ID.`,
      });
    }

    const data = (await res.json()) as { location?: { name?: string; timezone?: unknown } };
    // The location's zone reads HighLevel's bare times (see scheduling-timezone.ts).
    const timezone = await saveHLLocationTimeZone(workspaceId, data.location ?? {});
    return NextResponse.json({
      ok: true,
      locationName: data.location?.name ?? null,
      hasCalendar: Boolean(cfg.calendarId),
      timezone,
    });
  } catch (err) {
    console.error(
      "[integrations/highlevel/test] error:",
      err instanceof Error ? err.message : "unknown",
    );
    return NextResponse.json({
      ok: false,
      error: "No se pudo conectar con HighLevel",
    });
  }
}
