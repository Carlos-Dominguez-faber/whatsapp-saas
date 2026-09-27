import type { SupabaseClient } from "@supabase/supabase-js";
import type { HLConfig } from "../../inbox/services/highlevel-client.ts";
import type { ToolContext } from "../core/tool";
import {
  formatWithOffset,
  wallClockOf,
  wallClockToInstant,
} from "@/shared/lib/timezone";

/**
 * Finding and changing the ONE appointment a customer confirmed, for
 * cancel_highlevel, reschedule_highlevel, list_highlevel_appointments and
 * schedule_highlevel's "slot taken" check.
 *
 * HighLevel is the only source of truth. With a calendar configured, the
 * contact's appointments come from GET /contacts/{id}/appointments (ids and
 * status; its times have no offset, so they only prefilter) and each one is
 * read from GET /calendars/events/appointments/{id}, whose instant, end and
 * status decide what matches, what is shown and how long it lasts. Every read
 * is written back to the local `appointments` row, which is only a cache.
 * Without a calendar, the local rows say which appointments to read.
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
const HL_VERSION_CONTACTS = "2021-07-28";

// Each HighLevel call has its own bound, and together they stay under the
// tools' budget, so a call times out here — where its outcome is handled —
// rather than in the registry, which would leave it running unseen.
const LOOKUP_TIMEOUT_MS = 7_000;
const EVENT_TIMEOUT_MS = 5_000;
/** The bound of one write (PUT here, POST in schedule_highlevel). */
export const WRITE_TIMEOUT_MS = 8_000;
/**
 * The registry's budget for schedule/cancel/reschedule: the contact's
 * appointments, their reads (in parallel), a second lookup when reschedule
 * checks for a retry, the write, and slack.
 */
export const APPOINTMENT_TOOL_TIMEOUT_MS = 30_000;
/** The list's budget: the contact's appointments and their reads. */
export const LIST_TOOL_TIMEOUT_MS = 15_000;
/** Appointments read from HighLevel per lookup, nearest first. */
const MAX_CANDIDATES = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

/** How far an appointment's start may be from the confirmed one and still match. */
const MATCH_TOLERANCE_MS = 60_000;

/**
 * Whether a write still fits the tool's budget (`budgetMs` from its start),
 * with ~2 s of slack. When it doesn't, the tool writes nothing and says so:
 * a write the registry cut off would leave its outcome unknown.
 */
export function hasTimeToWrite(startedAtMs: number, budgetMs: number): boolean {
  return startedAtMs + budgetMs - Date.now() >= WRITE_TIMEOUT_MS + 2_000;
}

const ACTIVE_STATUSES = new Set(["booked", "confirmed", "new", "active"]);

export type AppointmentState = "active" | "cancelled" | "other";

function stateOf(status: string | null | undefined): AppointmentState {
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

export type ConfirmedInstant =
  | { ms: number }
  /** The text isn't a date and time, or that time never exists in the zone. */
  | { error: "invalid" }
  /** Its offset isn't the zone's at that moment: copied from another zone. */
  | { error: "offset_mismatch" };

/**
 * The instant of a date and time the model passed, read in `timeZone` (the
 * scheduling zone, see scheduling-timezone.ts). With an explicit offset, the
 * instant it names must read, in that zone, as the same wall clock that was
 * written — slots and appointment lists carry that zone's offset, so a
 * mismatch means the text came from somewhere else, and nothing is guessed.
 * Without one, the wall clock is read in the zone (the first of a repeated
 * DST hour). February 30 and times skipped by a DST change never exist.
 */
export function parseConfirmedInstant(iso: string, timeZone: string): ConfirmedInstant {
  const text = iso.trim();
  const m = text.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i,
  );
  if (!m) return { error: "invalid" };
  const [, y, mo, d, h, mi, s, offset] = m;
  const wall = {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
    second: Number(s ?? 0),
  };
  const local = wallClockToInstant(wall, timeZone);
  if (local === null) return { error: "invalid" };
  if (!offset) return { ms: local };

  const explicit = Date.parse(text.replace(" ", "T"));
  if (Number.isNaN(explicit)) return { error: "invalid" };
  const read = wallClockOf(explicit, timeZone);
  const same =
    read.year === wall.year &&
    read.month === wall.month &&
    read.day === wall.day &&
    read.hour === wall.hour &&
    read.minute === wall.minute &&
    read.second === wall.second;
  return same ? { ms: explicit } : { error: "offset_mismatch" };
}

/** What to tell the model when parseConfirmedInstant refuses a date. */
export function confirmedInstantError(
  error: "invalid" | "offset_mismatch",
  timeZone: string,
): string {
  return error === "offset_mismatch"
    ? `La fecha no está en la zona horaria del negocio (${timeZone}). No la ajustes a mano: vuelve a consultar la disponibilidad o la lista de citas y copia la fecha exactamente como aparece.`
    : "Esa fecha y hora no es válida (formato ISO 8601, y que exista en el calendario). Confírmala con el cliente o consúltala otra vez.";
}

const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * A HighLevel time: with an offset (the event endpoint) it's the instant it
 * names, as written — HighLevel's own offset is authoritative, whatever the
 * wall clock reads in any zone; as a bare wall clock (the contact endpoint,
 * "2026-06-12 10:00:00" or with a 'T') it's read in `timeZone`.
 */
export function parseHLTime(value: unknown, timeZone: string): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  if (HAS_OFFSET.test(text)) {
    const ms = Date.parse(text.replace(" ", "T"));
    return Number.isNaN(ms) ? null : ms;
  }
  const parsed = parseConfirmedInstant(text, timeZone);
  return "ms" in parsed ? parsed.ms : null;
}

/**
 * The zone HighLevel's bare times (no offset) are read in: the location's,
 * when the integration has one configured, else the scheduling zone.
 * HighLevel doesn't document it; see the PR's manual checks.
 */
export function hlTimeZone(cfg: HLConfig, schedulingZone: string): string {
  return cfg.timezone ?? schedulingZone;
}

/** A date the model can read back to the customer, in the business's zone. */
export function describeInstant(ms: number, timeZone: string): string {
  return new Date(ms).toLocaleString("es-MX", {
    timeZone,
    dateStyle: "full",
    timeStyle: "short",
  });
}

/** One of the contact's appointments, as HighLevel's event endpoint has it. */
export interface HLAppointment {
  id: string;
  startMs: number;
  endMs: number | null;
  status: string;
  state: AppointmentState;
}

export interface AppointmentLookup {
  supabase: SupabaseClient;
  cfg: HLConfig;
  workspaceId: string;
  contactId: string;
  /** The zone of the contact endpoint's bare times: only for the prefilter. */
  hlZone: string;
}

/** Local appointment statuses that are still live (see the CHECK on appointments). */
const LOCAL_ACTIVE_STATUSES = ["booked", "confirmed"];

/** HighLevel's status → the local row's (CHECK on appointments). */
const LOCAL_STATUS: Record<string, string> = {
  new: "booked",
  booked: "booked",
  active: "booked",
  confirmed: "confirmed",
  cancelled: "cancelled",
  canceled: "cancelled",
  invalid: "cancelled",
  showed: "completed",
  noshow: "no_show",
};

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

interface HLContactEvent {
  id?: string;
  calendarId?: string | null;
  status?: string | null;
  appointmentStatus?: string | null;
  startTime?: string | null;
}

/**
 * The ids of the contact's appointments on the calendar to read, nearest to
 * `pivotMs` first, up to MAX_CANDIDATES: upcoming ones only, with a day of
 * margin because the endpoint's times have no offset and are read in
 * `hlZone` just to prefilter. `liveOnly` keeps the ones it lists as live.
 */
async function contactCandidates(
  opts: AppointmentLookup,
  pivotMs: number,
  liveOnly: boolean,
): Promise<{ ids: string[]; capped: number }> {
  const hlContactId = await hlContactIdOf(opts.supabase, opts.workspaceId, opts.contactId);
  if (!hlContactId) return { ids: [], capped: 0 };
  const res = await fetch(`${HL_API}/contacts/${hlContactId}/appointments`, {
    headers: { Authorization: `Bearer ${opts.cfg.token}`, Version: HL_VERSION_CONTACTS },
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
  const earliest = Date.now() - DAY_MS;
  const candidates: Array<{ id: string; distance: number }> = [];
  for (const e of json.events ?? []) {
    if (!e.id || e.calendarId !== opts.cfg.calendarId) continue;
    if (liveOnly && stateOf(e.appointmentStatus ?? e.status) !== "active") continue;
    const roughMs = parseHLTime(e.startTime, opts.hlZone);
    if (roughMs !== null && roughMs < earliest) continue;
    candidates.push({
      id: e.id,
      distance: roughMs === null ? Number.POSITIVE_INFINITY : Math.abs(roughMs - pivotMs),
    });
  }
  candidates.sort((a, b) => a.distance - b.distance);
  return {
    ids: candidates.slice(0, MAX_CANDIDATES).map((c) => c.id),
    capped: Math.max(0, candidates.length - MAX_CANDIDATES),
  };
}

/** Without a calendar: the local rows' HighLevel ids at `instantMs`. */
async function localIdsAt(opts: AppointmentLookup, instantMs: number): Promise<string[]> {
  const { data, error } = await opts.supabase
    .from("appointments")
    .select("hl_appointment_id")
    .eq("workspace_id", opts.workspaceId)
    .eq("contact_id", opts.contactId)
    .not("hl_appointment_id", "is", null)
    .gte("scheduled_at", new Date(instantMs - MATCH_TOLERANCE_MS).toISOString())
    .lte("scheduled_at", new Date(instantMs + MATCH_TOLERANCE_MS).toISOString())
    .limit(MAX_CANDIDATES);
  if (error) throw new Error(`appointments lookup failed: ${error.message}`);
  const ids = ((data as Array<{ hl_appointment_id: string }> | null) ?? []).map(
    (r) => r.hl_appointment_id,
  );
  return [...new Set(ids)];
}

/**
 * Writes what HighLevel said about an appointment to its local row (one per
 * workspace and HighLevel id), creating it when there is none. `meta` is
 * merged into the row's. Never throws: the local row is only a cache.
 */
export async function recordLocally(
  opts: Pick<AppointmentLookup, "supabase" | "workspaceId" | "contactId">,
  hlAppointmentId: string,
  fields: { scheduled_at?: string; status?: string; meta?: Record<string, unknown> },
): Promise<void> {
  try {
    const { meta, ...rest } = fields;
    const row: Record<string, unknown> = {
      workspace_id: opts.workspaceId,
      hl_appointment_id: hlAppointmentId,
      contact_id: opts.contactId,
      ...rest,
    };
    if (meta) {
      const { data } = await opts.supabase
        .from("appointments")
        .select("meta")
        .eq("workspace_id", opts.workspaceId)
        .eq("hl_appointment_id", hlAppointmentId)
        .maybeSingle();
      row.meta = { ...((data as { meta: Record<string, unknown> | null } | null)?.meta ?? {}), ...meta };
    }
    // A new row needs a time; without one only an existing row is updated.
    const { error } = rest.scheduled_at
      ? await opts.supabase
          .from("appointments")
          .upsert(row, { onConflict: "workspace_id,hl_appointment_id" })
      : await opts.supabase
          .from("appointments")
          .update(row)
          .eq("workspace_id", opts.workspaceId)
          .eq("hl_appointment_id", hlAppointmentId);
    if (error) console.warn("[HL] local appointment write-back failed:", error.message);
  } catch (err) {
    console.warn("[HL] local appointment write-back failed:", err);
  }
}

/** The local record of a move this tool made (reschedule's retry check). */
export async function localMetaOf(
  supabase: SupabaseClient,
  workspaceId: string,
  hlAppointmentId: string,
): Promise<Record<string, unknown>> {
  const { data } = await supabase
    .from("appointments")
    .select("meta")
    .eq("workspace_id", workspaceId)
    .eq("hl_appointment_id", hlAppointmentId)
    .maybeSingle();
  return (data as { meta: Record<string, unknown> | null } | null)?.meta ?? {};
}

/**
 * Reads each appointment from the event endpoint, in parallel, and writes
 * each answer back to its local row. `gone`: HighLevel no longer has it
 * (404). `unreadable`: the read failed, or came without a usable time.
 */
async function readAppointments(
  opts: AppointmentLookup,
  ids: string[],
): Promise<{ appointments: HLAppointment[]; gone: string[]; unreadable: number }> {
  const settled = await Promise.allSettled(
    ids.map((id) => fetchHLEvent(opts.cfg, id, opts.hlZone)),
  );
  const appointments: HLAppointment[] = [];
  const gone: string[] = [];
  let unreadable = 0;
  settled.forEach((result, i) => {
    if (result.status === "rejected") {
      unreadable++;
    } else if (result.value === null) {
      gone.push(ids[i]);
    } else if (result.value.startMs === null) {
      unreadable++;
    } else {
      appointments.push({ id: ids[i], ...result.value, startMs: result.value.startMs });
    }
  });
  await Promise.all([
    ...appointments.map((a) => {
      const status = LOCAL_STATUS[a.status];
      return recordLocally(opts, a.id, {
        scheduled_at: new Date(a.startMs).toISOString(),
        ...(status ? { status } : {}),
      });
    }),
    ...gone.map((id) => recordLocally(opts, id, { status: "cancelled" })),
  ]);
  return { appointments, gone, unreadable };
}

export type LocateResult =
  | { kind: "found"; appointment: HLAppointment }
  /** More than one live appointment at that time. */
  | { kind: "ambiguous" }
  /** Only a cancelled one at that time. */
  | { kind: "already_cancelled" }
  /** At that time, but no longer live (attended, no-show). */
  | { kind: "not_active"; appointment: HLAppointment }
  /** Some read failed and none of the rest is live at that time: unknown. */
  | { kind: "unconfirmed" }
  /** Nothing at that time; `onlyUpcoming` when the contact has exactly one. */
  | { kind: "not_found"; onlyUpcoming: HLAppointment | null };

/**
 * The contact's appointment at `instantMs`, as HighLevel has it now. Throws
 * when the contact's appointments can't be listed.
 */
export async function locateAppointmentAt(
  opts: AppointmentLookup & { instantMs: number },
): Promise<LocateResult> {
  const withCalendar = Boolean(opts.cfg.calendarId);
  const { ids, capped } = withCalendar
    ? await contactCandidates(opts, opts.instantMs, false)
    : { ids: await localIdsAt(opts, opts.instantMs), capped: 0 };
  const { appointments, gone, unreadable } = await readAppointments(opts, ids);

  const atTime = appointments.filter(
    (a) => Math.abs(a.startMs - opts.instantMs) <= MATCH_TOLERANCE_MS,
  );
  const live = atTime.filter((a) => a.state === "active");
  if (live.length === 1) return { kind: "found", appointment: live[0] };
  if (live.length > 1) return { kind: "ambiguous" };
  if (unreadable > 0) return { kind: "unconfirmed" };
  // Without a calendar the ids came from rows at that time: one HighLevel no
  // longer has was cancelled (deleted) there.
  if (atTime.some((a) => a.state === "cancelled") || (!withCalendar && gone.length > 0)) {
    return { kind: "already_cancelled" };
  }
  const other = atTime.find((a) => a.state === "other");
  if (other) return { kind: "not_active", appointment: other };
  const upcoming = appointments.filter((a) => a.state === "active" && a.startMs >= Date.now());
  return {
    kind: "not_found",
    onlyUpcoming: withCalendar && capped === 0 && upcoming.length === 1 ? upcoming[0] : null,
  };
}

/**
 * For a "not found": the contact's only upcoming appointment, so the model
 * can ask whether that's the one; else where to look.
 */
export function onlyUpcomingHint(only: HLAppointment | null, zone: string): string {
  return only
    ? `Su única cita próxima es el ${describeInstant(only.startMs, zone)} (datetime_iso: ${formatWithOffset(only.startMs, zone)}): pregúntale si se refiere a esa. `
    : "Confirma con el cliente cuál es (list_highlevel_appointments te da las suyas). ";
}

/**
 * The contact's upcoming live appointments, with the exact instant to copy
 * into cancel/reschedule, written in `zone`. With a calendar they are read
 * from HighLevel (a failed read is counted, not fatal); without one, the
 * local rows are listed.
 */
export async function listUpcomingAppointments(
  opts: AppointmentLookup & { zone: string },
): Promise<{
  appointments: Array<{ datetime_iso: string; cuando: string }>;
  unreadable: number;
  more: boolean;
}> {
  const now = Date.now();
  let instants: number[];
  let unreadable = 0;
  let more = false;
  if (opts.cfg.calendarId) {
    const { ids, capped } = await contactCandidates(opts, now, true);
    const read = await readAppointments(opts, ids);
    instants = read.appointments
      .filter((a) => a.state === "active" && a.startMs >= now)
      .map((a) => a.startMs);
    unreadable = read.unreadable;
    more = capped > 0;
  } else {
    const { data, error } = await opts.supabase
      .from("appointments")
      .select("scheduled_at")
      .eq("workspace_id", opts.workspaceId)
      .eq("contact_id", opts.contactId)
      .in("status", LOCAL_ACTIVE_STATUSES)
      .not("hl_appointment_id", "is", null)
      .gte("scheduled_at", new Date(now).toISOString())
      .order("scheduled_at", { ascending: true })
      .limit(MAX_CANDIDATES + 1);
    if (error) throw new Error(`appointments lookup failed: ${error.message}`);
    const rows = (data as Array<{ scheduled_at: string }> | null) ?? [];
    instants = rows.slice(0, MAX_CANDIDATES).map((r) => Date.parse(r.scheduled_at));
    more = rows.length > MAX_CANDIDATES;
  }
  return {
    appointments: instants
      .sort((x, y) => x - y)
      .map((ms) => ({
        datetime_iso: formatWithOffset(ms, opts.zone),
        cuando: describeInstant(ms, opts.zone),
      })),
    unreadable,
    more,
  };
}

interface HLEventDetails {
  startMs: number | null;
  endMs: number | null;
  /** HighLevel's own status ("confirmed", "showed"...). */
  status: string;
  state: AppointmentState;
}

/**
 * One appointment as HighLevel has it now, or null when HighLevel no longer
 * has it (404). Throws when that can't be known.
 */
async function fetchHLEvent(
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
  const status = (e.appointmentStatus ?? e.status ?? "").toLowerCase();
  return {
    startMs: parseHLTime(e.startTime, hlZone),
    endMs: parseHLTime(e.endTime, hlZone),
    status,
    state: stateOf(status),
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
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
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
