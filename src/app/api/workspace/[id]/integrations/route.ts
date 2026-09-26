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
import {
  isWhatsAppProvider,
  WHATSAPP_PROVIDERS,
  WORKSPACE_WHATSAPP_SETTINGS,
} from "@/features/inbox/services/whatsapp-provider";

const IntegrationSchema = z.object({
  provider: z.enum(["ycloud", "kapso", "openrouter", "highlevel"]),
  enabled: z.boolean().optional(),
  credentials: z.record(z.string(), z.string()).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

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

  const auth = await requireWorkspaceMember(workspaceId, {
    minRole: "manager",
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

  // Load existing to merge (don't overwrite masked values)
  const { data: existing } = await svc
    .from("integrations")
    .select("credentials, config, oauth_tokens")
    .eq("workspace_id", workspaceId)
    .eq("provider", parsed.data.provider)
    .single();

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
  const enabled = parsed.data.enabled ?? true;

  // Switching WhatsApp provider (YCloud ↔ Kapso): only one may be active per
  // workspace (enforced by a unique index). The settings that belong to the
  // workspace rather than the provider travel with the switch — precedence:
  // what the UI sends > the currently active provider > this provider's own
  // (possibly stale) row. The old row keeps its credentials, disabled, so
  // switching back needs no re-entry.
  let switchedFrom: { id: string; provider: string } | null = null;
  const carried: Record<string, unknown> = {};
  if (isWhatsAppProvider(provider) && enabled) {
    const { data: active, error: activeError } = await svc
      .from("integrations")
      .select("id, provider, config")
      .eq("workspace_id", workspaceId)
      .in("provider", WHATSAPP_PROVIDERS as unknown as string[])
      .neq("provider", provider)
      .eq("enabled", true)
      .maybeSingle();
    if (activeError) {
      console.error("[PUT /api/workspace/[id]/integrations] lookup error:", activeError.message);
      return NextResponse.json(
        { error: "No se pudo guardar la integración. Intenta de nuevo." },
        { status: 500 },
      );
    }
    if (active) {
      const activeConfig = (active.config ?? {}) as Record<string, unknown>;
      for (const key of WORKSPACE_WHATSAPP_SETTINGS) {
        if (key in activeConfig) carried[key] = activeConfig[key];
      }
      const { error: offError } = await svc
        .from("integrations")
        .update({ enabled: false, updated_at: new Date().toISOString() })
        .eq("id", active.id)
        .eq("workspace_id", workspaceId);
      if (offError) {
        console.error("[PUT /api/workspace/[id]/integrations] switch error:", offError.message);
        return NextResponse.json(
          { error: "No se pudo cambiar de proveedor. Intenta de nuevo." },
          { status: 500 },
        );
      }
      switchedFrom = { id: active.id as string, provider: active.provider as string };
    }
  }

  const mergedConfig = {
    ...((existing?.config as object) ?? {}),
    ...carried,
    ...(parsed.data.config ?? {}),
  };

  // Encrypt the whole merged set: incoming plaintext gets wrapped, values
  // already stored encrypted are left untouched, and a legacy plaintext row is
  // migrated in place the first time it is saved.
  const encryptedCreds = await encryptCredentials(
    mergedCreds,
    workspaceId,
    parsed.data.provider,
  );

  const { error } = await svc.from("integrations").upsert(
    {
      workspace_id: workspaceId,
      provider,
      enabled,
      credentials: encryptedCreds,
      config: mergedConfig,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id,provider" },
  );

  if (error) {
    console.error("[PUT /api/workspace/[id]/integrations] upsert error:", error.message);
    // Never leave the workspace without WhatsApp because the new row failed.
    if (switchedFrom) {
      await svc
        .from("integrations")
        .update({ enabled: true, updated_at: new Date().toISOString() })
        .eq("id", switchedFrom.id)
        .eq("workspace_id", workspaceId);
    }
    return NextResponse.json(
      { error: "No se pudo guardar la integración. Intenta de nuevo." },
      { status: 500 },
    );
  }
  return NextResponse.json({
    ok: true,
    ...(switchedFrom ? { switchedFrom: switchedFrom.provider } : {}),
  });
}
