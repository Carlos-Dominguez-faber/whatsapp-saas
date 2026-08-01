import { NextRequest, NextResponse } from "next/server";
import { createClient as svcClient } from "@supabase/supabase-js";
import { requireWorkspaceMember } from "@/lib/auth/workspace-access";
import { listAllPhoneNumbers } from "@/features/inbox/services/kapso-client";

// Kapso has no /balance endpoint like YCloud's, so "test connection" lists the
// project's WhatsApp numbers. That proves the API key works AND lets us catch
// the misconfiguration that would otherwise be invisible until the first send:
// a phone_number_id that doesn't exist in this Kapso project.

type KapsoCredentials = {
  kapso_api_key?: string;
};

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const auth = await requireWorkspaceMember(workspaceId);
  if (!auth.ok) return auth.response;

  const svc = svcClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data } = await svc
    .from("integrations")
    .select("credentials, config, enabled")
    .eq("workspace_id", workspaceId)
    .eq("provider", "kapso")
    .single();

  const creds = data?.credentials as KapsoCredentials | null;
  const config = (data?.config ?? {}) as {
    waba_id?: string;
    phone_number_id?: string;
  };
  const apiKey = creds?.kapso_api_key;

  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "No API key configured" });
  }

  try {
    const numbers = await listAllPhoneNumbers(apiKey);

    if (numbers.length === 0) {
      return NextResponse.json({
        ok: false,
        error:
          "La API key funciona, pero no hay ningún número de WhatsApp en el proyecto de Kapso",
        phoneNumbers: [],
      });
    }

    const configured = config.phone_number_id;
    if (!configured) {
      return NextResponse.json({
        ok: false,
        error:
          "Falta el Phone Number ID — sin él no se puede enviar ningún mensaje",
        phoneNumbers: numbers,
      });
    }

    const match = numbers.find((n) => n.phone_number_id === configured);
    if (!match) {
      return NextResponse.json({
        ok: false,
        error:
          "El Phone Number ID configurado no existe en este proyecto de Kapso — los envíos van a fallar",
        phoneNumbers: numbers,
      });
    }

    // A drifted waba_id doesn't break sending, only templates — warn, don't fail.
    const wabaMismatch = Boolean(
      config.waba_id && match.waba_id && config.waba_id !== match.waba_id,
    );

    return NextResponse.json({
      ok: true,
      phoneNumbers: [match],
      ...(wabaMismatch
        ? {
            warning:
              "El WABA ID no corresponde a este número — las plantillas no van a funcionar",
          }
        : {}),
      ...(match.kind === "sandbox"
        ? { warning: "Este es un número sandbox, no recibe mensajes reales" }
        : {}),
    });
  } catch (err) {
    console.error(
      "[integrations/test] Kapso fetch error:",
      err instanceof Error ? err.message : "unknown",
    );
    return NextResponse.json({ ok: false, error: "Failed to reach Kapso" });
  }
}
