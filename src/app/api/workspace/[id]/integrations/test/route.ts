import { NextRequest, NextResponse } from "next/server";
import { createClient as svcClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireWorkspaceMember, readJsonBody } from "@/lib/auth/workspace-access";
import {
  KapsoError,
  listAllPhoneNumbers,
  rankKapsoNumbers,
} from "@/features/inbox/services/kapso-client";
import { decryptCredentials } from "@/shared/lib/integration-secrets";
import {
  isWhatsAppProvider,
  whatsappApiKey,
  WHATSAPP_PROVIDER_LABELS,
  WHATSAPP_PROVIDERS,
  type WhatsAppProvider,
} from "@/features/inbox/services/whatsapp-provider";

// "Test connection" for a workspace's WhatsApp provider, with what is on the
// screen — saved or not. The body may name the provider being configured and
// carry the values typed so far; anything missing (or masked) falls back to the
// stored row. Without a provider, the workspace's active one is tested.
//
// YCloud: its /balance endpoint proves the key works.
// Kapso: there is no balance endpoint, so we list the project's WhatsApp
// numbers — that proves the key AND catches a phone_number_id that doesn't
// exist in the project, which would otherwise stay invisible until the first
// send. The project's full list only comes back when the caller typed the key
// themselves: with the stored key, a Kapso project shared by several clients
// would otherwise show every one of their numbers.

const MASKED = "••••••";

const bodySchema = z.object({
  provider: z.enum(WHATSAPP_PROVIDERS).optional(),
  apiKey: z.string().optional(),
  config: z
    .object({
      phone_number_id: z.string().optional(),
      waba_id: z.string().optional(),
    })
    .optional(),
});

type YCloudBalanceResponse = {
  balance?: number;
  currency?: string;
  [key: string]: unknown;
};

type KapsoTestConfig = { waba_id?: string; phone_number_id?: string };

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  // Same gate as reading and saving integrations: the test uses the stored
  // credentials on the caller's behalf.
  const auth = await requireWorkspaceMember(workspaceId, { minRole: "manager" });
  if (!auth.ok) return auth.response;

  const parsedBody = await readJsonBody(req);
  if (!parsedBody.ok) return parsedBody.response;
  const parsed = bodySchema.safeParse(parsedBody.body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Proveedor inválido" }, { status: 400 });
  }
  const requested = parsed.data.provider;
  const typedKey =
    parsed.data.apiKey && parsed.data.apiKey !== MASKED ? parsed.data.apiKey.trim() : "";

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

  const stored = data && isWhatsAppProvider(data.provider) ? data : null;
  const provider: WhatsAppProvider | null = requested ?? stored?.provider ?? null;
  if (!provider) {
    return NextResponse.json({
      ok: false,
      error: "Elige el proveedor y escribe su API Key para probar la conexión",
    });
  }
  const label = WHATSAPP_PROVIDER_LABELS[provider];

  let apiKey = typedKey;
  if (!apiKey && stored) {
    const creds = await decryptCredentials(
      stored.credentials as Record<string, unknown> | null,
      workspaceId,
      provider,
    );
    apiKey = whatsappApiKey(provider, creds);
  }
  if (!apiKey) {
    return NextResponse.json({
      ok: false,
      error: `Escribe la API Key de ${label} para probar la conexión`,
    });
  }

  if (provider === "ycloud") return testYCloud(apiKey);

  const config: KapsoTestConfig = {
    ...((stored?.config ?? {}) as KapsoTestConfig),
    ...(parsed.data.config ?? {}),
  };
  return testKapso(apiKey, config, Boolean(typedKey));
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
      error:
        res.status === 401 || res.status === 403
          ? "API Key inválida o sin acceso"
          : `YCloud respondió ${res.status} — intenta de nuevo en un momento`,
    });
  } catch (err) {
    console.error(
      "[integrations/test] YCloud fetch error:",
      err instanceof Error ? err.message : "unknown",
    );
    return NextResponse.json({ ok: false, error: "No se pudo conectar con YCloud" });
  }
}

async function testKapso(apiKey: string, config: KapsoTestConfig, typedKey: boolean) {
  try {
    const numbers = rankKapsoNumbers(await listAllPhoneNumbers(apiKey));
    // Choices to pick from: only for someone who holds the key.
    const choices = typedKey ? { phoneNumbers: numbers } : {};

    if (numbers.length === 0) {
      return NextResponse.json({
        ok: false,
        error:
          "La API key funciona, pero no hay ningún número de WhatsApp en el proyecto de Kapso",
        ...choices,
      });
    }

    const configured = config.phone_number_id?.trim();
    if (!configured) {
      return NextResponse.json({
        ok: false,
        error: typedKey
          ? "Falta el Phone Number ID — elige el número de este workspace"
          : "Falta el Phone Number ID — vuelve a escribir la API Key y prueba de nuevo para elegir el número",
        ...choices,
      });
    }

    const match = numbers.find((n) => n.phone_number_id === configured);
    if (!match) {
      return NextResponse.json({
        ok: false,
        error:
          "El Phone Number ID configurado no existe en este proyecto de Kapso — los envíos van a fallar",
        ...choices,
      });
    }

    const warnings: string[] = [];
    // A drifted waba_id doesn't break sending, only templates — warn, don't fail.
    const wabaId = config.waba_id?.trim();
    if (wabaId && match.waba_id && wabaId !== match.waba_id) {
      warnings.push("El WABA ID no corresponde a este número — las plantillas no van a funcionar");
    }
    if (match.kind === "sandbox") {
      warnings.push("Este es un número sandbox, no recibe mensajes reales");
    }

    return NextResponse.json({
      ok: true,
      provider: "kapso",
      phoneNumbers: [match],
      warnings,
    });
  } catch (err) {
    console.error(
      "[integrations/test] Kapso fetch error:",
      err instanceof Error ? err.message : "unknown",
    );
    const denied = err instanceof KapsoError && (err.status === 401 || err.status === 403);
    return NextResponse.json({
      ok: false,
      error: denied ? "API Key inválida o sin acceso" : "No se pudo conectar con Kapso",
    });
  }
}
