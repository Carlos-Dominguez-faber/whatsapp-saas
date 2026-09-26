import {
  requireWorkspaceMember,
  readJsonBody,
} from "@/lib/auth/workspace-access";
import { createClient as createSbClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { configSchemaForTool } from "@/features/tools/lib/tool-config";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/tools/[workspaceId]
// Returns all tools in the catalog with their enabled state for this workspace.
// Each tool's config (e.g. a webhook URL) goes only to admins and managers, the
// roles the tool_configs SELECT policy allows; everyone else gets config: null.
// ──────────────────────────────────────────────────────────────────────────────
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params;

  // Auth + membership gate (any active member — read-only)
  const auth = await requireWorkspaceMember(workspaceId);
  if (!auth.ok) return auth.response;

  try {
    const supabase = svc();

    // Load all tools from catalog
    const { data: tools, error: toolsError } = await supabase
      .from("tools")
      .select("id, key, name, description, schema, sensitivity")
      .order("name");

    if (toolsError) throw toolsError;

    // Load enabled configs for this workspace
    const { data: configs, error: configsError } = await supabase
      .from("tool_configs")
      .select("tool_id, enabled, config")
      .eq("workspace_id", workspaceId);

    if (configsError) throw configsError;

    const configMap = new Map(
      (configs ?? []).map((c) => [
        c.tool_id as string,
        {
          enabled: c.enabled as boolean,
          config: c.config as Record<string, unknown> | null,
        },
      ]),
    );

    const canReadConfig = auth.role === "admin" || auth.role === "manager";
    const result = (tools ?? []).map((t) => {
      const cfg = configMap.get(t.id as string);
      return {
        tool: t,
        enabled: cfg?.enabled ?? false,
        config: canReadConfig ? (cfg?.config ?? null) : null,
      };
    });

    return NextResponse.json({ data: result });
  } catch (err) {
    console.error("[GET /api/tools/:workspaceId]", err);
    return NextResponse.json(
      { error: "Error interno del servidor" },
      { status: 500 },
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// PATCH /api/tools/[workspaceId]
// Toggles a tool on/off for a workspace.
// Body: { toolKey: string, enabled: boolean }
// ──────────────────────────────────────────────────────────────────────────────

const patchSchema = z
  .object({
    toolKey: z.string().min(1),
    enabled: z.boolean().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((b) => b.enabled !== undefined || b.config !== undefined, {
    message: "Debes enviar 'enabled' y/o 'config'",
  });

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params;

  // Auth + membership gate (manager+ to mutate tool config)
  const auth = await requireWorkspaceMember(workspaceId, {
    minRole: "manager",
  });
  if (!auth.ok) return auth.response;

  // Validate body
  const parsedBody = await readJsonBody<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;

  const parsed = patchSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { toolKey, enabled, config } = parsed.data;

  // Validate the config against the tool's schema (if it has one).
  let validatedConfig: Record<string, unknown> | undefined;
  if (config !== undefined) {
    const configSchema = configSchemaForTool(toolKey);
    if (!configSchema) {
      return NextResponse.json(
        { error: `La tool "${toolKey}" no admite configuración` },
        { status: 400 },
      );
    }
    const cfgParsed = configSchema.safeParse(config);
    if (!cfgParsed.success) {
      return NextResponse.json(
        { error: cfgParsed.error.flatten() },
        { status: 400 },
      );
    }
    validatedConfig = cfgParsed.data as Record<string, unknown>;
  }

  try {
    const supabase = svc();

    // Find tool by key
    const { data: toolRow, error: toolError } = await supabase
      .from("tools")
      .select("id")
      .eq("key", toolKey)
      .single();

    if (toolError || !toolRow) {
      return NextResponse.json(
        { error: `Tool "${toolKey}" not found` },
        { status: 404 },
      );
    }

    const toolId = toolRow.id as string;

    // Upsert tool_configs — only touch the fields that were provided so a
    // config save doesn't reset `enabled` and vice-versa.
    const { error: upsertError } = await supabase.from("tool_configs").upsert(
      {
        workspace_id: workspaceId,
        tool_id: toolId,
        ...(enabled !== undefined ? { enabled } : {}),
        ...(validatedConfig !== undefined ? { config: validatedConfig } : {}),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,tool_id" },
    );

    if (upsertError) throw upsertError;

    return NextResponse.json({ data: { toolKey, enabled, config } });
  } catch (err) {
    console.error("[PATCH /api/tools/:workspaceId]", err);
    return NextResponse.json(
      { error: "Error interno del servidor" },
      { status: 500 },
    );
  }
}
