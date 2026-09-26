// WhatsApp providers. Each workspace picks ONE in Settings → Integraciones:
// YCloud or Kapso (Kapso works in the United States, YCloud does not). Its
// `integrations` row is the enabled one with provider in WHATSAPP_PROVIDERS —
// a partial unique index guarantees there is at most one per workspace.
//
// Everything that is not about talking to the provider (dispatch, the buffer,
// handoff, Jev, templates) goes through this module instead of naming a
// provider, so both keep working side by side on `main`.

import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptCredentials } from "@/shared/lib/integration-secrets";

export const WHATSAPP_PROVIDERS = ["ycloud", "kapso"] as const;
export type WhatsAppProvider = (typeof WHATSAPP_PROVIDERS)[number];

export const WHATSAPP_PROVIDER_LABELS: Record<WhatsAppProvider, string> = {
  ycloud: "YCloud",
  kapso: "Kapso",
};

/** Thrown (inside the message) when a workspace has no active WhatsApp provider. */
export const WHATSAPP_NOT_CONNECTED = "WhatsApp integration not found";

export function isWhatsAppProvider(value: unknown): value is WhatsAppProvider {
  return (WHATSAPP_PROVIDERS as readonly unknown[]).includes(value);
}

/** Path of the provider's webhook; the workspace goes in `?wsid=`. */
export function whatsappWebhookPath(provider: WhatsAppProvider): string {
  return `/api/webhooks/${provider}`;
}

/**
 * Keys of the WhatsApp integration `config` that belong to the WORKSPACE, not
 * to the provider: they survive a provider switch (carried over to the new
 * row). Everything else in the config — phone number, Meta ids — is the
 * provider's own and stays with its row.
 */
export const WORKSPACE_WHATSAPP_SETTINGS = [
  "buffer_silence_seconds",
  "message_history_window",
  "handoff_ack_enabled",
  "handoff_ack_message",
  "jev_enabled",
  "jev_stage",
  "jev_reply",
  "jev_opt_out",
] as const;

export interface WhatsAppIntegrationRow {
  id: string;
  provider: WhatsAppProvider;
  enabled: boolean;
  config: Record<string, unknown>;
  credentials: Record<string, unknown> | null;
}

/**
 * The workspace's ACTIVE WhatsApp integration (enabled, YCloud or Kapso), or
 * null when it has none. `credentials` come back still encrypted — call
 * `decryptWhatsAppCredentials` only where the secret is actually needed.
 */
export async function loadWhatsAppIntegration(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<WhatsAppIntegrationRow | null> {
  const { data, error } = await supabase
    .from("integrations")
    .select("id, provider, enabled, config, credentials")
    .eq("workspace_id", workspaceId)
    .in("provider", WHATSAPP_PROVIDERS as unknown as string[])
    .eq("enabled", true)
    .maybeSingle();

  if (error) {
    throw new Error(`[whatsapp] integration lookup failed: ${error.message}`);
  }
  if (!data || !isWhatsAppProvider(data.provider)) return null;

  return {
    id: data.id as string,
    provider: data.provider,
    enabled: true,
    config: (data.config ?? {}) as Record<string, unknown>,
    credentials: (data.credentials ?? null) as Record<string, unknown> | null,
  };
}

export async function decryptWhatsAppCredentials(
  row: WhatsAppIntegrationRow,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  return decryptCredentials(row.credentials, workspaceId, row.provider);
}

/** The provider API key, whatever the provider (credentials already decrypted). */
export function whatsappApiKey(
  provider: WhatsAppProvider,
  credentials: Record<string, unknown>,
): string {
  const key =
    provider === "kapso" ? credentials.kapso_api_key : credentials.ycloud_api_key;
  return typeof key === "string" ? key : "";
}
