// G5: Setter mode API — CRUD for setter_configs table.
//
// Autorización por requireWorkspaceMember: el authGuard inline que
// había no filtraba `is_active`. Leer: cualquier miembro activo. Crear/editar: manager o más.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient as createSvcClient } from "@supabase/supabase-js";
import { requireWorkspaceMember, readJsonBody } from "@/lib/auth/workspace-access";

const QuestionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(500),
  type: z.enum(["open", "yes_no", "multiple"]),
  weight: z.number().min(0).max(10),
});

const KnockoutRuleSchema = z.object({
  question_id: z.string().min(1),
  condition: z.string().min(1).max(200),
  action: z.enum(["disqualify", "continue", "handoff"]),
});

const ScoringSchema = z.object({
  threshold: z.number().min(0).max(100),
  max_score: z.number().min(1).max(100),
});

/**
 * Los tipos viven en tres lugares, a propósito sin tipo compartido: este schema, PostActionType en
 * setter-advanced-config.tsx y el switch de executeSetterPostAction en buffer.ts. Uno nuevo se
 * agrega en los tres.
 */
const PostActionSchema = z.object({
  type: z.enum(["send_template", "create_hl_opportunity", "create_hubspot_deal", "handoff", "add_tag"]),
  tag: z.string().max(100).optional(),
  template_name: z.string().max(200).optional(),
});

const CreateSchema = z.object({
  name: z.string().min(1).max(200),
  enabled: z.boolean().default(false),
  questions: z.array(QuestionSchema).default([]),
  knockout_rules: z.array(KnockoutRuleSchema).default([]),
  scoring: ScoringSchema.default({ threshold: 50, max_score: 100 }),
  post_action: PostActionSchema.default({ type: "handoff" }),
});

const PatchSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  questions: z.array(QuestionSchema).optional(),
  knockout_rules: z.array(KnockoutRuleSchema).optional(),
  scoring: ScoringSchema.optional(),
  post_action: PostActionSchema.optional(),
});

const SELECT_COLUMNS = "id, name, enabled, questions, knockout_rules, scoring, post_action";

function svc() {
  return createSvcClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

function internalError(route: string, error: unknown) {
  console.error(`[${route} /api/workspace/[id]/setter]:`, error);
  return NextResponse.json({ error: "Error interno del servidor" }, { status: 500 });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (!auth.ok) return auth.response;

  const { data, error } = await svc()
    .from("setter_configs")
    .select(SELECT_COLUMNS)
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return internalError("GET", error);
  return NextResponse.json({ data: data ?? null });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  const auth = await requireWorkspaceMember(workspaceId, { minRole: "manager" });
  if (!auth.ok) return auth.response;

  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = CreateSchema.safeParse(body.body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { data, error } = await svc()
    .from("setter_configs")
    .insert({ workspace_id: workspaceId, ...parsed.data })
    .select(SELECT_COLUMNS)
    .single();
  if (error || !data) return internalError("POST", error);
  return NextResponse.json({ data }, { status: 201 });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  const auth = await requireWorkspaceMember(workspaceId, { minRole: "manager" });
  if (!auth.ok) return auth.response;

  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = PatchSchema.safeParse(body.body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { id, ...updates } = parsed.data;
  const db = svc();
  const { data: existing, error: existingError } = await db
    .from("setter_configs")
    .select("id")
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (existingError) return internalError("PATCH pre-check", existingError);
  if (!existing) return NextResponse.json({ error: "Configuración no encontrada" }, { status: 404 });

  // El UPDATE también filtra por workspace: una escritura con service_role filtra el tenant ella misma.
  const { data, error } = await db
    .from("setter_configs")
    .update(updates)
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .select(SELECT_COLUMNS)
    .single();
  if (error || !data) return internalError("PATCH", error);
  return NextResponse.json({ data });
}
