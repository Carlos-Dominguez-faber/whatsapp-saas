// G1: Templates sync — pulls templates from the workspace's WhatsApp provider
// (YCloud or Kapso) and upserts them into the workspace.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { syncTemplates } from "@/features/inbox/services/templates";
import { WHATSAPP_NOT_CONNECTED } from "@/features/inbox/services/whatsapp-provider";

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

// ── POST /api/workspace/[id]/templates/sync ───────────────────────────────────

export async function POST(
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

  if (!["admin", "manager"].includes(member.role as string)) {
    return NextResponse.json(
      { error: "Se requiere rol admin o manager" },
      { status: 403 },
    );
  }

  try {
    const result = await syncTemplates(workspaceId);
    return NextResponse.json({ synced: result.synced, errors: result.errors });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    console.error("[POST /api/workspace/[id]/templates/sync]:", err);

    // Surface integration-not-configured as a 422 so the UI can show a
    // helpful message instead of a generic 500.
    if (message.includes(WHATSAPP_NOT_CONNECTED)) {
      return NextResponse.json(
        {
          error:
            "WhatsApp no está conectado. Elige YCloud o Kapso en la pestaña Integraciones.",
        },
        { status: 422 },
      );
    }
    if (message.includes("falta waba_id")) {
      return NextResponse.json(
        {
          error:
            "Falta el WABA ID en la configuración de Kapso — sin él no se pueden sincronizar plantillas.",
        },
        { status: 422 },
      );
    }

    return NextResponse.json(
      { error: "Error al sincronizar templates" },
      { status: 500 },
    );
  }
}
