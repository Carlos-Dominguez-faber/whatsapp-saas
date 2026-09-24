// F7: Prompts API — list prompts, create versions, publish versions.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  listPrompts,
  createPromptVersion,
  publishPromptVersion,
  upsertGlobalPrompt,
} from "@/features/inbox/services/prompt-resolver";

const ALLOWED_SCOPES = [
  "global",
  "number",
  "campaign",
  "segment",
  "mode",
] as const;

const GuardrailsSchema = z
  .object({
    rules: z.array(z.string().max(500)).max(50).optional(),
    restrictions: z.array(z.string().max(500)).max(50).optional(),
  })
  .optional();

const CreateVersionSchema = z.object({
  promptName: z.string().min(1).max(200),
  scope: z.enum(ALLOWED_SCOPES),
  scopeRef: z.string().max(200).optional(),
  body: z.string().min(1).max(50_000),
  variables: z.array(z.unknown()).optional(),
  guardrails: GuardrailsSchema,
});

const PublishVersionSchema = z.object({
  promptId: z.string().uuid(),
  versionId: z.string().uuid(),
});

// ── Shared auth + membership helper ──────────────────────────────────────────

async function resolveWorkspaceMember(
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

// ── GET /api/workspace/[id]/prompts ──────────────────────────────────────────
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

  const member = await resolveWorkspaceMember(supabase, workspaceId, user.id);
  if (!member) {
    return NextResponse.json({ error: "Acceso denegado" }, { status: 403 });
  }

  try {
    const prompts = await listPrompts(workspaceId);
    return NextResponse.json({ data: prompts });
  } catch (err) {
    console.error("[GET /api/workspace/[id]/prompts]:", err);
    return NextResponse.json(
      { error: "Error interno del servidor" },
      { status: 500 },
    );
  }
}

// ── POST /api/workspace/[id]/prompts ─────────────────────────────────────────
// Creates a new prompt version (draft). Upserts the parent prompt if needed.
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

  const member = await resolveWorkspaceMember(supabase, workspaceId, user.id);
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

  const parsed = CreateVersionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const {
      promptName,
      scope,
      scopeRef,
      body: versionBody,
      variables,
      guardrails,
    } = parsed.data;

    // Resolve or create the parent prompt
    let promptId: string;

    if (scope === "global") {
      promptId = await upsertGlobalPrompt(workspaceId, promptName);
    } else {
      // Upsert a scoped prompt via service-role client
      const { createClient: createSbClient } =
        await import("@supabase/supabase-js");
      const svc = createSbClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
      );

      const { data: promptData, error: promptError } = await svc
        .from("prompts")
        .upsert(
          {
            workspace_id: workspaceId,
            scope,
            scope_ref: scopeRef ?? null,
            name: promptName,
          },
          { onConflict: "workspace_id,scope,scope_ref" },
        )
        .select("id")
        .single();

      if (promptError || !promptData) {
        throw new Error(`Failed to upsert prompt: ${promptError?.message}`);
      }

      promptId = promptData.id as string;
    }

    const versionId = await createPromptVersion(
      workspaceId,
      promptId,
      versionBody,
      variables,
      guardrails ?? null,
    );

    return NextResponse.json(
      { data: { promptId, versionId } },
      { status: 201 },
    );
  } catch (err) {
    console.error("[POST /api/workspace/[id]/prompts]:", err);
    return NextResponse.json(
      { error: "Error interno del servidor" },
      { status: 500 },
    );
  }
}

// ── PATCH /api/workspace/[id]/prompts ────────────────────────────────────────
// Publishes a specific prompt version.
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

  const member = await resolveWorkspaceMember(supabase, workspaceId, user.id);
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

  const parsed = PublishVersionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const published = await publishPromptVersion(
      workspaceId,
      parsed.data.promptId,
      parsed.data.versionId,
    );
    if (!published) {
      return NextResponse.json(
        { error: "No se encontró el prompt o la versión indicada" },
        { status: 404 },
      );
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[PATCH /api/workspace/[id]/prompts]:", err);
    return NextResponse.json(
      { error: "Error interno del servidor" },
      { status: 500 },
    );
  }
}
