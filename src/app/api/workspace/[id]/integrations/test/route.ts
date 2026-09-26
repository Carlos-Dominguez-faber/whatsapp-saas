import { NextRequest, NextResponse } from "next/server";
import { createClient as svcClient } from "@supabase/supabase-js";
import { requireWorkspaceMember } from "@/lib/auth/workspace-access";
import { listAllPhoneNumbers } from "@/features/inbox/services/kapso-client";
import { decryptCredentials } from "@/shared/lib/integration-secrets";
import {
  isWhatsAppProvider,
  whatsappApiKey,
  WHATSAPP_PROVIDERS,
  type WhatsAppProvider,
} from "@/features/inbox/services/whatsapp-provider";

// "Test connection" for a workspace's WhatsApp provider. The body may name the
// provider being configured ({ provider: "ycloud" | "kapso" }); without it the
// workspace's active one is tested.
//
// YCloud: its /balance endpoint proves the key works.
// Kapso: there is no balance endpoint, so we list the project's WhatsApp
// numbers — that proves the key AND catches a phone_number_id that doesn't
// exist in the project, which would otherwise stay invisible until the first
// send.

type YCloudBalanceResponse = {
  balance?: number;
  currency?: string;
  [key: string]: unknown;
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const auth = await requireWorkspaceMember(workspaceId);
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => null)) as { provider?: unknown } | null;
  const requested = body?.provider;
  if (requested !== undefined && !isWhatsAppProvider(requested)) {
    return NextResponse.json({ ok: false, error: "Proveedor inválido" }, { status: 400 });
  }

  const svc = svcClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  let query = svc
    .from("integrations")
    .select("provider, credentials, config")
    .eq("workspace_id", workspaceId);
  query = requested
    ? query.eq("provider", requested)
    : query.in("provider", WHATSAPP_PROVIDERS as unknown as string[]).eq("enabled", true);
  const { data } = await query.maybeSingle();

  if (!data || !isWhatsAppProvider(data.provider)) {
    return NextResponse.json({ ok: false, error: "Guarda la configuración antes de probarla" });
  }
  const provider: WhatsAppProvider = data.provider;
  const creds = await decryptCredentials(
    data.credentials as Record<string, unknown> | null,
    workspaceId,
    provider,
  );
  const apiKey = whatsappApiKey(provider, creds);
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "No API key configured" });
  }

  const config = (data.config ?? {}) as {
    waba_id?: string;
    phone_number_id?: string;
  };

  return provider === "kapso"
    ? testKapso(apiKey, config)
    : testYCloud(apiKey);
}

async function testYCloud(apiKey: string) {
  try {
    const res = await fetch("https://api.ycloud.com/v2/balance", {
      headers: { "X-API-Key": apiKey },
    });

    if (res.ok) {
      const balance = (await res.json()) as YCloudBalanceResponse;
      return NextResponse.json({ ok: true, provider: "ycloud", balance });
    }

    return NextResponse.json({
      ok: false,
      error: `YCloud returned ${res.status}`,
    });
  } catch (err) {
    console.error(
      "[integrations/test] YCloud fetch error:",
      err instanceof Error ? err.message : "unknown",
    );
    return NextResponse.json({ ok: false, error: "Failed to reach YCloud" });
  }
}

async function testKapso(
  apiKey: string,
  config: { waba_id?: string; phone_number_id?: string },
) {
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
      provider: "kapso",
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
