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

/** Where each provider keeps the id it sends from. */
const SENDER_ID_KEY: Record<WhatsAppProvider, string> = {
  ycloud: "phone_number", // the E.164 number
  kapso: "phone_number_id", // Meta's phone number id
};

function present(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * What a provider still lacks before it can be a workspace's active one: the
 * API key, the webhook signing secret and the id it sends from. Without any of
 * them nothing goes out (or nothing comes in), so activating it would leave
 * the workspace silent. Returns user-facing labels; empty means ready.
 * `credentials` may be encrypted — only presence is checked.
 */
export function missingWhatsAppFields(
  provider: WhatsAppProvider,
  credentials: Record<string, unknown>,
  config: Record<string, unknown>,
): string[] {
  const missing: string[] = [];
  if (!present(whatsappApiKey(provider, credentials))) missing.push("la API Key");
  if (!present(credentials.webhook_signing_secret)) {
    missing.push("el Webhook Signing Secret");
  }
  if (!present(config[SENDER_ID_KEY[provider]])) {
    missing.push(provider === "kapso" ? "el Phone Number ID" : "el número de WhatsApp");
  }
  return missing;
}

export interface WhatsAppSettingsRow {
  id: string;
  provider: WhatsAppProvider;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface WhatsAppIntegrationRow extends WhatsAppSettingsRow {
  credentials: Record<string, unknown> | null;
}

async function loadActiveRow(
  supabase: SupabaseClient,
  workspaceId: string,
  columns: string,
): Promise<Record<string, unknown> | null> {
  const lookup = (providers: readonly string[]) =>
    supabase
      .from("integrations")
      .select(columns)
      .eq("workspace_id", workspaceId)
      .in("provider", providers as string[])
      .eq("enabled", true)
      .maybeSingle();

  let { data, error } = await lookup(WHATSAPP_PROVIDERS);
  // 22P02: the database does not know 'kapso' yet — this code was deployed
  // before `db push` ran 20260927000000. Keep YCloud workspaces sending
  // instead of failing every lookup until the migration lands.
  if (error?.code === "22P02") {
    console.error(
      "[whatsapp] 'kapso' is not in integration_provider yet — run `setup.mjs db-push`",
    );
    ({ data, error } = await lookup(["ycloud"]));
  }
  if (error) {
    throw new Error(`[whatsapp] integration lookup failed: ${error.message}`);
  }
  return (data as Record<string, unknown> | null) ?? null;
}

/**
 * The workspace's ACTIVE WhatsApp integration (enabled, YCloud or Kapso), or
 * null when it has none. `credentials` come back still encrypted — call
 * `decryptWhatsAppCredentials` only where the secret is actually needed.
 * Callers that only read settings use `loadWhatsAppSettings`.
 */
export async function loadWhatsAppIntegration(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<WhatsAppIntegrationRow | null> {
  const data = await loadActiveRow(
    supabase,
    workspaceId,
    "id, provider, enabled, config, credentials",
  );
  if (!data || !isWhatsAppProvider(data.provider)) return null;

  return {
    id: data.id as string,
    provider: data.provider,
    enabled: true,
    config: (data.config ?? {}) as Record<string, unknown>,
    credentials: (data.credentials ?? null) as Record<string, unknown> | null,
  };
}

/**
 * The active WhatsApp integration WITHOUT its credentials: for the callers
 * that only read the workspace settings kept in its config (buffer window,
 * handoff acknowledgement, Jev).
 */
export async function loadWhatsAppSettings(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<WhatsAppSettingsRow | null> {
  const data = await loadActiveRow(supabase, workspaceId, "id, provider, enabled, config");
  if (!data || !isWhatsAppProvider(data.provider)) return null;

  return {
    id: data.id as string,
    provider: data.provider,
    enabled: true,
    config: (data.config ?? {}) as Record<string, unknown>,
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
