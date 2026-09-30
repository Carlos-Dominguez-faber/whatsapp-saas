import { NextRequest, NextResponse } from "next/server";
import { createClient as createSbClient } from "@supabase/supabase-js";
import { requireWorkspaceMember } from "@/lib/auth/workspace-access";
import {
  listAutomationRuns,
  parseCursor,
  parseRunFilter,
} from "@/features/automations/services/run-list";

// GET /api/workspace/[id]/automations/runs?status=all|failed|skipped|done|pending&before=<iso>&beforeId=<uuid>
// The Automations tab's runs panel, read-only, for admins and managers: who
// got what, and why a run was skipped or failed. 50 per page, newest first.

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const member = await requireWorkspaceMember(workspaceId, { minRole: "manager" });
  if (!member.ok) return member.response;

  const db = createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const url = req.nextUrl;
  try {
    const page = await listAutomationRuns(db, workspaceId, {
      filter: parseRunFilter(url.searchParams.get("status")),
      before: parseCursor(url.searchParams.get("before"), url.searchParams.get("beforeId")),
    });
    return NextResponse.json(page);
  } catch (err) {
    console.error("[automations/runs]", err instanceof Error ? err.message : String(err));
    return NextResponse.json(
      { error: "No se pudieron cargar las ejecuciones." },
      { status: 500 },
    );
  }
}
