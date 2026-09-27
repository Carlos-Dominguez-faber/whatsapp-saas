import type { SupabaseClient } from "@supabase/supabase-js";
import type { HLConfig } from "../../inbox/services/highlevel-client.ts";
import type { ToolContext } from "../core/tool";
import {
  formatWithOffset,
  isIanaTimeZone,
  wallClockToInstant,
} from "@/shared/lib/timezone";

/**
 * Finding and changing the ONE appointment a customer confirmed, for
 * cancel_highlevel, reschedule_highlevel and list_highlevel_appointments.
 *
 * The cancel/reschedule tools take the appointment's date and time as the
 * customer confirmed it and act only on the contact's appointment at that
 * instant: a retried call then finds it already cancelled/moved and says so,
 * instead of acting on the contact's NEXT appointment.
 */

export const HL_API = "https://services.leadconnectorhq.com";
/** GET/PUT /calendars/events/appointments/{id} (HighLevel's OpenAPI spec). */
export const HL_VERSION_EVENTS = "2021-04-15";
/** GET /contacts/{id}/appointments (HighLevel's OpenAPI spec). */
export const HL_VERSION_CONTACTS = "2021-07-28";

// Each HighLevel call has its own bound, and together they stay under the
// tools' budget, so a call times out here — where its outcome is handled —
// rather than in the registry, which would leave it running unseen.
const LOOKUP_TIMEOUT_MS = 7_000;
const EVENT_TIMEOUT_MS = 6_000;
const PUT_TIMEOUT_MS = 8_000;
/** The registry's budget for cancel/reschedule (GET + GET + PUT, and slack). */
export const APPOINTMENT_TOOL_TIMEOUT_MS = 25_000;

/** How far a stored start may be from the confirmed one and still match. */
const MATCH_TOLERANCE_MS = 60_000;

const ACTIVE_STATUSES = new Set(["booked", "confirmed", "new", "active"]);

export type AppointmentState = "active" | "cancelled" | "other";

export function stateOf(status: string | null | undefined): AppointmentState {
  const s = (status ?? "").toLowerCase();
  if (ACTIVE_STATUSES.has(s)) return "active";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  return "other";
}

/**
 * Thrown when a change was sent and its outcome is unknown (HighLevel 5xx, a
 * timeout, a dropped connection): the appointment may or may not have changed.
 * The registry reports the tool as neither done nor failed, and the message
 * tells the model not to claim either.
 */
export class UnknownOutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownOutcomeError";
  }
}

/**
 * The instant a customer confirmed. The date and time are read as a wall
 * clock in the business's zone — the offset the model wrote is not trusted,
 * since it may be the one from today and not from that date (DST). Null when
 * the text isn't a date and time, or that time never exists there (February
 * 30, a time skipped by a DST change).
 */
export function parseConfirmedInstant(iso: string, timeZone: string): number | null {
  const m = iso
    .trim()
    .match(
      /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/i,
    );
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return wallClockToInstant(
    {
      year: Number(y),
      month: Number(mo),
      day: Number(d),
      hour: Number(h),
      minute: Number(mi),
      second: Number(s ?? 0),
    },
    timeZone,
  );
}

/**
 * A HighLevel time: with an offset (the event endpoint) it's an instant; as a
 * bare wall clock (the contact endpoint, "2026-06-12 10:00:00" or with a 'T')
 * it's read in `timeZone`.
 */
export function parseHLTime(value: unknown, timeZone: string): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(value.trim())) {
    const ms = Date.parse(value.trim());
    return Number.isNaN(ms) ? null : ms;
  }
  return parseConfirmedInstant(value, timeZone);
}

/**
 * The zone HighLevel's bare times are in: the location's, when the
 * integration has a real one configured, else the business's.
 */
export function hlTimeZone(cfg: HLConfig, businessTimeZone: string): string {
  return isIanaTimeZone(cfg.timezone) && cfg.timezone !== "UTC"
    ? cfg.timezone
    : businessTimeZone;
}

/** A date the model can read back to the customer, in the business's zone. */
export function describeInstant(ms: number, timeZone: string): string {
  return new Date(ms).toLocaleString("es-MX", {
    timeZone,
    dateStyle: "full",
    timeStyle: "short",
  });
}

export interface LocatedAppointment {
  /** The local `appointments` row, when there is one. */
  localId: string | null;
  hlAppointmentId: string;
  state: AppointmentState;
  meta: Record<string, unknown>;
}

export type LocateResult =
  | { kind: "none" }
  | { kind: "ambiguous" }
  | ({ kind: "found" } & LocatedAppointment);

interface LocalRow {
  id: string;
  hl_appointment_id: string | null;
  status: string | null;
  scheduled_at: string;
  meta: Record<string, unknown> | null;
}

function pick(
  candidates: Array<{ state: AppointmentState } & LocatedAppointment>,
): LocateResult {
  const active = candidates.filter((c) => c.state === "active");
  // Two live appointments at the same instant: acting on one of them could
  // be the wrong one, so nothing is changed.
  if (active.length > 1) return { kind: "ambiguous" };
  const chosen = active[0] ?? candidates.find((c) => c.state === "cancelled") ?? candidates[0];
  return chosen ? { kind: "found", ...chosen } : { kind: "none" };
}

async function findLocalAt(
  supabase: SupabaseClient,
  workspaceId: string,
  contactId: string,
  instantMs: number,
): Promise<LocateResult> {
  const { data, error } = await supabase
    .from("appointments")
    .select("id, hl_appointment_id, status, scheduled_at, meta")
    .eq("workspace_id", workspaceId)
    .eq("contact_id", contactId)
    .not("hl_appointment_id", "is", null)
    .gte("scheduled_at", new Date(instantMs - MATCH_TOLERANCE_MS).toISOString())
    .lte("scheduled_at", new Date(instantMs + MATCH_TOLERANCE_MS).toISOString())
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) throw new Error(`appointments lookup failed: ${error.message}`);
  return pick(
    ((data as LocalRow[] | null) ?? [])
      .filter((r) => r.hl_appointment_id)
      .map((r) => ({
        localId: r.id,
        hlAppointmentId: r.hl_appointment_id!,
        state: stateOf(r.status),
        meta: r.meta ?? {},
      })),
  );
}

interface HLContactEvent {
  id?: string;
  calendarId?: string | null;
  status?: string | null;
  appointmentStatus?: string | null;
  startTime?: string | null;
}

/** The contact's appointments on the workspace's calendar, from HighLevel. */
async function listHLContactEvents(
  cfg: HLConfig,
  hlContactId: string,
  timeZone: string,
): Promise<Array<{ id: string; startMs: number; state: AppointmentState }>> {
  const res = await fetch(`${HL_API}/contacts/${hlContactId}/appointments`, {
    headers: { Authorization: `Bearer ${cfg.token}`, Version: HL_VERSION_CONTACTS },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  if (!res.ok) {
    console.error(
      "[HL] contact appointments lookup failed:",
      res.status,
      (await res.text()).slice(0, 200),
    );
    throw new Error(`HighLevel respondió ${res.status}`);
  }
  const json = (await res.json()) as { events?: HLContactEvent[] };
  const out: Array<{ id: string; startMs: number; state: AppointmentState }> = [];
  for (const e of json.events ?? []) {
    if (!e.id || e.calendarId !== cfg.calendarId) continue;
    const startMs = parseHLTime(e.startTime, timeZone);
    if (startMs === null) continue;
    out.push({ id: e.id, startMs, state: stateOf(e.appointmentStatus ?? e.status) });
  }
  return out;
}

async function hlContactIdOf(
  supabase: SupabaseClient,
  workspaceId: string,
  contactId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("contacts")
    .select("hl_contact_id")
    .eq("id", contactId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw new Error(`contact lookup failed: ${error.message}`);
  return (data as { hl_contact_id: string | null } | null)?.hl_contact_id ?? null;
}

/**
 * The conversation contact's appointment at `instantMs`: the local table
 * first, then HighLevel — only with a configured calendar, since without one
 * another calendar's appointment of the same account could be the match.
 * Throws when a lookup itself fails, so the caller reports an error instead of
 * "not found".
 */
export async function locateAppointmentAt(opts: {
  supabase: SupabaseClient;
  cfg: HLConfig;
  workspaceId: string;
  contactId: string;
  instantMs: number;
  hlZone: string;
}): Promise<LocateResult> {
  const local = await findLocalAt(opts.supabase, opts.workspaceId, opts.contactId, opts.instantMs);
  if (local.kind !== "none") return local;

  if (!opts.cfg.calendarId) return { kind: "none" };
  const hlContactId = await hlContactIdOf(opts.supabase, opts.workspaceId, opts.contactId);
  if (!hlContactId) return { kind: "none" };

  const events = await listHLContactEvents(opts.cfg, hlContactId, opts.hlZone);
  return pick(
    events
      .filter((e) => Math.abs(e.startMs - opts.instantMs) <= MATCH_TOLERANCE_MS)
      .map((e) => ({ localId: null, hlAppointmentId: e.id, state: e.state, meta: {} })),
  );
}

export interface HLEventDetails {
  startMs: number | null;
  endMs: number | null;
  state: AppointmentState;
}

/**
 * One appointment as HighLevel has it now, or null when HighLevel no longer
 * has it (404). Throws when that can't be known.
 */
export async function fetchHLEvent(
  cfg: HLConfig,
  hlAppointmentId: string,
  hlZone: string,
): Promise<HLEventDetails | null> {
  const res = await fetch(`${HL_API}/calendars/events/appointments/${hlAppointmentId}`, {
    headers: { Authorization: `Bearer ${cfg.token}`, Version: HL_VERSION_EVENTS },
    signal: AbortSignal.timeout(EVENT_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    console.error("[HL] appointment lookup failed:", res.status, (await res.text()).slice(0, 200));
    throw new Error(`HighLevel respondió ${res.status}`);
  }
  const json = (await res.json()) as {
    event?: { startTime?: unknown; endTime?: unknown; appointmentStatus?: string; status?: string };
  };
  const e = json.event ?? {};
  return {
    startMs: parseHLTime(e.startTime, hlZone),
    endMs: parseHLTime(e.endTime, hlZone),
    state: stateOf(e.appointmentStatus ?? e.status),
  };
}

/**
 * Changes an appointment in HighLevel. `ok: false` means HighLevel refused
 * it and nothing changed (4xx). Throws UnknownOutcomeError when the change
 * may or may not have happened (5xx, timeout, network).
 */
export async function putHLEvent(
  cfg: HLConfig,
  hlAppointmentId: string,
  body: Record<string, unknown>,
  unknownMessage: string,
): Promise<{ ok: true } | { ok: false; status: number }> {
  let res: Response;
  try {
    res = await fetch(`${HL_API}/calendars/events/appointments/${hlAppointmentId}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Version: HL_VERSION_EVENTS,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
    });
  } catch (err) {
    console.error("[HL] appointment update got no answer:", err);
    throw new UnknownOutcomeError(unknownMessage);
  }
  if (res.ok) return { ok: true };
  // HighLevel's own wording (English, internal ids) stays in the logs.
  console.error(`[HL] appointment update ${res.status}:`, (await res.text()).slice(0, 300));
  if (res.status >= 500) throw new UnknownOutcomeError(unknownMessage);
  return { ok: false, status: res.status };
}

/**
 * Leaves an internal note in the conversation (never sent to the contact), so
 * a person learns that a scheduling change failed or is unconfirmed. One per
 * inbound batch and reason. Never throws.
 */
export async function noteForTeam(
  supabase: SupabaseClient,
  ctx: ToolContext,
  reason: string,
  body: string,
): Promise<void> {
  if (!ctx.conversationId) return;
  try {
    const marker = { internal: true, reason, ...(ctx.batchId ? { batch_id: ctx.batchId } : {}) };
    if (ctx.batchId) {
      const { data: existing } = await supabase
        .from("messages")
        .select("id")
        .eq("workspace_id", ctx.workspaceId)
        .eq("conversation_id", ctx.conversationId)
        .contains("meta", marker)
        .limit(1);
      if ((existing ?? []).length > 0) return;
    }
    const { error } = await supabase.from("messages").insert({
      workspace_id: ctx.workspaceId,
      conversation_id: ctx.conversationId,
      direction: "out",
      type: "system",
      body,
      status: "sent",
      meta: marker,
    });
    if (error) console.error("[HL] internal note failed:", error.message);
  } catch (err) {
    console.error("[HL] internal note failed:", err);
  }
}

/**
 * The contact's upcoming active appointments, with the exact instant to copy
 * into cancel/reschedule. Local rows first; HighLevel when there are none and
 * a calendar is configured.
 */
export async function listUpcomingAppointments(opts: {
  supabase: SupabaseClient;
  cfg: HLConfig;
  workspaceId: string;
  contactId: string;
  businessZone: string;
  hlZone: string;
}): Promise<Array<{ datetime_iso: string; cuando: string }>> {
  const now = Date.now();
  const { data, error } = await opts.supabase
    .from("appointments")
    .select("scheduled_at, status")
    .eq("workspace_id", opts.workspaceId)
    .eq("contact_id", opts.contactId)
    .in("status", ["booked", "confirmed"])
    .not("hl_appointment_id", "is", null)
    .gte("scheduled_at", new Date(now).toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(10);
  if (error) throw new Error(`appointments lookup failed: ${error.message}`);
  let instants = ((data as Array<{ scheduled_at: string }> | null) ?? []).map((r) =>
    Date.parse(r.scheduled_at),
  );

  if (instants.length === 0 && opts.cfg.calendarId) {
    const hlContactId = await hlContactIdOf(opts.supabase, opts.workspaceId, opts.contactId);
    if (hlContactId) {
      instants = (await listHLContactEvents(opts.cfg, hlContactId, opts.hlZone))
        .filter((e) => e.state === "active" && e.startMs >= now)
        .map((e) => e.startMs)
        .sort((a, b) => a - b)
        .slice(0, 10);
    }
  }
  return instants
    .filter((ms) => !Number.isNaN(ms))
    .map((ms) => ({
      datetime_iso: formatWithOffset(ms, opts.businessZone),
      cuando: describeInstant(ms, opts.businessZone),
    }));
}
