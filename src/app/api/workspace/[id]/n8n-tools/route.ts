// Dynamic n8n tools API — list and create per-workspace n8n workflow tools.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient as createSbClient } from "@supabase/supabase-js";
import {
  requireWorkspaceMember,
  readJsonBody,
} from "@/lib/auth/workspace-access";
import { registry } from "@/features/tools/index";
import { validateWebhookUrl } from "@/features/tools/services/ssrf-guard";
import { HTTPS_URL } from "@/features/tools/lib/tool-config";
import { N8nParameterSchema } from "@/features/tools/lib/n8n-tool-schema";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

const MAX_TOOLS_PER_WORKSPACE = 20;

const CreateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-zA-Z0-9_-]+$/, "Solo letras, números, guion y guion bajo"),
  description: z.string().trim().min(1).max(500),
  mode: z.enum(["sync", "async"]),
  sensitivity: z.enum(["read", "write"]),
  webhook_url: HTTPS_URL,
  auth_header_name: z
    .string()
    .trim()
    .max(100)
    .regex(/^[A-Za-z0-9-]+$/, "Solo letras, números y guion")
    .optional(),
  auth_header_value: z.string().max(2000).optional(),
  parameters: z.array(N8nParameterSchema).max(20).default([]),
  timeout_ms: z.number().int().min(1000).max(15000).default(8000),
});

// ── GET /api/workspace/[id]/n8n-tools ─────────────────────────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const auth = await requireWorkspaceMember(workspaceId, { minRole: "admin" });
  if (!auth.ok) return auth.response;

  const db = svc();
  const { data, error } = await db
    .from("n8n_tools")
    .select(
      "id, name, description, mode, sensitivity, webhook_url, auth_header_name, auth_header_value, parameters, timeout_ms, enabled, created_at, updated_at",
    )
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[GET /api/workspace/[id]/n8n-tools]:", error);
    return NextResponse.json(
      { error: "Error interno del servidor" },
      { status: 500 },
    );
  }

  // Never return the secret value — only whether one is set.
  const sanitized = (data ?? []).map((row) => {
    const { auth_header_value, ...rest } = row as { auth_header_value: string | null };
    return { ...rest, has_auth: Boolean(auth_header_value) };
  });

  return NextResponse.json({ data: sanitized });
}

// ── POST /api/workspace/[id]/n8n-tools ────────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const auth = await requireWorkspaceMember(workspaceId, { minRole: "admin" });
  if (!auth.ok) return auth.response;

  const parsedBody = await readJsonBody<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;

  const parsed = CreateSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  if (registry.list().some((t) => t.name === parsed.data.name)) {
    return NextResponse.json(
      { error: `El nombre "${parsed.data.name}" ya lo usa una herramienta del sistema` },
      { status: 400 },
    );
  }

  const { error: urlError } = await validateWebhookUrl(parsed.data.webhook_url);
  if (urlError) {
    return NextResponse.json({ error: urlError }, { status: 400 });
  }

  const db = svc();

  const { count } = await db
    .from("n8n_tools")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId);
  if ((count ?? 0) >= MAX_TOOLS_PER_WORKSPACE) {
    return NextResponse.json(
      { error: `Máximo ${MAX_TOOLS_PER_WORKSPACE} herramientas de n8n por workspace` },
      { status: 400 },
    );
  }

  const { data, error } = await db
    .from("n8n_tools")
    .insert({ workspace_id: workspaceId, ...parsed.data })
    .select(
      "id, name, description, mode, sensitivity, webhook_url, auth_header_name, parameters, timeout_ms, enabled, created_at, updated_at",
    )
    .single();

  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return NextResponse.json(
        { error: `Ya existe una herramienta llamada "${parsed.data.name}" en este workspace` },
        { status: 400 },
      );
    }
    console.error("[POST /api/workspace/[id]/n8n-tools]:", error);
    return NextResponse.json(
      { error: "Error al crear la herramienta" },
      { status: 500 },
    );
  }

  await db.from("events").insert({
    type: "n8n_tool_config_change",
    level: "info",
    workspace_id: workspaceId,
    payload: {
      action: "create",
      tool_id: data.id,
      name: data.name,
      mode: data.mode,
      changed_by: auth.userId,
    },
  });

  return NextResponse.json({ data: { ...data, has_auth: Boolean(parsed.data.auth_header_value) } }, { status: 201 });
}
