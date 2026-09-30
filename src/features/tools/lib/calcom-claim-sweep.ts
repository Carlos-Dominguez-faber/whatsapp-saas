import { createClient as createSbClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  findCalComBookingAt,
  loadCalComConfig,
  type CalComConfig,
} from "../../inbox/services/calcom-client.ts";
import { isMissingFunctionError, reportMissingFunctionOnce } from "@/shared/lib/db-errors";
import { describeInstant, noteForTeam } from "./hl-appointment.ts";
import { getBusinessInfo } from "../../inbox/services/business-info.ts";
import { workspaceSchedulingTimeZone } from "../../inbox/services/scheduling-timezone.ts";
import type { ToolContext } from "../core/tool";

/**
 * Cal.com claims that may have booked and that nobody is asking about.
 *
 * schedule_calcom marks its claim 'sending' right before the POST and
 * 'unknown' when the POST gets no answer. If the function dies in between,
 * or the customer never asks for that slot again, the claim holds the slot
 * in silence while the booking may exist in Cal.com without its uid here.
 * The automations cron sweeps them: once a claim is older than
 * SWEEP_AFTER_MS, it asks Cal.com (findCalComBookingAt: attendee, event type
 * and start, checked locally) —
 *   found → the claim is linked to that booking;
 *   a complete "no" → the claim is released;
 *   anything else → an internal note in the conversation and an event, once.
 * A #15 claim (no marker) is swept the same way.
 */

export const SWEEP_AFTER_MS = 10 * 60_000;
const MAX_PER_TICK = 20;
/** Never start a claim's Cal.com lookup with less than this left. */
const MIN_REMAINING_MS = 10_000;

export interface CalComSweepTally {
  resolved: number;
  released: number;
  flagged: number;
  error?: string;
}

interface StaleClaim {
  id: string;
  workspace_id: string;
  conversation_id: string | null;
  scheduled_at: string;
  calcom_event_type_id: number | null;
  meta: Record<string, unknown> | null;
}

function svc(): SupabaseClient {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export async function sweepStaleCalComClaims(deadline: number): Promise<CalComSweepTally> {
  const tally: CalComSweepTally = { resolved: 0, released: 0, flagged: 0 };
  if (deadline - Date.now() < MIN_REMAINING_MS) return tally;
  const db = svc();
  // The partial index's own predicate lives in the function (20261003000017).
  const { data, error } = await db.rpc("stale_calcom_claims", {
    p_older_than_seconds: SWEEP_AFTER_MS / 1000,
    p_limit: MAX_PER_TICK,
  });
  if (error) {
    // Deployed before db-push: no function, so nothing to sweep yet. Not a
    // failed phase (it would turn every tick into a 500).
    if (isMissingFunctionError(error, "stale_calcom_claims")) {
      reportMissingFunctionOnce("stale_calcom_claims", "stale Cal.com claims are not swept");
      return tally;
    }
    console.error("[calcom-sweep] stale claims lookup failed:", error.message);
    return { ...tally, error: "calcom_sweep_lookup_failed" };
  }

  // null: Cal.com isn't connected; a read that failed skips the workspace's
  // claims this tick instead of reading as "not connected".
  const configs = new Map<string, CalComConfig | null | "unreadable">();
  for (const claim of (data as StaleClaim[] | null) ?? []) {
    if (deadline - Date.now() < MIN_REMAINING_MS) break;
    if (!configs.has(claim.workspace_id)) {
      try {
        configs.set(claim.workspace_id, await loadCalComConfig(claim.workspace_id));
      } catch (err) {
        console.error("[calcom-sweep] could not read the Cal.com integration:", err instanceof Error ? err.message : err);
        configs.set(claim.workspace_id, "unreadable");
      }
    }
    const loaded = configs.get(claim.workspace_id) ?? null;
    if (loaded === "unreadable") continue;
    const cfg = loaded;
    const report = async (why: string) => {
      let zone = "UTC";
      try {
        zone = await workspaceSchedulingTimeZone(claim.workspace_id, await getBusinessInfo(claim.workspace_id));
      } catch {
        // The note still goes out, in UTC.
      }
      if (await flag(db, claim, why, zone)) tally.flagged++;
    };
    const email = typeof claim.meta?.attendee_email === "string" ? claim.meta.attendee_email : "";
    if (!cfg || !email || claim.calcom_event_type_id === null) {
      await report(!cfg ? "Cal.com no está conectado" : "no se sabe con qué email se agendó");
      continue;
    }
    const found = await findCalComBookingAt(cfg.apiKey, {
      email,
      eventTypeId: claim.calcom_event_type_id,
      startMs: Date.parse(claim.scheduled_at),
    });
    if (found.kind === "found") {
      const { data: linked, error: linkError } = await asRead(
        db
          .from("appointments")
          .update({ calcom_booking_uid: found.booking.uid, status: "booked", meta: {} }),
        claim,
      ).select("id");
      if (!linkError && ((linked as unknown[] | null) ?? []).length === 1) tally.resolved++;
      else await report("no se pudo vincular la reserva que tiene Cal.com");
      continue;
    }
    // A #15 claim (no marker) sent the email as the customer wrote it: a "no"
    // for the lowercased email proves nothing.
    if (found.kind === "none" && typeof claim.meta?.calcom_claim !== "string") {
      await report("es una reserva de una versión anterior");
      continue;
    }
    if (found.kind === "none") {
      const { data: freed, error: releaseError } = await asRead(
        db
          .from("appointments")
          .update({ status: "cancelled", meta: { ...(claim.meta ?? {}), calcom_claim: "released" } }),
        claim,
      ).select("id");
      if (!releaseError && ((freed as unknown[] | null) ?? []).length === 1) {
        tally.released++;
        // A trail of what the sweep freed on its own.
        const { error: eventError } = await db.from("events").insert({
          type: "calcom_claim_released",
          level: "info",
          workspace_id: claim.workspace_id,
          conversation_id: claim.conversation_id,
          payload: { appointment_id: claim.id, scheduled_at: claim.scheduled_at },
        });
        if (eventError) console.error("[calcom-sweep] event failed:", eventError.message);
      }
      continue;
    }
    await report("Cal.com no dio una respuesta completa");
  }
  return tally;
}

/**
 * A write over the claim only as the sweep read it: still live, still
 * without a uid, and with the same marker (none, for a #15 claim). A claim
 * that changed meanwhile (its call linked it, a person released it) is left
 * alone.
 */
function asRead<Q extends { eq: any; is: any; in: any }>(query: Q, claim: StaleClaim): Q {
  const marker = claim.meta?.calcom_claim;
  let q = query
    .eq("id", claim.id)
    .eq("workspace_id", claim.workspace_id)
    .is("calcom_booking_uid", null)
    .in("status", ["booked", "confirmed"]);
  q = typeof marker === "string" ? q.eq("meta->>calcom_claim", marker) : q.is("meta->>calcom_claim", null);
  return q as Q;
}

/**
 * Marks the claim as swept (a compare-and-swap, so two ticks never both
 * report it) and, only if this tick marked it, leaves an internal note in
 * its conversation and an event. True when it was reported now.
 */
async function flag(
  db: SupabaseClient,
  claim: StaleClaim,
  why: string,
  zone: string,
): Promise<boolean> {
  const { data: marked, error } = await asRead(
    db.from("appointments").update({ meta: { ...(claim.meta ?? {}), calcom_swept: new Date().toISOString() } }),
    claim,
  )
    .is("meta->>calcom_swept", null)
    .select("id");
  if (error || ((marked as unknown[] | null) ?? []).length === 0) return false;

  const { error: eventError } = await db.from("events").insert({
    type: "calcom_claim_unresolved",
    level: "warn",
    workspace_id: claim.workspace_id,
    conversation_id: claim.conversation_id,
    payload: { appointment_id: claim.id, scheduled_at: claim.scheduled_at, reason: why },
  });
  if (eventError) console.error("[calcom-sweep] event failed:", eventError.message);
  if (claim.conversation_id) {
    await noteForTeam(
      db,
      { workspaceId: claim.workspace_id, conversationId: claim.conversation_id, contactId: "" } as ToolContext,
      "calcom_claim_unresolved",
      `Una reserva de Cal.com del ${describeInstant(Date.parse(claim.scheduled_at), zone)} quedó sin confirmar: la llamada se cortó al agendar y ${why}. Revisa en Cal.com si existe y libérala o vincúlala (ver INSTALAR).`,
    );
  }
  return true;
}
