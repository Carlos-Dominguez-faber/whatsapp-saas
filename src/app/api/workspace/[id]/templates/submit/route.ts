// Phase 4: submit a draft template to YCloud (Meta approval).
//
// We don't store the wabaId, so we resolve it from the registered phone number
// at submit time, build the YCloud `components` from the stored rich fields, and
// flip the row to status='submitted' on success.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSbClient } from "@supabase/supabase-js";
import {
  createYCloudTemplate,
  resolveWabaId,
  YCloudError,
} from "@/features/inbox/services/ycloud-client";
import {
  buildYCloudPayload,
  createTemplateSchema,
  type CreateTemplateInput,
  type TemplateButton,
  type TemplateVariable,
} from "@/features/settings/lib/template-form";
import { decryptCredentials } from "@/shared/lib/integration-secrets";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

const BodySchema = z.object({ id: z.string().uuid() });

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  // ── Auth + role ───────────────────────────────────────────────────────────
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const { data: member } = await supabase
    .from("memberships")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!member) {
    return NextResponse.json({ error: "Acceso denegado" }, { status: 403 });
  }
  if (!["admin", "manager"].includes(member.role as string)) {
    return NextResponse.json(
      { error: "Se requiere rol admin o manager" },
      { status: 403 },
    );
  }

  // ── Parse ─────────────────────────────────────────────────────────────────
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "id inválido" }, { status: 400 });
  }

  const db = svc();

  // ── Load the draft ────────────────────────────────────────────────────────
  const { data: row, error: rowError } = await db
    .from("templates")
    .select("*")
    .eq("id", parsed.data.id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (rowError || !row) {
    return NextResponse.json(
      { error: "Plantilla no encontrada" },
      { status: 404 },
    );
  }
  if (!["draft", "rejected"].includes(row.status as string)) {
    return NextResponse.json(
      { error: "Solo se pueden enviar borradores o plantillas rechazadas" },
      { status: 409 },
    );
  }

  // ── Reconstruct + validate the builder input ──────────────────────────────
  const rawVariables = (
    Array.isArray(row.variables) ? row.variables : []
  ) as unknown[];
  const variables = rawVariables.filter(
    (v): v is TemplateVariable =>
      typeof v === "object" && v !== null && "index" in v,
  );
  const buttons = (
    Array.isArray(row.buttons) ? row.buttons : []
  ) as TemplateButton[];
  const category =
    (row.category as string) === "marketing" ? "marketing" : "utility";

  const input: CreateTemplateInput = {
    name: row.name as string,
    category,
    header_type: (row.header_type as "none" | "text") ?? "none",
    header_text: (row.header_text as string | null) ?? "",
    body_template: row.body_template as string,
    body_variables: variables,
    footer_text: (row.footer_text as string | null) ?? "",
    buttons,
  };

  const valid = createTemplateSchema.safeParse(input);
  if (!valid.success) {
    return NextResponse.json(
      { error: "La plantilla tiene campos inválidos para enviar" },
      { status: 400 },
    );
  }

  // ── Load YCloud credentials ───────────────────────────────────────────────
  const { data: integration } = await db
    .from("integrations")
    .select("credentials, config")
    .eq("workspace_id", workspaceId)
    .eq("provider", "ycloud")
    .eq("enabled", true)
    .maybeSingle();

  const credentials = await decryptCredentials(
    integration?.credentials as Record<string, unknown> | null,
    workspaceId,
    "ycloud",
  );
  const config = (integration?.config ?? {}) as Record<string, unknown>;
  const apiKey = (credentials.ycloud_api_key as string | undefined) ?? "";
  const phoneNumber = (config.phone_number as string | undefined) ?? "";

  if (!apiKey || apiKey === "placeholder") {
    return NextResponse.json(
      { error: "Configura la API key de YCloud antes de enviar plantillas" },
      { status: 400 },
    );
  }
  if (!phoneNumber) {
    return NextResponse.json(
      { error: "Falta el número de WhatsApp en la configuración de YCloud" },
      { status: 400 },
    );
  }

  // ── Resolve wabaId + create on YCloud ─────────────────────────────────────
  try {
    const wabaId = await resolveWabaId(apiKey, phoneNumber);
    const payload = buildYCloudPayload(wabaId, valid.data);
    const result = await createYCloudTemplate(apiKey, payload);

    const { data: updated, error: updateError } = await db
      .from("templates")
      .update({
        status: "submitted",
        provider_template_id: result.id || null,
        rejection_reason: null,
        submitted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("workspace_id", workspaceId)
      .select()
      .single();

    if (updateError) {
      console.error("[templates/submit] update error:", updateError);
      // The template WAS created on YCloud; surface success but warn.
      return NextResponse.json({
        data: { ...row, status: "submitted" },
        warning: "Enviada a YCloud, pero no se pudo actualizar el estado local",
      });
    }

    return NextResponse.json({ data: updated });
  } catch (err) {
    if (err instanceof YCloudError) {
      console.error("[templates/submit] YCloud error:", err.status, err.body);
      return NextResponse.json(
        { error: `YCloud rechazó la plantilla: ${err.message}` },
        { status: 502 },
      );
    }
    console.error("[templates/submit] error:", err);
    return NextResponse.json(
      { error: "Error al enviar la plantilla" },
      { status: 500 },
    );
  }
}
