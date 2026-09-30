import type { SupabaseClient } from "@supabase/supabase-js";
import { formatWithOffset } from "@/shared/lib/timezone";
import {
  fetchCalComBooking,
  type CalComBooking,
} from "../../inbox/services/calcom-client.ts";
import { describeInstant } from "./hl-appointment.ts";

/**
 * Finding the ONE Cal.com booking a customer confirmed, for cancel_calcom,
 * reschedule_calcom, list_calcom_appointments and schedule_calcom's retry
 * check. Same design as hl-appointment.ts.
 *
 * Cal.com is the only source of truth. The local `appointments` rows with a
 * calcom_booking_uid only say WHICH bookings belong to the contact (the ones
 * booked through WhatsApp); each one is read from GET /v2/bookings/{uid},
 * whose instant and status decide what matches and what is shown. A booking
 * moved in Cal.com is cancelled there with `rescheduledToUid`: the read
 * follows it to where it lives now. Every read is written back to the local
 * rows, which are only a cache (the reminders read them).
 *
 * Bookings the contact made outside WhatsApp (Cal.com's own booking page)
 * are not in the cache, so these tools don't see them.
 */

/** Local statuses that are still live (see the CHECK on appointments). */
const LOCAL_ACTIVE_STATUSES = ["booked", "confirmed"];
/** Bookings read to find one at a time. */
const MAX_LOCATE_READS = 20;
/** Bookings read for the list, soonest first. */
const MAX_LIST_READS = 10;
/** Reschedules followed from a cached uid. */
const MAX_HOPS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How far a booking's start may be from the confirmed one and still match. */
const MATCH_TOLERANCE_MS = 60_000;
/** A cache write-back never holds the tool's answer longer than this. */
const WRITE_BACK_WAIT_MS = 2_000;

export interface CalComLookup {
  supabase: SupabaseClient;
  apiKey: string;
  workspaceId: string;
  contactId: string;
}

/** A cached row: which booking to read, and what it carries along a move. */
interface CachedRow {
  uid: string;
  conversationId: string | null;
  roughMs: number | null;
}

/** A booking as Cal.com has it now, and where the cached uid pointed. */
export interface ReadBooking {
  booking: CalComBooking;
  /** The start of the cached booking, before any move Cal.com recorded. */
  fromStartMs: number;
  /** Whether Cal.com moved it since it was cached. */
  moved: boolean;
}

function localStatusOf(booking: CalComBooking): string | null {
  if (booking.state === "active") return "booked";
  if (booking.state === "cancelled") return "cancelled";
  return null;
}

/**
 * Writes what Cal.com said about a booking to its local row (one per
 * workspace and uid), creating it when there is none. Never throws: the local
 * row is only a cache.
 */
export async function recordCalComLocally(
  opts: Pick<CalComLookup, "supabase" | "workspaceId" | "contactId">,
  booking: CalComBooking,
  extra: {
    conversationId?: string | null;
    /**
     * For a booking moved from a cached one: the original row's created_at.
     * The reminder scan requires a booking made with enough lead
     * (created_at <= due_at); a move is the same appointment, as HighLevel's
     * row keeps its created_at when it moves.
     */
    createdAt?: string | null;
    meta?: Record<string, unknown>;
  } = {},
): Promise<void> {
  try {
    const row: Record<string, unknown> = {
      workspace_id: opts.workspaceId,
      calcom_booking_uid: booking.uid,
      contact_id: opts.contactId,
      scheduled_at: new Date(booking.startMs).toISOString(),
    };
    const status = localStatusOf(booking);
    if (status) row.status = status;
    if (booking.eventTypeId !== null) row.calcom_event_type_id = booking.eventTypeId;
    if (extra.conversationId) row.conversation_id = extra.conversationId;
    if (extra.createdAt) row.created_at = extra.createdAt;
    if (extra.meta) {
      const { data } = await opts.supabase
        .from("appointments")
        .select("meta")
        .eq("workspace_id", opts.workspaceId)
        .eq("calcom_booking_uid", booking.uid)
        .maybeSingle();
      row.meta = {
        ...((data as { meta: Record<string, unknown> | null } | null)?.meta ?? {}),
        ...extra.meta,
      };
    }
    const { error } = await opts.supabase
      .from("appointments")
      .upsert(row, { onConflict: "workspace_id,calcom_booking_uid" });
    if (error) console.warn("[CalCom] local booking write-back failed:", error.message);
  } catch (err) {
    console.warn("[CalCom] local booking write-back failed:", err);
  }
}

/** Marks a cached booking cancelled, merging `meta`. Never throws. */
export async function markCalComCancelledLocally(
  opts: Pick<CalComLookup, "supabase" | "workspaceId">,
  uid: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  try {
    const { data } = await opts.supabase
      .from("appointments")
      .select("meta")
      .eq("workspace_id", opts.workspaceId)
      .eq("calcom_booking_uid", uid)
      .maybeSingle();
    const { error } = await opts.supabase
      .from("appointments")
      .update({
        status: "cancelled",
        meta: { ...((data as { meta: Record<string, unknown> | null } | null)?.meta ?? {}), ...meta },
      })
      .eq("workspace_id", opts.workspaceId)
      .eq("calcom_booking_uid", uid);
    if (error) console.warn("[CalCom] local booking cancel failed:", error.message);
  } catch (err) {
    console.warn("[CalCom] local booking cancel failed:", err);
  }
}

/**
 * The cached row a move started from: its conversation and created_at carry
 * over to the booking it moved to. Null when it can't be read.
 */
async function originRow(
  opts: Pick<CalComLookup, "supabase" | "workspaceId">,
  uid: string,
): Promise<{ conversation_id: string | null; created_at: string | null } | null> {
  try {
    const { data } = await opts.supabase
      .from("appointments")
      .select("conversation_id, created_at")
      .eq("workspace_id", opts.workspaceId)
      .eq("calcom_booking_uid", uid)
      .maybeSingle();
    return (data as { conversation_id: string | null; created_at: string | null } | null) ?? null;
  } catch {
    return null;
  }
}

/**
 * The booking behind a cached uid as Cal.com has it now, following the moves
 * Cal.com recorded (a rescheduled booking is cancelled with
 * `rescheduledToUid`). Null when Cal.com no longer has the cached uid (404).
 * Throws when that can't be known: a failed read, a 404 along a move, or
 * more than MAX_HOPS moves.
 *
 * The booking a move leads to is written to the cache as the same
 * appointment: with the conversation (the caller's, else the cached row's)
 * and the created_at of the row it moved from (else Cal.com's createdAt of
 * the original booking), so the reminder scan treats it like HighLevel's
 * moved row, not like a booking made just now.
 */
export async function readCalComBooking(
  opts: CalComLookup,
  cached: { uid: string; conversationId?: string | null },
): Promise<ReadBooking | null> {
  let uid = cached.uid;
  let fromStartMs: number | null = null;
  let originCreatedMs: number | null = null;
  const writes: Promise<void>[] = [];
  let result: ReadBooking | null = null;
  try {
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const booking = await fetchCalComBooking(opts.apiKey, uid);
      if (!booking) {
        if (hop === 0) return null;
        throw new Error("Cal.com no tiene la reserva a la que movió la cita");
      }
      if (fromStartMs === null) {
        fromStartMs = booking.startMs;
        originCreatedMs = booking.createdMs;
      }
      if (booking.state === "cancelled" && booking.rescheduledToUid) {
        writes.push(
          markCalComCancelledLocally(opts, booking.uid, { rescheduled_to: booking.rescheduledToUid }),
        );
        uid = booking.rescheduledToUid;
        continue;
      }
      if (hop === 0) {
        writes.push(
          recordCalComLocally(opts, booking, { conversationId: cached.conversationId ?? null }),
        );
      } else {
        const origin = await originRow(opts, cached.uid);
        writes.push(
          recordCalComLocally(opts, booking, {
            conversationId: cached.conversationId ?? origin?.conversation_id ?? null,
            createdAt:
              origin?.created_at ??
              (originCreatedMs !== null ? new Date(originCreatedMs).toISOString() : null),
            meta: { rescheduled_from: new Date(fromStartMs).toISOString() },
          }),
        );
      }
      result = { booking, fromStartMs, moved: hop > 0 };
      return result;
    }
    throw new Error("Cal.com movió la cita demasiadas veces para seguirla");
  } finally {
    // The cache must not hold the answer.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(writes),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, WRITE_BACK_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }
}

async function cachedRows(
  opts: CalComLookup,
  filter: { fromMs: number; toMs: number | null; liveOnly: boolean },
): Promise<CachedRow[]> {
  let query = opts.supabase
    .from("appointments")
    .select("calcom_booking_uid, conversation_id, scheduled_at")
    .eq("workspace_id", opts.workspaceId)
    .eq("contact_id", opts.contactId)
    .not("calcom_booking_uid", "is", null)
    .gte("scheduled_at", new Date(filter.fromMs).toISOString());
  if (filter.toMs !== null) query = query.lte("scheduled_at", new Date(filter.toMs).toISOString());
  if (filter.liveOnly) query = query.in("status", LOCAL_ACTIVE_STATUSES);
  const { data, error } = await query.order("scheduled_at", { ascending: true }).limit(50);
  if (error) throw new Error(`appointments lookup failed: ${error.message}`);
  const byUid = new Map<string, CachedRow>();
  for (const r of (data as Array<{
    calcom_booking_uid: string;
    conversation_id: string | null;
    scheduled_at: string;
  }> | null) ?? []) {
    byUid.set(r.calcom_booking_uid, {
      uid: r.calcom_booking_uid,
      conversationId: r.conversation_id,
      roughMs: Date.parse(r.scheduled_at),
    });
  }
  return [...byUid.values()];
}

/** Reads each cached row in parallel. A failed read is counted, never "cancelled". */
async function readAll(
  opts: CalComLookup,
  rows: CachedRow[],
): Promise<{ reads: ReadBooking[]; unreadable: number }> {
  const settled = await Promise.allSettled(rows.map((r) => readCalComBooking(opts, r)));
  const reads: ReadBooking[] = [];
  const seen = new Set<string>();
  let unreadable = 0;
  for (const result of settled) {
    if (result.status === "rejected") {
      console.error("[CalCom] booking read failed:", result.reason);
      unreadable++;
      continue;
    }
    // A 404 for a uid we booked: Cal.com deleted it. Nothing to match.
    if (result.value === null) continue;
    // Two cached uids can lead to the same booking after a move.
    if (seen.has(result.value.booking.uid)) continue;
    seen.add(result.value.booking.uid);
    reads.push(result.value);
  }
  return { reads, unreadable };
}

export type CalComLocateResult =
  | { kind: "found"; booking: CalComBooking }
  /** More than one live booking at that time. */
  | { kind: "ambiguous" }
  /** Only a cancelled one at that time. */
  | { kind: "already_cancelled" }
  /** At that time, but no longer live. */
  | { kind: "not_active" }
  /** No live match among what was read, and something wasn't. Unknown. */
  | { kind: "unconfirmed" }
  /**
   * Nothing at that time. `onlyUpcoming`: the contact's single upcoming
   * booking, when they have exactly one. `moved`: bookings cached near that
   * time that Cal.com has since moved (reschedule's retry check).
   */
  | { kind: "not_found"; onlyUpcoming: CalComBooking | null; moved: ReadBooking[] };

/**
 * The contact's booking at `instantMs`, as Cal.com has it now: every cached
 * booking within a day of it is read (up to MAX_LOCATE_READS). Throws when
 * the cache can't be read.
 */
export async function locateCalComBookingAt(
  opts: CalComLookup & { instantMs: number },
): Promise<CalComLocateResult> {
  const T = opts.instantMs;
  const near = (await cachedRows(opts, { fromMs: T - DAY_MS, toMs: T + DAY_MS, liveOnly: false }))
    .sort((a, b) => Math.abs((a.roughMs ?? T) - T) - Math.abs((b.roughMs ?? T) - T));
  const toRead = near.slice(0, MAX_LOCATE_READS);
  const capped = near.length - toRead.length;
  const { reads, unreadable } = await readAll(opts, toRead);

  const atTime = reads.filter((r) => Math.abs(r.booking.startMs - T) <= MATCH_TOLERANCE_MS);
  const live = atTime.filter((r) => r.booking.state === "active");
  if (live.length === 1) return { kind: "found", booking: live[0].booking };
  if (live.length > 1) return { kind: "ambiguous" };
  if (unreadable > 0 || capped > 0) return { kind: "unconfirmed" };
  if (atTime.some((r) => r.booking.state === "cancelled")) return { kind: "already_cancelled" };
  if (atTime.length > 0) return { kind: "not_active" };

  const moved = reads.filter(
    (r) => r.moved && Math.abs(r.fromStartMs - T) <= MATCH_TOLERANCE_MS,
  );
  let onlyUpcoming: CalComBooking | null = null;
  try {
    const upcoming = await listUpcomingCalComBookings(opts);
    if (upcoming.bookings.length === 1 && upcoming.unreadable === 0 && !upcoming.more) {
      onlyUpcoming = upcoming.bookings[0];
    }
  } catch (err) {
    // Only a hint.
    console.warn("[CalCom] upcoming lookup for the hint failed:", err);
  }
  return { kind: "not_found", onlyUpcoming, moved };
}

/**
 * The contact's upcoming live bookings, soonest first, as Cal.com has them
 * now: the cached live rows from a day ago on (a move can bring one
 * forward), each read and followed. A failed read is counted, not fatal.
 */
export async function listUpcomingCalComBookings(opts: CalComLookup): Promise<{
  bookings: CalComBooking[];
  unreadable: number;
  more: boolean;
}> {
  const now = Date.now();
  const rows = await cachedRows(opts, { fromMs: now - DAY_MS, toMs: null, liveOnly: true });
  const toRead = rows.slice(0, MAX_LIST_READS);
  const { reads, unreadable } = await readAll(opts, toRead);
  return {
    bookings: reads
      .map((r) => r.booking)
      .filter((b) => b.state === "active" && b.startMs >= now)
      .sort((a, b) => a.startMs - b.startMs),
    unreadable,
    more: rows.length > toRead.length,
  };
}

/**
 * For a "not found": the contact's only upcoming booking, so the model can
 * ask whether that's the one; else where to look.
 */
export function onlyUpcomingCalComHint(only: CalComBooking | null, zone: string): string {
  return only
    ? `Su única cita próxima es el ${describeInstant(only.startMs, zone)} (datetime_iso: ${formatWithOffset(only.startMs, zone)}): pregúntale si se refiere a esa. `
    : "Confirma con el cliente cuál es (list_calcom_appointments te da las suyas). ";
}
