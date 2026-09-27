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
const EVENT_TIMEOUT_MS = 5_000;
const PUT_TIMEOUT_MS = 8_000;
/**
 * The registry's budget for cancel/reschedule: the contact's appointments,
 * up to MAX_EVENT_CHECKS appointment reads, the PUT, and slack.
 */
export const APPOINTMENT_TOOL_TIMEOUT_MS = 30_000;
/** Candidates read from HighLevel, one by one, before a person is asked. */
const MAX_EVENT_CHECKS = 2;

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

export interface LocatedAppointment {
  /** The local `appointments` row, when there is one. */
  localId: string | null;
  /** Whether that local row is live (it may be cancelled while HighLevel's isn't). */
  localActive: boolean;
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

/** Local appointment statuses that are still live (see the CHECK on appointments). */
export const LOCAL_ACTIVE_STATUSES = ["booked", "confirmed"];

type Candidate = { state: AppointmentState } & LocatedAppointment;

async function localCandidatesAt(
  supabase: SupabaseClient,
  workspaceId: string,
  contactId: string,
  instantMs: number,
): Promise<Candidate[]> {
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
  return ((data as LocalRow[] | null) ?? [])
    .filter((r) => r.hl_appointment_id)
    .map((r) => ({
      localId: r.id,
      localActive: stateOf(r.status) === "active",
      hlAppointmentId: r.hl_appointment_id!,
      state: stateOf(r.status),
      meta: r.meta ?? {},
    }));
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
 * The conversation contact's candidates at `instantMs`: the local rows and,
 * with a configured calendar (without one, another calendar's appointment of
 * the same account could match), HighLevel's, merged by appointment id with
 * HighLevel's state winning — nothing syncs HighLevel's changes to the local
 * rows, so a local state can be stale either way. Throws when a lookup
 * fails, so the caller reports an error instead of "not found".
 */
async function candidatesAt(opts: {
  supabase: SupabaseClient;
  cfg: HLConfig;
  workspaceId: string;
  contactId: string;
  instantMs: number;
  hlZone: string;
}): Promise<Candidate[]> {
  const local = await localCandidatesAt(
    opts.supabase,
    opts.workspaceId,
    opts.contactId,
    opts.instantMs,
  );
  if (!opts.cfg.calendarId) return local;
  const hlContactId = await hlContactIdOf(opts.supabase, opts.workspaceId, opts.contactId);
  if (!hlContactId) return local;
  const events = await listHLContactEvents(opts.cfg, hlContactId, opts.hlZone);

  const merged = new Map<string, Candidate>(local.map((c) => [c.hlAppointmentId, c]));
  for (const e of events) {
    const known = merged.get(e.id);
    if (known) {
      merged.set(e.id, { ...known, state: e.state });
      continue;
    }
    if (Math.abs(e.startMs - opts.instantMs) > MATCH_TOLERANCE_MS) continue;
    merged.set(e.id, {
      localId: null,
      localActive: false,
      hlAppointmentId: e.id,
      state: e.state,
      meta: {},
    });
  }
  return [...merged.values()];
}

/** The contact's appointment at `instantMs`, from candidatesAt. */
export async function locateAppointmentAt(
  opts: Parameters<typeof candidatesAt>[0],
): Promise<LocateResult> {
  return pick(await candidatesAt(opts));
}

/** Marks the local rows of a HighLevel appointment cancelled. Never throws. */
export async function markLocalCancelled(
  supabase: SupabaseClient,
  workspaceId: string,
  hlAppointmentId: string,
): Promise<void> {
  const { error } = await supabase
    .from("appointments")
    .update({ status: "cancelled" })
    .eq("workspace_id", workspaceId)
    .eq("hl_appointment_id", hlAppointmentId);
  if (error) console.warn("[HL] failed to mark the local appointment cancelled:", error.message);
}

export type ConfirmedLocateResult =
  /** Nothing live at that time; `cancelledIds` are the ones HighLevel has cancelled or gone. */
  | { kind: "none"; cancelledIds: string[] }
  | { kind: "ambiguous" }
  /** HighLevel's current view of it: live, or "other" (attended, no-show). */
  | { kind: "found"; appointment: LocatedAppointment; event: HLEventDetails };

/**
 * The appointment at `instantMs`, confirmed with HighLevel before anything
 * acts on it: each candidate in question (the one picked, or every live one
 * when two are) is read from HighLevel. One HighLevel has cancelled or no
 * longer has (404) is synced to its local row and left out, and the rest are
 * picked from again — a stale row must neither hide the live appointment at
 * the same time nor make it look ambiguous, nor be reported as "already
 * cancelled" while that one stays booked. Throws when a lookup fails.
 */
export async function locateConfirmedAppointmentAt(
  opts: Parameters<typeof candidatesAt>[0],
): Promise<ConfirmedLocateResult> {
  const candidates = await candidatesAt(opts);
  const gone = new Set<string>();
  const confirmed = new Map<string, HLEventDetails>();
  for (let reads = 0; ; ) {
    const pool = candidates.filter((c) => !gone.has(c.hlAppointmentId));
    const found = pick(pool);
    if (found.kind === "none") return { kind: "none", cancelledIds: [...gone] };
    const inQuestion =
      found.kind === "found" ? [found] : pool.filter((c) => c.state === "active");
    const next = inQuestion.find((c) => !confirmed.has(c.hlAppointmentId));
    if (!next) {
      if (found.kind === "ambiguous") return found;
      const { kind: _kind, ...appointment } = found;
      return { kind: "found", appointment, event: confirmed.get(found.hlAppointmentId)! };
    }
    // Out of reads with something still unconfirmed: a person sorts it out.
    if (reads++ >= MAX_EVENT_CHECKS) return { kind: "ambiguous" };
    const event = await fetchHLEvent(opts.cfg, next.hlAppointmentId, opts.hlZone);
    if (!event || event.state === "cancelled") {
      await markLocalCancelled(opts.supabase, opts.workspaceId, next.hlAppointmentId);
      gone.add(next.hlAppointmentId);
      continue;
    }
    confirmed.set(next.hlAppointmentId, event);
    for (const c of candidates) {
      if (c.hlAppointmentId === next.hlAppointmentId) c.state = event.state;
    }
  }
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

/** How many appointments only HighLevel knows are read one by one for the list. */
const MAX_LISTED_HL_ONLY = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The contact's upcoming live appointments, with the exact instant to copy
 * into cancel/reschedule: local rows and, with a configured calendar,
 * HighLevel's, merged by appointment id. HighLevel's state wins, but not its
 * time from the contact endpoint, which comes without an offset: a local row
 * keeps its own instant, and one only HighLevel knows is read from the
 * appointment endpoint, which has the offset.
 */
export async function listUpcomingAppointments(opts: {
  supabase: SupabaseClient;
  cfg: HLConfig;
  workspaceId: string;
  contactId: string;
  zone: string;
  hlZone: string;
}): Promise<Array<{ datetime_iso: string; cuando: string }>> {
  const now = Date.now();
  const { data, error } = await opts.supabase
    .from("appointments")
    .select("hl_appointment_id, scheduled_at")
    .eq("workspace_id", opts.workspaceId)
    .eq("contact_id", opts.contactId)
    .in("status", LOCAL_ACTIVE_STATUSES)
    .not("hl_appointment_id", "is", null)
    .gte("scheduled_at", new Date(now).toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(20);
  if (error) throw new Error(`appointments lookup failed: ${error.message}`);

  const byId = new Map<string, number | null>();
  for (const r of (data as Array<{ hl_appointment_id: string; scheduled_at: string }> | null) ?? []) {
    byId.set(r.hl_appointment_id, Date.parse(r.scheduled_at));
  }
  if (opts.cfg.calendarId) {
    const hlContactId = await hlContactIdOf(opts.supabase, opts.workspaceId, opts.contactId);
    if (hlContactId) {
      const hlOnly: Array<{ id: string; roughMs: number }> = [];
      for (const e of await listHLContactEvents(opts.cfg, hlContactId, opts.hlZone)) {
        if (byId.has(e.id)) {
          // Cancelled (or attended) in HighLevel: gone, even if a local row says booked.
          if (e.state !== "active") byId.set(e.id, null);
        } else if (e.state === "active" && e.startMs >= now - DAY_MS) {
          // Upcoming even if its bare time was read a day off.
          hlOnly.push({ id: e.id, roughMs: e.startMs });
        }
      }
      const toRead = hlOnly.sort((x, y) => x.roughMs - y.roughMs).slice(0, MAX_LISTED_HL_ONLY);
      const events = await Promise.all(
        toRead.map((e) => fetchHLEvent(opts.cfg, e.id, opts.hlZone)),
      );
      toRead.forEach((e, i) => {
        const event = events[i];
        byId.set(e.id, event?.state === "active" ? event.startMs : null);
      });
    }
  }
  return [...byId.values()]
    .filter((ms): ms is number => ms !== null && !Number.isNaN(ms) && ms >= now)
    .sort((x, y) => x - y)
    .slice(0, 10)
    .map((ms) => ({
      datetime_iso: formatWithOffset(ms, opts.zone),
      cuando: describeInstant(ms, opts.zone),
    }));
}
