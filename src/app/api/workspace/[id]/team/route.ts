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
// Role ceiling
//
// memberships' RLS reserves writes to admins, but these handlers write with the
// service role and let managers in, so the ceiling lives here: a manager runs
// day-to-day staffing (agents, viewers) but can neither grant manager/admin nor
// touch a manager's or admin's membership — otherwise a manager could promote
// themselves or deactivate the admins. An admin can do anything except leave
// the workspace without an active admin.
// ──────────────────────────────────────────────────────────────────────────────

type Role = z.infer<typeof RoleEnum>;

const RANK: Record<Role, number> = { viewer: 0, agent: 1, manager: 2, admin: 3 };

function withinCeiling(actor: Role, role: Role): boolean {
  return actor === "admin" || RANK[role] < RANK[actor];
}

const FORBIDDEN_ROLE = () =>
  NextResponse.json(
    { error: "No tienes permiso para asignar o modificar ese rol" },
    { status: 403 },
  );

const LAST_ADMIN = () =>
  NextResponse.json(
    { error: "El espacio de trabajo debe conservar al menos un admin activo" },
    { status: 409 },
  );

async function loadMembership(
  db: ReturnType<typeof svc>,
  workspaceId: string,
  userId: string,
): Promise<{ role: Role; is_active: boolean } | null> {
  const { data, error } = await db
    .from("memberships")
    .select("role, is_active")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`membership lookup failed: ${error.message}`);
  return (data as { role: Role; is_active: boolean } | null) ?? null;
}

/** True when `userId` is the only active admin and the change removes that. */
async function removesLastAdmin(
  db: ReturnType<typeof svc>,
  workspaceId: string,
  userId: string,
  current: { role: Role; is_active: boolean },
  next: { role: Role; is_active: boolean },
): Promise<boolean> {
  const wasAdmin = current.role === "admin" && current.is_active;
  const staysAdmin = next.role === "admin" && next.is_active;
  if (!wasAdmin || staysAdmin) return false;

  const { count, error } = await db
    .from("memberships")
    .select("user_id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("role", "admin")
    .eq("is_active", true)
    .neq("user_id", userId);
  if (error) throw new Error(`admin count failed: ${error.message}`);
  return (count ?? 0) === 0;
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
  if (!withinCeiling(auth.role, role)) return FORBIDDEN_ROLE();
  const db = svc();

  // Provision the account directly — no invite email / SMTP. The agency shares
  // the returned credentials and the user logs in directly.
  let provisioned;
  try {
    provisioned = await provisionWorkspaceUser(db, email, {
      password: password || undefined,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "No se pudo crear el usuario",
      },
      { status: 400 },
    );
  }

  // Re-inviting an existing member rewrites their role: same ceiling as PATCH.
  try {
    const existing = await loadMembership(db, workspaceId, provisioned.userId);
    if (existing) {
      if (!withinCeiling(auth.role, existing.role)) return FORBIDDEN_ROLE();
      if (
        await removesLastAdmin(db, workspaceId, provisioned.userId, existing, {
          role,
          is_active: true,
        })
      ) {
        return LAST_ADMIN();
      }
    }
  } catch (err) {
    console.error("[POST /api/workspace/[id]/team] ceiling check:", err);
    return NextResponse.json(
      { error: "No se pudo verificar el miembro. Intenta de nuevo." },
      { status: 500 },
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
    return NextResponse.json({ error: memberError.message }, { status: 500 });
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

  try {
    const current = await loadMembership(db, workspaceId, userId);
    if (!current) {
      return NextResponse.json({ error: "Miembro no encontrado" }, { status: 404 });
    }
    if (!withinCeiling(auth.role, current.role)) return FORBIDDEN_ROLE();
    if (role !== undefined && !withinCeiling(auth.role, role)) {
      return FORBIDDEN_ROLE();
    }
    const next = {
      role: role ?? current.role,
      is_active: is_active ?? current.is_active,
    };
    if (await removesLastAdmin(db, workspaceId, userId, current, next)) {
      return LAST_ADMIN();
    }
  } catch (err) {
    console.error("[PATCH /api/workspace/[id]/team] ceiling check:", err);
    return NextResponse.json(
      { error: "No se pudo verificar el miembro. Intenta de nuevo." },
      { status: 500 },
    );
  }

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

  try {
    const current = await loadMembership(db, workspaceId, userId);
    if (!current) {
      return NextResponse.json({ error: "Miembro no encontrado" }, { status: 404 });
    }
    if (!withinCeiling(auth.role, current.role)) return FORBIDDEN_ROLE();
    if (
      await removesLastAdmin(db, workspaceId, userId, current, {
        role: current.role,
        is_active: false,
      })
    ) {
      return LAST_ADMIN();
    }
  } catch (err) {
    console.error("[DELETE /api/workspace/[id]/team] ceiling check:", err);
    return NextResponse.json(
      { error: "No se pudo verificar el miembro. Intenta de nuevo." },
      { status: 500 },
    );
  }

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
