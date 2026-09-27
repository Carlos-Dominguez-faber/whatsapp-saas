import type { SupabaseClient } from "@supabase/supabase-js";
import type { HLConfig } from "../../inbox/services/highlevel-client.ts";

/**
 * Locating the ONE appointment a customer confirmed, for cancel_highlevel and
 * reschedule_highlevel. Both tools take the appointment's date and time as the
 * customer confirmed it and act only on an appointment at that instant: a
 * retried call then finds that appointment already cancelled/moved and answers
 * so, instead of mutating the contact's NEXT appointment.
 */

/** Statuses of a booking that can still be cancelled or moved. */
const ACTIVE_STATUSES = new Set(["booked", "confirmed", "new", "active"]);

/** How far a stored start may be from the confirmed one and still match. */
const MATCH_TOLERANCE_MS = 60_000;

export type AppointmentState = "active" | "cancelled" | "other";

export interface LocatedAppointment {
  /** The local `appointments` row, when there is one. */
  localId: string | null;
  hlAppointmentId: string;
  state: AppointmentState;
}

function stateOf(status: string | null | undefined): AppointmentState {
  const s = (status ?? "").toLowerCase();
  if (ACTIVE_STATUSES.has(s)) return "active";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  return "other";
}

/**
 * Parses an ISO 8601 date-time that carries its own offset (or Z). Without an
 * offset the instant would depend on the server's zone, so it's refused.
 */
export function parseConfirmedInstant(iso: string): number | null {
  const trimmed = iso.trim();
  if (!/T\d{2}:\d{2}/.test(trimmed)) return null;
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) return null;
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The HighLevel wall-clock form ("2026-06-12 10:00:00") of an instant in the
 * calendar's zone — HighLevel's appointment times carry no offset.
 */
export function formatHLLocal(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

interface LocalRow {
  id: string;
  hl_appointment_id: string | null;
  status: string | null;
  scheduled_at: string;
}

/**
 * The contact's appointment starting at `instantMs`, from the local table.
 * An active match wins over a cancelled one at the same time.
 */
async function findLocalAt(
  supabase: SupabaseClient,
  workspaceId: string,
  contactId: string,
  instantMs: number,
): Promise<LocatedAppointment | null> {
  const { data, error } = await supabase
    .from("appointments")
    .select("id, hl_appointment_id, status, scheduled_at")
    .eq("workspace_id", workspaceId)
    .eq("contact_id", contactId)
    .not("hl_appointment_id", "is", null)
    .gte("scheduled_at", new Date(instantMs - MATCH_TOLERANCE_MS).toISOString())
    .lte("scheduled_at", new Date(instantMs + MATCH_TOLERANCE_MS).toISOString())
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) throw new Error(`appointments lookup failed: ${error.message}`);

  const rows = ((data as LocalRow[] | null) ?? []).filter(
    (r) => r.hl_appointment_id,
  );
  const pick =
    rows.find((r) => stateOf(r.status) === "active") ??
    rows.find((r) => stateOf(r.status) === "cancelled") ??
    rows[0];
  if (!pick?.hl_appointment_id) return null;
  return {
    localId: pick.id,
    hlAppointmentId: pick.hl_appointment_id,
    state: stateOf(pick.status),
  };
}

interface HLEvent {
  id: string;
  calendarId?: string | null;
  status?: string | null;
  appointmentStatus?: string | null;
  startTime?: string | null;
}

/**
 * The contact's appointment on the workspace's calendar starting at
 * `instantMs`, asked of HighLevel itself (GET /contacts/:id/appointments,
 * Version v3). Only with a configured calendar: without one, a contact's
 * appointment on some other calendar of the account could be the match.
 */
async function findInHighLevelAt(
  cfg: HLConfig,
  hlContactId: string,
  timeZone: string,
  instantMs: number,
): Promise<LocatedAppointment | null> {
  if (!cfg.calendarId) return null;
  const res = await fetch(
    `https://services.leadconnectorhq.com/contacts/${hlContactId}/appointments`,
    {
      headers: { Authorization: `Bearer ${cfg.token}`, Version: "v3" },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) {
    console.error(
      "[HL] contact appointments lookup failed:",
      res.status,
      (await res.text()).slice(0, 200),
    );
    throw new Error(`HighLevel respondió ${res.status}`);
  }
  const json = (await res.json()) as { events?: HLEvent[] };
  // Compared to the minute: HighLevel's wall clock has no offset.
  const target = formatHLLocal(instantMs, timeZone).slice(0, 16);
  const matches = (json.events ?? []).filter(
    (e) =>
      e.id &&
      e.calendarId === cfg.calendarId &&
      (e.startTime ?? "").slice(0, 16) === target,
  );
  const withState = matches.map((e) => ({
    e,
    state: stateOf(e.appointmentStatus ?? e.status),
  }));
  const pick =
    withState.find((m) => m.state === "active") ??
    withState.find((m) => m.state === "cancelled") ??
    withState[0];
  if (!pick) return null;
  return { localId: null, hlAppointmentId: pick.e.id, state: pick.state };
}

/**
 * Finds the conversation contact's appointment at `instantMs`: the local
 * table first, then HighLevel (only with a configured calendar). Throws when a
 * lookup itself fails, so the caller reports an error instead of "not found".
 */
export async function locateAppointmentAt(opts: {
  supabase: SupabaseClient;
  cfg: HLConfig;
  workspaceId: string;
  contactId: string;
  instantMs: number;
  timeZone: () => Promise<string>;
}): Promise<LocatedAppointment | null> {
  const local = await findLocalAt(
    opts.supabase,
    opts.workspaceId,
    opts.contactId,
    opts.instantMs,
  );
  if (local) return local;

  if (!opts.cfg.calendarId) return null;
  const { data: contact, error } = await opts.supabase
    .from("contacts")
    .select("hl_contact_id")
    .eq("id", opts.contactId)
    .eq("workspace_id", opts.workspaceId)
    .maybeSingle();
  if (error) throw new Error(`contact lookup failed: ${error.message}`);
  const hlContactId =
    (contact as { hl_contact_id: string | null } | null)?.hl_contact_id ?? null;
  if (!hlContactId) return null;

  return findInHighLevelAt(
    opts.cfg,
    hlContactId,
    await opts.timeZone(),
    opts.instantMs,
  );
}

/**
 * A date the model can read back to the customer, in the business's zone.
 */
export function describeInstant(ms: number, timeZone: string): string {
  return new Date(ms).toLocaleString("es-MX", {
    timeZone,
    dateStyle: "full",
    timeStyle: "short",
  });
}
