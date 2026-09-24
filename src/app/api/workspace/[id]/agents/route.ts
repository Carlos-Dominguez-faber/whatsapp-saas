import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createClient as svcClient } from "@supabase/supabase-js";
import { listAgents } from "@/features/agents/services/agent-queries";

// GET  /api/workspace/[id]/agents          → list the workspace's agents
// PATCH /api/workspace/[id]/agents         → update fields and/or set active
//
// Reads & field-updates go through the user-context client so RLS enforces
// membership (read) and admin/manager (write). Setting the active agent uses the
// service-role-only set_active_agent RPC (atomic, respects the partial unique
// index), gated by an explicit admin/manager check.

const AVATAR_KEY = z.string().min(1).max(40);
const MODEL = z.string().min(1).max(120).nullable();

const PatchSchema = z
  .object({
    agentId: z.string().uuid(),
    name: z.string().min(1).max(60).optional(),
    avatarKey: AVATAR_KEY.optional(),
    model: MODEL.optional(),
    type: z.enum(["setter", "soporte", "agendamiento"]).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    promptId: z.string().uuid().optional(),
    setActive: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.avatarKey !== undefined ||
      v.model !== undefined ||
      v.type !== undefined ||
      v.config !== undefined ||
      v.setActive === true,
    { message: "Nada que actualizar" },
  );

function svc() {
  return svcClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const { id: workspaceId } = await params;

  try {
    // RLS scopes this to workspaces the user belongs to.
    const agents = await listAgents(supabase, workspaceId);
    return NextResponse.json({ agents });
  } catch (err) {
    console.error(
      "[agents] list error:",
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json(
      { error: "No se pudieron cargar los agentes. Intenta de nuevo." },
      { status: 500 },
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const { id: workspaceId } = await params;
  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Datos inválidos" },
      { status: 400 },
    );
  }
  const { agentId, setActive, ...fields } = parsed.data;

  // Field updates: RLS enforces admin/manager + workspace membership.
  const updates: Record<string, unknown> = {};
  if (fields.name !== undefined) updates.name = fields.name;
  if (fields.avatarKey !== undefined) updates.avatar_key = fields.avatarKey;
  if (fields.model !== undefined) updates.model = fields.model;
  if (fields.type !== undefined) updates.type = fields.type;
  if (fields.config !== undefined) updates.config = fields.config;
  if (fields.promptId !== undefined) updates.prompt_id = fields.promptId;

  if (Object.keys(updates).length > 0) {
    const { error } = await supabase
      .from("agents")
      .update(updates)
      .eq("id", agentId)
      .eq("workspace_id", workspaceId);
    if (error) {
      console.error("[agents] deactivate error:", error.message);
      return NextResponse.json(
        { error: "No se pudo cambiar el agente activo. Intenta de nuevo." },
        { status: 500 },
      );
    }
  }

  if (setActive === true) {
    // Verify admin/manager before the service-role RPC.
    const { data: membership } = await supabase
      .from("memberships")
      .select("role")
      .eq("workspace_id", workspaceId)
      .eq("user_id", user.id)
      .eq("is_active", true)
      .maybeSingle();
    const role = (membership as { role?: string } | null)?.role;
    if (role !== "admin" && role !== "manager") {
      return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
    }
    const { error: rpcError } = await svc().rpc("set_active_agent", {
      p_workspace: workspaceId,
      p_agent: agentId,
    });
    if (rpcError) {
      console.error("[agents] set_active_agent error:", rpcError.message);
      return NextResponse.json(
        { error: "No se pudo cambiar el agente activo. Intenta de nuevo." },
        { status: 500 },
      );
    }
  }

  // Return the fresh row (with prompt body).
  try {
    const agents = await listAgents(supabase, workspaceId);
    const agent = agents.find((a) => a.id === agentId);
    if (!agent)
      return NextResponse.json({ error: "No encontrado" }, { status: 404 });
    return NextResponse.json({ agent });
  } catch (err) {
    console.error(
      "[agents] reload error:",
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json(
      { error: "Se guardaron los cambios, pero no se pudo recargar el agente." },
      { status: 500 },
    );
  }
}
