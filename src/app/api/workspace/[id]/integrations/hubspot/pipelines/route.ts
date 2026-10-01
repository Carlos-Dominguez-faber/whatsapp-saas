import { NextRequest, NextResponse } from "next/server";
import { listHubSpotPipelines } from "@/features/inbox/services/hubspot-client";
import { requireWorkspaceMember } from "@/lib/auth/workspace-access";

// GET /api/workspace/[id]/integrations/hubspot/pipelines
// Pipelines de negocios + etapas para el selector de create_hubspot_deal. Manager, como el GET de
// integraciones: lee con el token del tenant.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const auth = await requireWorkspaceMember(workspaceId, { minRole: "manager" });
  if (!auth.ok) return auth.response;

  const pipelines = await listHubSpotPipelines(workspaceId);
  if (pipelines === null) {
    return NextResponse.json({
      ok: false,
      error: "No se pudieron cargar los pipelines. Revisa el token y prueba la conexión.",
    });
  }
  return NextResponse.json({ ok: true, pipelines });
}
