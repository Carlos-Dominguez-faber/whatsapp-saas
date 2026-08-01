// G1: Templates CRUD API — list, create, update, delete workspace templates.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSbClient } from "@supabase/supabase-js";
import { listTemplates } from "@/features/inbox/services/templates";
import {
  templateButtonSchema,
  templateVariableSchema,
} from "@/features/settings/lib/template-form";

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

const NAME_REGEX = /^[a-z0-9_]+$/;

// Shared rich fields (header text-only, footer, buttons). Stored as a local
// draft; only built into Kapso `components` at submit time.
const RICH_FIELDS = {
  header_type: z.enum(["none", "text"]).default("none"),
  header_text: z.string().max(60).default(""),
  footer_text: z.string().max(60).default(""),
  buttons: z.array(templateButtonSchema).max(3).default([]),
  variables: z.array(templateVariableSchema).max(20).default([]),
};

const CreateSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(512)
    .regex(NAME_REGEX, "Solo minúsculas, números y guiones bajos"),
  language: z.literal("es").default("es"),
  category: z.enum(["marketing", "utility", "authentication"]),
  body_template: z.string().min(1).max(1024),
  components: z.record(z.string(), z.unknown()).default({}),
  ...RICH_FIELDS,
});

const UpdateSchema = z.object({
  id: z.string().uuid(),
  name: z
    .string()
    .min(1)
    .max(512)
    .regex(NAME_REGEX, "Solo minúsculas, números y guiones bajos")
    .optional(),
  language: z.literal("es").optional(),
  category: z.enum(["marketing", "utility", "authentication"]).optional(),
  body_template: z.string().min(1).max(1024).optional(),
  components: z.record(z.string(), z.unknown()).optional(),
  header_type: z.enum(["none", "text"]).optional(),
  header_text: z.string().max(60).optional(),
  footer_text: z.string().max(60).optional(),
  buttons: z.array(templateButtonSchema).max(3).optional(),
  variables: z.array(templateVariableSchema).max(20).optional(),
});

const DeleteSchema = z.object({
  id: z.string().uuid(),
});

// ── GET /api/workspace/[id]/templates ─────────────────────────────────────────

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

  try {
    const templates = await listTemplates(workspaceId);
    return NextResponse.json({ data: templates });
  } catch (err) {
    console.error("[GET /api/workspace/[id]/templates]:", err);
    return NextResponse.json(
      { error: "Error interno del servidor" },
      { status: 500 },
    );
  }
}

// ── POST /api/workspace/[id]/templates ────────────────────────────────────────

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

  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const db = svc();
  const { data, error } = await db
    .from("templates")
    .insert({
      workspace_id: workspaceId,
      ...parsed.data,
      status: "draft",
    })
    .select()
    .single();

  if (error) {
    console.error("[POST /api/workspace/[id]/templates]:", error);
    return NextResponse.json(
      { error: "Error al crear el template" },
      { status: 500 },
    );
  }

  return NextResponse.json({ data }, { status: 201 });
}

// ── PATCH /api/workspace/[id]/templates ───────────────────────────────────────

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

  const parsed = UpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { id, ...fields } = parsed.data;

  const db = svc();
  const { data, error } = await db
    .from("templates")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .select()
    .single();

  if (error) {
    console.error("[PATCH /api/workspace/[id]/templates]:", error);
    return NextResponse.json(
      { error: "Error al actualizar el template" },
      { status: 500 },
    );
  }

  return NextResponse.json({ data });
}

// ── DELETE /api/workspace/[id]/templates ──────────────────────────────────────

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
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const db = svc();

  // Guard: only draft or rejected templates can be deleted
  const { data: existing } = await db
    .from("templates")
    .select("status")
    .eq("id", parsed.data.id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (!existing) {
    return NextResponse.json(
      { error: "Template no encontrado" },
      { status: 404 },
    );
  }

  if (!["draft", "rejected"].includes(existing.status as string)) {
    return NextResponse.json(
      { error: "Solo se pueden eliminar templates en borrador o rechazados" },
      { status: 409 },
    );
  }

  const { error } = await db
    .from("templates")
    .delete()
    .eq("id", parsed.data.id)
    .eq("workspace_id", workspaceId);

  if (error) {
    console.error("[DELETE /api/workspace/[id]/templates]:", error);
    return NextResponse.json(
      { error: "Error al eliminar el template" },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true });
}
