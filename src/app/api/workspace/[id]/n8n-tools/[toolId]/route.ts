// Dynamic n8n tools API — update and delete a single per-workspace tool.

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

const UpdateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-zA-Z0-9_-]+$/, "Solo letras, números, guion y guion bajo")
    .optional(),
  description: z.string().trim().min(1).max(500).optional(),
  mode: z.enum(["sync", "async"]).optional(),
  sensitivity: z.enum(["read", "write"]).optional(),
  webhook_url: HTTPS_URL.optional(),
  auth_header_name: z
    .string()
    .trim()
    .max(100)
    .regex(/^[A-Za-z0-9-]+$/, "Solo letras, números y guion")
    .nullable()
    .optional(),
  auth_header_value: z.string().max(2000).nullable().optional(),
  parameters: z.array(N8nParameterSchema).max(20).optional(),
  timeout_ms: z.number().int().min(1000).max(15000).optional(),
  enabled: z.boolean().optional(),
});

// ── PATCH /api/workspace/[id]/n8n-tools/[toolId] ──────────────────────────────

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; toolId: string }> },
) {
  const { id: workspaceId, toolId } = await params;

  const auth = await requireWorkspaceMember(workspaceId, { minRole: "admin" });
  if (!auth.ok) return auth.response;

  const parsedBody = await readJsonBody<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;

  const parsed = UpdateSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  if (
    parsed.data.name &&
    registry.list().some((t) => t.name === parsed.data.name)
  ) {
    return NextResponse.json(
      { error: `El nombre "${parsed.data.name}" ya lo usa una herramienta del sistema` },
      { status: 400 },
    );
  }

  if (parsed.data.webhook_url) {
    const { error: urlError } = await validateWebhookUrl(parsed.data.webhook_url);
    if (urlError) {
      return NextResponse.json({ error: urlError }, { status: 400 });
    }
  }

  const db = svc();
  const { data, error } = await db
    .from("n8n_tools")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", toolId)
    .eq("workspace_id", workspaceId)
    .select(
      "id, name, description, mode, sensitivity, webhook_url, auth_header_name, auth_header_value, parameters, timeout_ms, enabled, created_at, updated_at",
    )
    .maybeSingle();

  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return NextResponse.json(
        { error: `Ya existe una herramienta con ese nombre en este workspace` },
        { status: 400 },
      );
    }
    console.error("[PATCH /api/workspace/[id]/n8n-tools/[toolId]]:", error);
    return NextResponse.json(
      { error: "Error al actualizar la herramienta" },
      { status: 500 },
    );
  }

  if (!data) {
    return NextResponse.json(
      { error: "Herramienta no encontrada" },
      { status: 404 },
    );
  }

  await db.from("events").insert({
    type: "n8n_tool_config_change",
    level: "info",
    workspace_id: workspaceId,
    payload: {
      action: "update",
      tool_id: data.id,
      name: data.name,
      mode: data.mode,
      changed_by: auth.userId,
    },
  });

  const { auth_header_value, ...rest } = data as { auth_header_value: string | null };
  return NextResponse.json({ data: { ...rest, has_auth: Boolean(auth_header_value) } });
}

// ── DELETE /api/workspace/[id]/n8n-tools/[toolId] ─────────────────────────────

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; toolId: string }> },
) {
  const { id: workspaceId, toolId } = await params;

  const auth = await requireWorkspaceMember(workspaceId, { minRole: "admin" });
  if (!auth.ok) return auth.response;

  const db = svc();

  const { data: existing } = await db
    .from("n8n_tools")
    .select("id, name, mode")
    .eq("id", toolId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (!existing) {
    return NextResponse.json(
      { error: "Herramienta no encontrada" },
      { status: 404 },
    );
  }

  const { error } = await db
    .from("n8n_tools")
    .delete()
    .eq("id", toolId)
    .eq("workspace_id", workspaceId);

  if (error) {
    console.error("[DELETE /api/workspace/[id]/n8n-tools/[toolId]]:", error);
    return NextResponse.json(
      { error: "Error al eliminar la herramienta" },
      { status: 500 },
    );
  }

  await db.from("events").insert({
    type: "n8n_tool_config_change",
    level: "info",
    workspace_id: workspaceId,
    payload: {
      action: "delete",
      tool_id: existing.id,
      name: existing.name,
      mode: existing.mode,
      changed_by: auth.userId,
    },
  });

  return NextResponse.json({ success: true });
}
