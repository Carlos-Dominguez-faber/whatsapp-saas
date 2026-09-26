import { NextRequest, NextResponse } from "next/server";
import { listHLPipelines } from "@/features/inbox/services/highlevel-client";
import { requireWorkspaceMember } from "@/lib/auth/workspace-access";

// GET /api/workspace/[id]/integrations/highlevel/pipelines
// Lists the workspace's HighLevel pipelines + stages so the integrations UI can
// populate the pipeline/stage selectors for the setter's create_hl_opportunity
// action. Requires a saved PIT + Location ID.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  // Reads the workspace's HighLevel integration with the service role: same
  // roles as the integrations SELECT policy (admin, manager).
  const auth = await requireWorkspaceMember(workspaceId, { minRole: "manager" });
  if (!auth.ok) return auth.response;

  const pipelines = await listHLPipelines(workspaceId);
  if (pipelines === null) {
    return NextResponse.json({
      ok: false,
      error:
        "No se pudieron cargar los pipelines. Revisa el PIT y el Location ID.",
    });
  }

  return NextResponse.json({ ok: true, pipelines });
}
