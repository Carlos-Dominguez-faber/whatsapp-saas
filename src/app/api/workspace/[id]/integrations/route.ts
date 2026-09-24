import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { createClient as svcClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  requireWorkspaceMember,
  readJsonBody,
} from "@/lib/auth/workspace-access";
import {
  encryptCredentials,
  decryptCredentials,
} from "@/shared/lib/integration-secrets";
import { hubSpotTokenFingerprint } from "@/features/inbox/services/hubspot-client";

const IntegrationSchema = z.object({
  provider: z.enum(["kapso", "openrouter", "highlevel", "caldotcom", "hubspot"]),
  enabled: z.boolean().optional(),
  credentials: z.record(z.string(), z.string()).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Un solo CRM activo por workspace. Lo IMPONE el índice uq_integrations_one_active_crm
 * (20260922000002), para todos los escritores; acá solo se traduce su 23505 a un 409 legible.
 * Cal.com es agenda, no CRM.
 */
const CRM_LABELS = { highlevel: "HighLevel", hubspot: "HubSpot" } as const;

/** Claves de config que escribe SOLO el servidor (PUT e integrations/hubspot/test). */
const SERVER_CONFIG_KEYS = ["properties_ready", "token_fingerprint", "portal_id"] as const;

type IntegrationRow = {
  id: string;
  provider: string;
  enabled: boolean;
  config: Record<string, unknown> | null;
  credentials: Record<string, unknown> | null;
  oauth_tokens: Record<string, unknown> | null;
};

function maskRecord(
  obj: Record<string, unknown> | null,
): Record<string, string> {
  if (!obj) return {};
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, v ? "••••••" : ""]),
  );
}

// GET: return integrations with masked credentials
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  // This route reads through the service-role client, which bypasses RLS, so it
  // has to reproduce the table's own policy: integrations_select_admins limits
  // SELECT to admin/manager. Without this, any member (viewer/agent included)
  // could read the HighLevel webhook token exposed below.
  const auth = await requireWorkspaceMember(workspaceId, {
    minRole: "manager",
  });
  if (!auth.ok) return auth.response;

  const svc = svcClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data } = await svc
    .from("integrations")
    .select("id, provider, enabled, config, credentials, oauth_tokens")
    .eq("workspace_id", workspaceId);

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";

  const masked = await Promise.all(
    ((data ?? []) as IntegrationRow[]).map(async (row) => {
      const base = {
        id: row.id,
        provider: row.provider,
        enabled: row.enabled,
        config: row.config ?? {},
        credentials: maskRecord(row.credentials),
        oauth_tokens: maskRecord(row.oauth_tokens),
      };

      // The HighLevel inbound-sync webhook token has to travel to the client:
      // the operator copies the resulting URL into HighLevel, so there is no way
      // to render it masked. It is scoped to inbound contact-sync only, and this
      // route is manager+ (see the auth gate above).
      if (row.provider === "highlevel") {
        const creds = await decryptCredentials(
          row.credentials,
          workspaceId,
          row.provider,
        );
        const secret =
          typeof creds.highlevel_webhook_secret === "string"
            ? creds.highlevel_webhook_secret
            : "";
        return {
          ...base,
          highlevel_webhook_secret: secret,
          highlevel_webhook_url: secret
            ? `${appUrl}/api/webhooks/highlevel?wsid=${workspaceId}&token=${secret}`
            : "",
        };
      }

      return base;
    }),
  );

  return NextResponse.json({ integrations: masked });
}

// PUT: upsert integration — only write fields that are NOT masked placeholder
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  // Writing credentials mirrors the table's own policy
  // (integrations_write_admins): admin only, not manager.
  const auth = await requireWorkspaceMember(workspaceId, {
    minRole: "admin",
  });
  if (!auth.ok) return auth.response;

  const parsedBody = await readJsonBody(req);
  if (!parsedBody.ok) return parsedBody.response;
  const parsed = IntegrationSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const svc = svcClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // Load existing to merge (don't overwrite masked values). `updated_at` es el testigo del CAS de
  // más abajo. Un error de lectura NO es "no existe": iría por el INSERT de una fila nueva.
  const { data: existing, error: readError } = await svc
    .from("integrations")
    .select("credentials, config, oauth_tokens, updated_at")
    .eq("workspace_id", workspaceId)
    .eq("provider", parsed.data.provider)
    .maybeSingle();
  if (readError) {
    console.error("[PUT /api/workspace/[id]/integrations] read error:", readError.message);
    return NextResponse.json(
      { error: "No se pudo guardar la integración. Intenta de nuevo." },
      { status: 500 },
    );
  }

  // Filter out masked placeholder values from credentials update
  const newCreds = Object.fromEntries(
    Object.entries(parsed.data.credentials ?? {}).filter(
      ([, v]) => v !== "••••••" && v !== "",
    ),
  );
  const mergedCreds: Record<string, unknown> = {
    ...((existing?.credentials as object) ?? {}),
    ...newCreds,
  };

  // For HighLevel, auto-generate a stable inbound-webhook token on first save.
  // Never overwrite an existing secret (so the configured URL stays valid).
  if (
    parsed.data.provider === "highlevel" &&
    typeof mergedCreds.highlevel_webhook_secret !== "string"
  ) {
    mergedCreds.highlevel_webhook_secret = randomBytes(24).toString("hex");
  }
  const provider = parsed.data.provider;
  const clientConfig: Record<string, unknown> = { ...(parsed.data.config ?? {}) };
  for (const key of SERVER_CONFIG_KEYS) delete clientConfig[key];
  const existingConfig = (existing?.config as Record<string, unknown> | null) ?? {};
  const mergedConfig: Record<string, unknown> = { ...existingConfig, ...clientConfig };

  // Un token DISTINTO puede ser otra cuenta de HubSpot: hay que volver a probar la conexión, que
  // es la que valida propiedades y portal. El mismo token reenviado no invalida nada. La huella se
  // calcula sobre el token EN CLARO que llega en el body (antes de cifrar): el cifrado usa IV
  // aleatorio, así que un hash del texto cifrado cambiaría en cada guardado del mismo token.
  if (provider === "hubspot" && typeof newCreds.hubspot_token === "string") {
    const fingerprint = hubSpotTokenFingerprint(newCreds.hubspot_token);
    if (fingerprint !== existingConfig.token_fingerprint) {
      mergedConfig.token_fingerprint = fingerprint;
      mergedConfig.properties_ready = false;
    }
  }

  // Encrypt the whole merged set: incoming plaintext gets wrapped, values
  // already stored encrypted are left untouched, and a legacy plaintext row is
  // migrated in place the first time it is saved.
  const encryptedCreds = await encryptCredentials(
    mergedCreds,
    workspaceId,
    provider,
  );

  // La fila se escribe con CAS sobre el `updated_at` leído, nunca con un upsert de la foto. Si
  // otro PUT o mark_hubspot_ready la cambió en el medio (el trigger trg_integrations_updated_at
  // mueve updated_at en todo UPDATE), no se afecta ninguna fila y se responde 409: sin esto, un
  // PUT atrasado restauraba token, huella, properties_ready y portal de la cuenta anterior sobre
  // enlaces ya hechos con la nueva. Sin fila leída va un INSERT; si otro primer guardado ganó la
  // carrera, su 23505 de (workspace_id, provider) es el mismo 409.
  const row = {
    enabled: parsed.data.enabled ?? true,
    credentials: encryptedCreds,
    config: mergedConfig,
  };
  const { data: written, error } = existing
    ? await svc
        .from("integrations")
        .update(row)
        .eq("workspace_id", workspaceId)
        .eq("provider", provider)
        .eq("updated_at", existing.updated_at)
        .select("id")
    : await svc
        .from("integrations")
        .insert({ workspace_id: workspaceId, provider, ...row })
        .select("id");

  const concurrent = NextResponse.json(
    { error: "La configuración cambió mientras guardabas. Recarga e inténtalo de nuevo." },
    { status: 409 },
  );
  if (error) {
    const otherCrmActive =
      error.code === "23505" && (error.message ?? "").includes("uq_integrations_one_active_crm");
    if (error.code === "23505" && !otherCrmActive) return concurrent;
    if (otherCrmActive && (provider === "highlevel" || provider === "hubspot")) {
      const other = provider === "highlevel" ? "hubspot" : "highlevel";
      return NextResponse.json(
        {
          error: `Ya tienes ${CRM_LABELS[other]} conectado como CRM. Desactívalo antes de conectar ${CRM_LABELS[provider]}.`,
        },
        { status: 409 },
      );
    }
    console.error("[PUT /api/workspace/[id]/integrations] write error:", error.message);
    return NextResponse.json(
      { error: "No se pudo guardar la integración. Intenta de nuevo." },
      { status: 500 },
    );
  }
  if (!written || written.length === 0) return concurrent;
  return NextResponse.json({ ok: true });
}
