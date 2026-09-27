// Phase 4: submit a draft template for Meta approval through the workspace's
// WhatsApp provider, build Meta's `components` from the stored rich fields, and
// flip the row to status='submitted' on success.
//
// The WABA id differs by provider: YCloud's is resolved from the registered
// phone number and goes in the body; Kapso's is configured per workspace
// (the API can't discover it) and goes in the request path.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSbClient } from "@supabase/supabase-js";
import {
  createYCloudTemplate,
  resolveWabaId,
  WabaNotFoundError,
  YCloudError,
} from "@/features/inbox/services/ycloud-client";
import { phoneString } from "@/features/inbox/services/phone";
import {
  createKapsoTemplate,
  KapsoError,
} from "@/features/inbox/services/kapso-client";
import {
  decryptWhatsAppCredentials,
  loadWhatsAppIntegration,
  whatsappApiKey,
  WHATSAPP_PROVIDER_LABELS,
} from "@/features/inbox/services/whatsapp-provider";
import {
  formatErrorForLog,
  parseTemplateError,
} from "@/features/inbox/services/whatsapp-errors";
import {
  buildTemplatePayload,
  createTemplateSchema,
  type CreateTemplateInput,
  type TemplateButton,
  type TemplateVariable,
} from "@/features/settings/lib/template-form";

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
  // Meta only takes authentication templates from its own library: sending
  // one as UTILITY with free text is rejected every time. Rows synced before
  // the category was normalized may carry it uppercase.
  const rowCategory = String(row.category ?? "").trim().toLowerCase();
  if (rowCategory === "authentication") {
    return NextResponse.json(
      {
        error:
          "Las plantillas de autenticación no se pueden enviar desde aquí: WhatsApp exige crearlas desde su biblioteca oficial. Cambia la categoría a Utilidad o Marketing.",
      },
      { status: 400 },
    );
  }
  const category = rowCategory === "marketing" ? "marketing" : "utility";

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

  // ── Load the workspace's WhatsApp provider ────────────────────────────────
  const whatsapp = await loadWhatsAppIntegration(db, workspaceId);
  if (!whatsapp) {
    return NextResponse.json(
      {
        error:
          "Conecta WhatsApp (YCloud o Kapso) en Integraciones antes de enviar plantillas",
      },
      { status: 400 },
    );
  }
  const label = WHATSAPP_PROVIDER_LABELS[whatsapp.provider];
  const credentials = await decryptWhatsAppCredentials(whatsapp, workspaceId);
  const apiKey = whatsappApiKey(whatsapp.provider, credentials);

  if (!apiKey || apiKey === "placeholder") {
    return NextResponse.json(
      { error: `Configura la API key de ${label} antes de enviar plantillas` },
      { status: 400 },
    );
  }

  // ── Create on the provider ────────────────────────────────────────────────
  try {
    const payload = buildTemplatePayload(valid.data);
    let result: { id: string };

    if (whatsapp.provider === "kapso") {
      const wabaId = (whatsapp.config.waba_id as string | undefined) ?? "";
      if (!wabaId) {
        return NextResponse.json(
          {
            error:
              "Falta el WABA ID en la configuración de Kapso — sin él no se pueden crear plantillas",
          },
          { status: 400 },
        );
      }
      result = await createKapsoTemplate(apiKey, wabaId, payload);
    } else {
      const phoneNumber = phoneString(whatsapp.config.phone_number) ?? "";
      if (!phoneNumber) {
        return NextResponse.json(
          { error: "Falta el número de WhatsApp en la configuración de YCloud" },
          { status: 400 },
        );
      }
      const wabaId = await resolveWabaId(apiKey, phoneNumber);
      result = await createYCloudTemplate(apiKey, { wabaId, ...payload });
    }

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
      // The template WAS created on the provider; surface success but warn.
      return NextResponse.json({
        data: { ...row, status: "submitted" },
        warning: `Enviada a ${label}, pero no se pudo actualizar el estado local`,
      });
    }

    return NextResponse.json({ data: updated });
  } catch (err) {
    if (err instanceof WabaNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    if (err instanceof YCloudError || err instanceof KapsoError) {
      // `err.message` carries Meta's raw text: server log only. The team gets
      // the catalog's Spanish reason.
      const waError = parseTemplateError(err.body, err.status);
      console.error(
        `[templates/submit] ${label} error:`,
        formatErrorForLog(waError),
        err.message,
      );
      return NextResponse.json({ error: waError.message }, { status: 502 });
    }
    console.error("[templates/submit] error:", err);
    return NextResponse.json(
      { error: "Error al enviar la plantilla" },
      { status: 500 },
    );
  }
}
