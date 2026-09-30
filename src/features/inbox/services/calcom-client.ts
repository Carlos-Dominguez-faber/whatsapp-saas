/**
 * calcom-client.ts — Cal.com API v2 client.
 *
 * Auth: personal API key, stored encrypted in
 * integrations.credentials.calcom_api_key (provider `caldotcom`).
 *
 * The zone is NOT Cal.com's: every Cal.com tool uses the workspace's
 * scheduling zone (scheduling-timezone.ts), the same one the prompt's
 * calendar table and the HighLevel tools use. A `config.timezone` saved by an
 * earlier version of this integration is ignored.
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

/** One read (event types, slots, a booking). */
export const CALCOM_READ_TIMEOUT_MS = 7_000;

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export interface CalComConfig {
  /** Personal API key, prefixed cal_ (test) or cal_live_ (live). */
  apiKey: string;
}

/**
 * Loads the workspace's Cal.com API key. Returns null when Cal.com is not
 * connected (no key, integration disabled, or a key that can't be
 * decrypted). Never throws: its callers are LLM tools, and a raw error must
 * not reach the model.
 */
export async function getCalComConfig(
  workspaceId: string,
): Promise<CalComConfig | null> {
  const { data, error } = await svc()
    .from("integrations")
    .select("credentials, enabled")
    .eq("workspace_id", workspaceId)
    .eq("provider", "caldotcom")
    .eq("enabled", true)
    .maybeSingle();
  if (error || !data) return null;
  return calComConfigOf(workspaceId, data.credentials as Record<string, unknown> | null);
}

/**
 * Like getCalComConfig, but a failed read throws instead of reading as "not
 * connected": for callers that must fail closed (a reminder must not skip its
 * Cal.com check because the integration row couldn't be read).
 */
export async function loadCalComConfig(workspaceId: string): Promise<CalComConfig | null> {
  const { data, error } = await svc()
    .from("integrations")
    .select("credentials, enabled")
    .eq("workspace_id", workspaceId)
    .eq("provider", "caldotcom")
    .eq("enabled", true)
    .maybeSingle();
  if (error) throw new Error(`[CalCom] could not read the Cal.com integration: ${error.message}`);
  if (!data) return null;
  return calComConfigOf(workspaceId, data.credentials as Record<string, unknown> | null);
}

async function calComConfigOf(
  workspaceId: string,
  credentials: Record<string, unknown> | null,
): Promise<CalComConfig | null> {
  let creds: Record<string, unknown>;
  try {
    creds = await decryptCredentials(credentials, workspaceId, "caldotcom");
  } catch (err) {
    console.error("[CalCom] could not decrypt credentials", {
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  const apiKey = creds.calcom_api_key;
  if (typeof apiKey !== "string" || apiKey.length === 0) return null;
  return { apiKey };
}

export function calcomHeaders(apiKey: string, version: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
    "cal-api-version": version,
    "Content-Type": "application/json",
  };
}

/**
 * Strips the workspace's own Cal.com API key out of upstream error text
 * before it's logged. Nothing guarantees Cal.com never reflects the
 * Authorization header back in an error body. Apply BEFORE truncating, or a
 * truncated key fragment won't match.
 */
export function redactCalComApiKey(text: string, apiKey: string): string {
  if (!apiKey) return text;
  return text.split(apiKey).join("[REDACTED]");
}

/**
 * What a Cal.com call came back with. `http` is a status Cal.com answered
 * with (its body, redacted, is for the logs only); `no_answer` is a network
 * error, a timeout or an unreadable body — for a write, its outcome is
 * unknown.
 */
export type CalComResponse =
  | { kind: "ok"; status: number; json: unknown }
  | { kind: "http"; status: number; detail: string }
  | { kind: "no_answer"; reason: string };

/** One Cal.com call, bounded by `timeoutMs`. Never throws. */
export async function calcomRequest(
  apiKey: string,
  path: string,
  opts: { version: string; method?: "GET" | "POST"; body?: unknown; timeoutMs: number },
): Promise<CalComResponse> {
  let res: Response;
  try {
    res = await fetch(`${CALCOM_BASE_URL}${path}`, {
      method: opts.method ?? "GET",
      headers: calcomHeaders(apiKey, opts.version),
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    return { kind: "no_answer", reason: err instanceof Error ? err.name : "fetch_failed" };
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = redactCalComApiKey(await res.text(), apiKey).slice(0, 300);
    } catch {
      // The status is what matters.
    }
    return { kind: "http", status: res.status, detail };
  }
  try {
    return { kind: "ok", status: res.status, json: await res.json() };
  } catch {
    return { kind: "no_answer", reason: "unreadable_body" };
  }
}

interface CalComEventTypesResponse {
  status?: string;
  data?: Array<{
    id: number;
    title?: string;
    lengthInMinutes?: number;
    recurrence?: { disabled?: boolean } | null;
  }>;
}

export interface CalComEventTypeInfo {
  id: number;
  title: string;
  durationMinutes: number | null;
  /**
   * True when this event type has an ACTIVE recurrence rule. Cal.com's
   * POST /v2/bookings returns an ARRAY of bookings (one per occurrence) for a
   * recurring event type; an appointment row holds one booking uid, so they
   * are rejected before booking.
   */
  recurring: boolean;
}

/**
 * The event types that belong to this API key's Cal.com account. Cal.com's
 * booking/slots endpoints accept ANY eventTypeId without checking ownership,
 * so the tools validate an id the model passes against this list. Returns
 * null on any failure — fail closed: callers reject the id.
 */
export async function listCalComEventTypes(
  apiKey: string,
): Promise<CalComEventTypeInfo[] | null> {
  const res = await calcomRequest(apiKey, "/v2/event-types", {
    version: CALCOM_API_VERSION.eventTypes,
    timeoutMs: CALCOM_READ_TIMEOUT_MS,
  });
  if (res.kind !== "ok") {
    if (res.kind === "http") console.error("[CalCom] event types", res.status, res.detail);
    return null;
  }
  const data = (res.json as CalComEventTypesResponse | null)?.data;
  if (!Array.isArray(data)) return null;
  return data
    .filter((et) => typeof et?.id === "number")
    .map((et) => ({
      id: et.id,
      title: typeof et.title === "string" ? et.title : `#${et.id}`,
      durationMinutes: typeof et.lengthInMinutes === "number" ? et.lengthInMinutes : null,
      recurring: !!et.recurrence && et.recurrence.disabled !== true,
    }));
}

export type CalComBookingState = "active" | "cancelled" | "other";

/** One booking as Cal.com has it now. */
export interface CalComBooking {
  uid: string;
  startMs: number;
  endMs: number | null;
  createdMs: number | null;
  /** Cal.com's own status: accepted, pending, cancelled, rejected. */
  status: string;
  state: CalComBookingState;
  eventTypeId: number | null;
  /** Where Cal.com says it was moved to, when it was rescheduled. */
  rescheduledToUid: string | null;
}

function stateOf(status: string): CalComBookingState {
  // `pending` waits for the host's confirmation: it holds the slot.
  if (status === "accepted" || status === "pending") return "active";
  if (status === "cancelled" || status === "rejected") return "cancelled";
  return "other";
}

function parseTime(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * A booking object from Cal.com (create, reschedule or read), or null when it
 * isn't one: an array (a recurring series) or no uid/start.
 */
export function parseCalComBooking(data: unknown): CalComBooking | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const b = data as Record<string, unknown>;
  const uid = typeof b.uid === "string" && b.uid ? b.uid : null;
  const startMs = parseTime(b.start);
  if (!uid || startMs === null) return null;
  const status = typeof b.status === "string" ? b.status.toLowerCase() : "";
  const eventType = b.eventType as { id?: unknown } | undefined;
  const eventTypeId =
    typeof eventType?.id === "number"
      ? eventType.id
      : typeof b.eventTypeId === "number"
        ? b.eventTypeId
        : null;
  return {
    uid,
    startMs,
    endMs: parseTime(b.end),
    createdMs: parseTime(b.createdAt),
    status,
    state: stateOf(status),
    eventTypeId,
    rescheduledToUid:
      typeof b.rescheduledToUid === "string" && b.rescheduledToUid ? b.rescheduledToUid : null,
  };
}

/**
 * One booking as Cal.com has it now, or null when Cal.com no longer has it
 * (404). Throws when that can't be known (any other failure, or a body that
 * isn't a single booking).
 */
export async function fetchCalComBooking(
  apiKey: string,
  uid: string,
): Promise<CalComBooking | null> {
  const res = await calcomRequest(apiKey, `/v2/bookings/${encodeURIComponent(uid)}`, {
    version: CALCOM_API_VERSION.bookings,
    timeoutMs: CALCOM_READ_TIMEOUT_MS,
  });
  if (res.kind === "http" && res.status === 404) return null;
  if (res.kind === "http") {
    console.error("[CalCom] booking lookup failed:", res.status, res.detail);
    throw new Error(`Cal.com respondió ${res.status}`);
  }
  if (res.kind === "no_answer") throw new Error(`Cal.com no respondió (${res.reason})`);
  const booking = parseCalComBooking((res.json as { data?: unknown } | null)?.data);
  if (!booking) throw new Error("Cal.com devolvió una reserva que no se pudo leer");
  return booking;
}
