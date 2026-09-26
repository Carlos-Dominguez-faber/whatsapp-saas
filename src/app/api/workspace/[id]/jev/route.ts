import { NextRequest, NextResponse } from "next/server";
import { createClient as svcClient } from "@supabase/supabase-js";
import {
  readJsonBody,
  requireWorkspaceMember,
} from "@/lib/auth/workspace-access";
import { JevPatchSchema } from "@/features/jev-judge/schema";
import { writeJevPatch } from "@/features/jev-judge/uses";
import { loadWhatsAppIntegration } from "@/features/inbox/services/whatsapp-provider";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const auth = await requireWorkspaceMember(workspaceId, { minRole: "manager" });
  if (!auth.ok) return auth.response;

  const parsedBody = await readJsonBody(req);
  if (!parsedBody.ok) return parsedBody.response;
  const parsed = JevPatchSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const svc = svcClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  // Jev's settings live in the workspace's active WhatsApp integration.
  const existing = await loadWhatsAppIntegration(svc, workspaceId);

  if (!existing) {
    return NextResponse.json(
      {
        error:
          "Conecta WhatsApp (YCloud o Kapso) en Integraciones antes de prender Jev.",
      },
      { status: 409 },
    );
  }

  const config = writeJevPatch(
    existing.config,
    parsed.data,
  );
  const { error } = await svc
    .from("integrations")
    .update({ config, updated_at: new Date().toISOString() })
    .eq("id", existing.id);

  if (error) {
    return NextResponse.json({ error: "No se pudo guardar" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, ...parsed.data });
}
