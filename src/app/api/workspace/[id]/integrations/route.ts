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
  missingWhatsAppFields,
  WHATSAPP_PROVIDER_LABELS,
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

  // A WhatsApp provider only becomes the active one when it can actually talk:
  // activating it disables the other, and without a key, secret or sender id
  // replies would be dropped silently. Checked against what is stored plus what
  // this request brings (masked values keep the stored ones).
  if (isWhatsAppProvider(provider) && enabled) {
    const missing = missingWhatsAppFields(provider, mergedCreds, {
      ...((existing?.config as Record<string, unknown> | null) ?? {}),
      ...(parsed.data.config ?? {}),
    });
    if (missing.length > 0) {
      return NextResponse.json(
        {
          error: `Para activar ${WHATSAPP_PROVIDER_LABELS[provider]} falta ${missing.join(", ")}.`,
          missing,
        },
        { status: 422 },
      );
    }
  }

  // Encrypt the whole merged set before writing anything: incoming plaintext
  // gets wrapped, values already stored encrypted are left untouched, and a
  // legacy plaintext row is migrated in place the first time it is saved.
  let encryptedCreds: Record<string, unknown>;
  try {
    encryptedCreds = await encryptCredentials(mergedCreds, workspaceId, provider);
  } catch (err) {
    console.error(
      "[PUT /api/workspace/[id]/integrations] encrypt error:",
      err instanceof Error ? err.message : "unknown",
    );
    return NextResponse.json(
      { error: "No se pudo guardar la integración. Intenta de nuevo." },
      { status: 500 },
    );
  }

  // WhatsApp (YCloud ↔ Kapso): only one may be active per workspace (unique
  // index). save_whatsapp_integration() disables the one being replaced and
  // saves this one in a single transaction, carrying the workspace-level
  // settings over (what the UI sends > the active provider's > this row's
  // own). The replaced row keeps its credentials, so switching back needs no
  // re-entry.
  if (isWhatsAppProvider(provider)) {
    const { data: switchedFrom, error } = await svc.rpc("save_whatsapp_integration", {
      p_workspace_id: workspaceId,
      p_provider: provider,
      p_enabled: enabled,
      p_credentials: encryptedCreds,
      p_config: parsed.data.config ?? {},
      p_workspace_keys: [...WORKSPACE_WHATSAPP_SETTINGS],
    });
    if (error) {
      console.error("[PUT /api/workspace/[id]/integrations] save error:", error.message);
      return NextResponse.json(
        { error: "No se pudo guardar la integración. Intenta de nuevo." },
        { status: 500 },
      );
    }
    return NextResponse.json({
      ok: true,
      ...(typeof switchedFrom === "string" && switchedFrom ? { switchedFrom } : {}),
    });
  }

  const mergedConfig = {
    ...((existing?.config as object) ?? {}),
    ...(parsed.data.config ?? {}),
  };

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
    return NextResponse.json(
      { error: "No se pudo guardar la integración. Intenta de nuevo." },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
