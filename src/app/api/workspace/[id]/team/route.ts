import { NextRequest, NextResponse } from "next/server";
import { createClient as svcClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  requireWorkspaceMember,
  readJsonBody,
} from "@/lib/auth/workspace-access";
import { provisionWorkspaceUser } from "@/lib/auth/provision-user";

// ──────────────────────────────────────────────────────────────────────────────
// Schemas
// ──────────────────────────────────────────────────────────────────────────────

const RoleEnum = z.enum(["admin", "manager", "agent", "viewer"]);

const InviteSchema = z.object({
  email: z.string().email(),
  role: RoleEnum,
  password: z.string().min(8).max(72).optional().or(z.literal("")),
});

const PatchSchema = z.object({
  userId: z.string().uuid(),
  role: RoleEnum.optional(),
  is_active: z.boolean().optional(),
});

const DeleteSchema = z.object({
  userId: z.string().uuid(),
});

// ──────────────────────────────────────────────────────────────────────────────
// Auth + workspace guard (shared across handlers)
// ──────────────────────────────────────────────────────────────────────────────

function svc() {
  return svcClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/workspace/[id]/team
// Returns all memberships with user email, role, is_active, created_at
// ──────────────────────────────────────────────────────────────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const auth = await requireWorkspaceMember(workspaceId);
  if (!auth.ok) return auth.response;

  const db = svc();

  const { data, error } = await db
    .from("memberships")
    .select(
      `
      id,
      user_id,
      role,
      is_active,
      created_at,
      users ( full_name, email )
    `,
    )
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[GET /api/workspace/[id]/team] list error:", error.message);
    return NextResponse.json(
      { error: "No se pudo cargar el equipo. Intenta de nuevo." },
      { status: 500 },
    );
  }

  // Flatten nested users join into a flat member shape
  const members = (
    (data ?? []) as unknown as Array<{
      id: string;
      user_id: string;
      role: string;
      is_active: boolean;
      created_at: string;
      users: { full_name: string | null; email: string } | null;
    }>
  ).map((row) => ({
    id: row.id,
    user_id: row.user_id,
    email: row.users?.email ?? "",
    full_name: row.users?.full_name ?? null,
    role: row.role,
    is_active: row.is_active,
    created_at: row.created_at,
  }));

  return NextResponse.json({ members });
}

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/workspace/[id]/team
// Invite a user by email. Creates auth user (invite) + membership.
// ──────────────────────────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const auth = await requireWorkspaceMember(workspaceId, {
    minRole: "manager",
  });
  if (!auth.ok) return auth.response;

  const parsedBody = await readJsonBody(req);
  if (!parsedBody.ok) return parsedBody.response;

  const parsed = InviteSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  const { email, role, password } = parsed.data;
  const db = svc();

  // Provision the account directly — no invite email / SMTP. The agency shares
  // the returned credentials and the user logs in directly.
  let provisioned;
  try {
    provisioned = await provisionWorkspaceUser(db, email, {
      password: password || undefined,
    });
  } catch (err) {
    console.error(
      "[POST /api/workspace/[id]/team] provision error:",
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json(
      {
        error:
          "No se pudo crear el usuario. Revisa el correo y la contraseña e intenta de nuevo.",
      },
      { status: 400 },
    );
  }

  // Create membership (upsert — re-invite idempotent)
  const { error: memberError } = await db.from("memberships").upsert(
    {
      workspace_id: workspaceId,
      user_id: provisioned.userId,
      role,
      is_active: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id,user_id" },
  );

  if (memberError) {
    console.error(
      "[POST /api/workspace/[id]/team] membership error:",
      memberError.message,
    );
    return NextResponse.json(
      { error: "No se pudo agregar al usuario al equipo. Intenta de nuevo." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    credentials: provisioned.password
      ? { email, password: provisioned.password }
      : null,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// PATCH /api/workspace/[id]/team
// Update role and/or is_active for a membership
// ──────────────────────────────────────────────────────────────────────────────

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const auth = await requireWorkspaceMember(workspaceId, {
    minRole: "manager",
  });
  if (!auth.ok) return auth.response;

  const parsedBody = await readJsonBody(req);
  if (!parsedBody.ok) return parsedBody.response;

  const parsed = PatchSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  const { userId, role, is_active } = parsed.data;
  const db = svc();

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (role !== undefined) updates.role = role;
  if (is_active !== undefined) updates.is_active = is_active;

  const { error } = await db
    .from("memberships")
    .update(updates)
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId);

  if (error) {
    console.error("[PATCH /api/workspace/[id]/team] update error:", error.message);
    return NextResponse.json(
      { error: "No se pudo actualizar el miembro. Intenta de nuevo." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}

// ──────────────────────────────────────────────────────────────────────────────
// DELETE /api/workspace/[id]/team
// Soft-deactivate a member (set is_active = false, never hard-delete)
// ──────────────────────────────────────────────────────────────────────────────

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const auth = await requireWorkspaceMember(workspaceId, {
    minRole: "manager",
  });
  if (!auth.ok) return auth.response;

  const parsedBody = await readJsonBody(req);
  if (!parsedBody.ok) return parsedBody.response;

  const parsed = DeleteSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  const { userId } = parsed.data;
  const db = svc();

  const { error } = await db
    .from("memberships")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId);

  if (error) {
    console.error("[DELETE /api/workspace/[id]/team] remove error:", error.message);
    return NextResponse.json(
      { error: "No se pudo quitar al miembro. Intenta de nuevo." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
