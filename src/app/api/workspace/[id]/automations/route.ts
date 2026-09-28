// G3: Automation Rules API — list, create, update, delete workspace automation rules.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSbClient } from "@supabase/supabase-js";
import {
  AutomationRuleInputSchema,
  AutomationRuleUpdateSchema,
  firstErrorMessage,
} from "@/features/automations/lib/rule-schema";
import {
  assertActiveRuleCap,
  RuleCapError,
} from "@/features/automations/services/rule-cap";

// ── Service-role client ───────────────────────────────────────────────────────

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

// ── Shared auth helper ────────────────────────────────────────────────────────

async function resolveMember(
  supabase: Awaited<ReturnType<typeof createClient>>,
  workspaceId: string,
  userId: string,
) {
  const { data } = await supabase
    .from("memberships")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  return data;
}

// ── Validation schemas ────────────────────────────────────────────────────────

const DeleteSchema = z.object({
  id: z.string().uuid(),
});

// ── GET /api/workspace/[id]/automations ───────────────────────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const member = await resolveMember(supabase, workspaceId, user.id);
  if (!member) {
    return NextResponse.json({ error: "Acceso denegado" }, { status: 403 });
  }

  const db = svc();
  const { data, error } = await db
    .from("automation_rules")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[GET /api/workspace/[id]/automations]:", error);
    return NextResponse.json(
      { error: "Error interno del servidor" },
      { status: 500 },
    );
  }

  return NextResponse.json({ data: data ?? [] });
}

// ── POST /api/workspace/[id]/automations ──────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const member = await resolveMember(supabase, workspaceId, user.id);
  if (!member) {
    return NextResponse.json({ error: "Acceso denegado" }, { status: 403 });
  }

  if (!["admin", "manager"].includes(member.role as string)) {
    return NextResponse.json(
      { error: "Se requiere rol admin o manager" },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido" }, { status: 400 });
  }

  const parsed = AutomationRuleInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: firstErrorMessage(parsed.error) },
      { status: 400 },
    );
  }

  // El schema compartido trae `id` opcional (lo usa el update); en un POST la
  // clave la genera la base, así que no se propaga lo que mande el cliente.
  const { id: _ignoredId, ...fields } = parsed.data;

  const db = svc();

  // Tope de reglas activas. Solo cuenta si la regla nueva nace
  // habilitada: crear una deshabilitada nunca puede pasarse del tope.
  if (parsed.data.enabled) {
    try {
      await assertActiveRuleCap(db, workspaceId);
    } catch (err) {
      if (err instanceof RuleCapError) {
        return NextResponse.json({ error: err.message }, { status: 422 });
      }
      // Conteo caído: fail-closed. El detalle ya se logueó en el helper.
      return NextResponse.json(
        { error: "Error interno del servidor" },
        { status: 500 },
      );
    }
  }

  const { data, error } = await db
    .from("automation_rules")
    .insert({ workspace_id: workspaceId, ...fields })
    .select()
    .single();

  if (error) {
    console.error("[POST /api/workspace/[id]/automations]:", error);
    return NextResponse.json(
      { error: "Error al crear la automatización" },
      { status: 500 },
    );
  }

  return NextResponse.json({ data }, { status: 201 });
}

// ── PATCH /api/workspace/[id]/automations ─────────────────────────────────────

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const member = await resolveMember(supabase, workspaceId, user.id);
  if (!member) {
    return NextResponse.json({ error: "Acceso denegado" }, { status: 403 });
  }

  if (!["admin", "manager"].includes(member.role as string)) {
    return NextResponse.json(
      { error: "Se requiere rol admin o manager" },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido" }, { status: 400 });
  }

  const parsed = AutomationRuleUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: firstErrorMessage(parsed.error) },
      { status: 400 },
    );
  }

  const { id, ...fields } = parsed.data;

  const db = svc();

  // Tope de reglas activas. Solo se comprueba cuando este PATCH deja
  // la regla habilitada. AutomationRuleUpdateSchema exige el registro completo
  // y `enabled` tiene default `true` (BaseFields en rule-schema.ts), así que un
  // body sin `enabled` explícito igual llega aquí como `true` — un rename no se
  // distingue de una reactivación a nivel de schema. `excludeRuleId` es lo que
  // evita que la regla se rechace a sí misma cuando ya estaba activa.
  // `fields.enabled` solo es `false` cuando el body lo trae explícito, y ahí sí
  // se salta el conteo: deshabilitar nunca puede pasarse del tope.
  if (fields.enabled === true) {
    try {
      await assertActiveRuleCap(db, workspaceId, { excludeRuleId: id });
    } catch (err) {
      if (err instanceof RuleCapError) {
        return NextResponse.json({ error: err.message }, { status: 422 });
      }
      return NextResponse.json(
        { error: "Error interno del servidor" },
        { status: 500 },
      );
    }
  }

  const { data, error } = await db
    .from("automation_rules")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .select()
    .single();

  if (error) {
    console.error("[PATCH /api/workspace/[id]/automations]:", error);
    return NextResponse.json(
      { error: "Error al actualizar la automatización" },
      { status: 500 },
    );
  }

  return NextResponse.json({ data });
}

// ── DELETE /api/workspace/[id]/automations ────────────────────────────────────

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const member = await resolveMember(supabase, workspaceId, user.id);
  if (!member) {
    return NextResponse.json({ error: "Acceso denegado" }, { status: 403 });
  }

  if (!["admin", "manager"].includes(member.role as string)) {
    return NextResponse.json(
      { error: "Se requiere rol admin o manager" },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido" }, { status: 400 });
  }

  const parsed = DeleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: firstErrorMessage(parsed.error) },
      { status: 400 },
    );
  }

  const db = svc();
  const { error } = await db
    .from("automation_rules")
    .delete()
    .eq("id", parsed.data.id)
    .eq("workspace_id", workspaceId);

  if (error) {
    console.error("[DELETE /api/workspace/[id]/automations]:", error);
    return NextResponse.json(
      { error: "Error al eliminar la automatización" },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true });
}
