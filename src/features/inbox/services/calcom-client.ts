/**
 * calcom-client.ts — Cal.com API v2 client.
 *
 * Auth: personal API key. The workspace stores its key in
 * integrations.credentials.calcom_api_key and its fixed timezone in
 * integrations.config.timezone.
 *
 * API v2 docs: https://cal.com/docs/api-reference/v2/introduction
 * cal-api-version is versioned per endpoint, not globally — each caller
 * passes the constant for the endpoint it's calling (see CALCOM_API_VERSION).
 */

import { createClient as createSbClient } from "@supabase/supabase-js";
import { decryptCredentials } from "@/shared/lib/integration-secrets";

export const CALCOM_BASE_URL = "https://api.cal.com";

export const CALCOM_API_VERSION = {
  bookings: "2026-02-25",
  eventTypes: "2024-06-14",
  slots: "2024-09-04",
} as const;

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export interface CalComConfig {
  /** Personal API key, prefixed cal_ (test) or cal_live_ (live). */
  apiKey: string;
  /** IANA timezone for availability queries and bookings. Defaults to "UTC". */
  timezone: string;
}

/**
 * Loads the workspace's Cal.com API key + fixed timezone.
 * Returns null when Cal.com is not connected (no key, or integration disabled).
 */
export async function getCalComConfig(
  workspaceId: string,
): Promise<CalComConfig | null> {
  const supabase = svc();
  const { data, error } = await supabase
    .from("integrations")
    .select("credentials, config, enabled")
    .eq("workspace_id", workspaceId)
    .eq("provider", "caldotcom")
    .eq("enabled", true)
    .maybeSingle();

  if (error || !data) return null;

  // getCalComConfig never throws: its callers are LLM tools that don't wrap
  // the call in try/catch and turn `null` into a clean ToolResult. Without
  // this catch, an undecryptable credential would propagate up to the
  // registry and its raw error text would reach the LLM's context.
  let creds: Record<string, unknown>;
  try {
    creds = await decryptCredentials(
      data.credentials as Record<string, unknown> | null,
      workspaceId,
      "caldotcom",
    );
  } catch (err) {
    console.error("[CalCom] getCalComConfig: could not decrypt credentials", {
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  const config = (data.config as Record<string, unknown> | null) ?? {};

  const apiKey = creds.calcom_api_key;
  if (typeof apiKey !== "string" || apiKey.length === 0) return null;

  const timezone = config.timezone;

  return {
    apiKey,
    timezone:
      typeof timezone === "string" && timezone.length > 0 ? timezone : "UTC",
  };
}

export function calcomHeaders(apiKey: string, version: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
    "cal-api-version": version,
    "Content-Type": "application/json",
  };
}

interface CalComEventTypesResponse {
  status: string;
  data?: Array<{ id: number; recurrence?: { disabled?: boolean } | null }>;
}

export interface CalComEventTypeInfo {
  id: number;
  /**
   * True when this event type has an ACTIVE recurrence rule. Cal.com's
   * POST /v2/bookings returns an ARRAY of bookings (one per occurrence) for
   * a recurring event type instead of the single-object shape every other
   * event type returns — this system stores one calcom_booking_uid per
   * appointment row and has no concept of a booking series, so recurring
   * event types must be rejected before booking, not silently mis-parsed
   * into a lost/unlinkable series.
   */
  recurring: boolean;
}

/**
 * Lists the event types that actually belong to this API key's Cal.com
 * account, plus whether each has an active recurrence rule. Cal.com's
 * booking/slots endpoints accept ANY eventTypeId without checking ownership
 * (verified against the live API) — tools must validate against
 * this list themselves before trusting an id the LLM passes, or a
 * contact/prompt-injection can book against another account's calendar.
 * Returns null on any upstream failure — fail closed, callers must reject
 * the id rather than assume it's valid.
 */
export async function listCalComEventTypeIds(
  apiKey: string,
): Promise<CalComEventTypeInfo[] | null> {
  try {
    const res = await fetch(`${CALCOM_BASE_URL}/v2/event-types`, {
      method: "GET",
      headers: calcomHeaders(apiKey, CALCOM_API_VERSION.eventTypes),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as CalComEventTypesResponse;
    return (data.data ?? []).map((et) => ({
      id: et.id,
      recurring: !!et.recurrence && et.recurrence.disabled !== true,
    }));
  } catch {
    // A network-level fetch rejection or a non-JSON body must also fail
    // closed per this function's contract, not throw.
    return null;
  }
}

/**
 * Strips the workspace's own Cal.com API key out of upstream error text
 * before it's included in a ToolResult.error (which flows to the LLM and is
 * persisted in events.payload.error). Nothing guarantees Cal.com never
 * reflects the Authorization header back in an error body — redact
 * defensively rather than trust it won't.
 * Apply BEFORE truncating error text to a fixed length, or a truncated key
 * fragment won't match and won't be redacted.
 */
export function redactCalComApiKey(text: string, apiKey: string): string {
  if (!apiKey) return text;
  return text.split(apiKey).join("[REDACTED]");
}
