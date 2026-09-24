import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  getAllWorkspacesWithStats,
  createWorkspaceForClient,
} from "@/features/agency/services/agency-actions";

async function assertSuperAdmin(): Promise<boolean> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;

  const { data } = await supabase
    .from("users")
    .select("is_super_admin")
    .eq("id", user.id)
    .single();

  return data?.is_super_admin === true;
}

// GET /api/agency/workspaces — list all workspaces with stats
export async function GET(_req: NextRequest) {
  const allowed = await assertSuperAdmin();
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const result = await getAllWorkspacesWithStats();
  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json({ workspaces: result.workspaces });
}

// POST /api/agency/workspaces — create workspace for client
export async function POST(req: NextRequest) {
  const allowed = await assertSuperAdmin();
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body: unknown = await req.json();
  const result = await createWorkspaceForClient(body);

  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  if (result.needsConfirmation) {
    return NextResponse.json(
      { needsConfirmation: true, existingUser: result.existingUser },
      { status: 409 },
    );
  }

  return NextResponse.json(
    { workspaceId: result.workspaceId, webhookUrl: result.webhookUrl },
    { status: 201 },
  );
}
