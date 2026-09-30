import { createClient as createSbClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult, ToolRunOptions } from "../core/tool";
import type { CalComBooking } from "../../inbox/services/calcom-client.ts";
import { formatWithOffset } from "@/shared/lib/timezone";
import {
  APPOINTMENT_TOOL_TIMEOUT_MS,
  confirmedInstantError,
  hasTimeToLookUp,
  hasTimeToWrite,
  noteForTeam,
  parseConfirmedInstant,
  UnknownOutcomeError,
  WRITE_TIMEOUT_MS,
} from "../lib/hl-appointment.ts";

const schema = z.object({
  event_type_id: z
    .number()
    .int()
    .describe("ID del tipo de evento de Cal.com (obtenido con list_event_types_calcom)"),
  datetime_iso: z
    .string()
    .describe(
      "Inicio de la cita, copiado exactamente de check_availability_calcom (ISO 8601 con su offset, ej: 2026-06-12T10:00:00-06:00).",
    ),
  attendee_name: z.string().trim().min(1).max(200).describe("Nombre del cliente para la cita"),
  attendee_email: z
    .string()
    .trim()
    .email()
    .optional()
    .describe(
      "Email del cliente. Si no lo tienes y el contacto no tiene uno guardado, pídeselo por WhatsApp antes de llamar esta herramienta: Cal.com lo exige para crear la cita.",
    ),
});

type Args = z.infer<typeof schema>;

/**
 * How long a claim without a booking uid is taken as its call still running
 * (the tool's budget is 30 s). Past it, a 'pending' claim (nothing sent) is
 * taken over by the next call; one that may have booked ('sending',
 * 'unknown', or a #15 claim) is freed only once Cal.com says there's no such
 * booking.
 */
export const CALCOM_CLAIM_TTL_SECONDS = 120;

/** For a booking the host still has to confirm. */
export const PENDING_NOTE =
  "La cita quedó SOLICITADA, pendiente de que el negocio la confirme. Díselo así al cliente: no le digas que ya está confirmada.";

const UNKNOWN_BOOKING =
  "No pude confirmar si la cita quedó agendada. No le digas al cliente que se agendó ni que falló: dile que una persona del equipo lo confirmará.";

/** Emails as a person types them in a chat message. */
const EMAIL_LIKE = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}/gi;

interface ClaimRow {
  claim_id: string | null;
  holder_id: string | null;
  holder_uid: string | null;
  holder_event_type_id: number | null;
  /** pending | sending | unknown | booked_without_uid | series | legacy (#15). */
  holder_claim: string | null;
  holder_age_seconds: number | null;
  /** The attendee email the holder's booking was sent with, if recorded. */
  holder_email: string | null;
}

/** Holders whose booking may exist in Cal.com: never freed without asking it. */
const MAYBE_BOOKED = new Set(["sending", "unknown", "legacy"]);

/** A tool answer that a person has to follow up: the buffer hands off after the reply. */
function needsHuman(error: string): ToolResult {
  return { ok: false, output: { needs_human: true }, error };
}

/** The contact's saved email, or null. */
async function contactEmail(
  supabase: SupabaseClient,
  workspaceId: string,
  contactId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("contacts")
    .select("email")
    .eq("id", contactId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const email = (data as { email: string | null } | null)?.email;
  return typeof email === "string" && email.trim() ? email.trim() : null;
}

async function run(args: Args, ctx: ToolContext, opts?: ToolRunOptions): Promise<ToolResult> {
  const startedAt = Date.now();
  const budgetMs = opts?.timeoutMs ?? APPOINTMENT_TOOL_TIMEOUT_MS;
  const {
    getCalComConfig,
    listCalComEventTypes,
    calcomRequest,
    parseCalComBooking,
    findCalComBookingAt,
    isSlotTaken,
    CALCOM_API_VERSION,
  } = await import("../../inbox/services/calcom-client.ts");
  const { getBusinessInfo } = await import("../../inbox/services/business-info.ts");
  const { workspaceSchedulingTimeZone } = await import("../../inbox/services/scheduling-timezone.ts");
  const { readCalComBooking } = await import("../lib/calcom-appointment.ts");

  const cfg = await getCalComConfig(ctx.workspaceId);
  if (!cfg) {
    return { ok: false, output: null, error: "Cal.com no está conectado para este workspace" };
  }

  // The slot as check_availability_calcom wrote it, in the same zone.
  const zone = await workspaceSchedulingTimeZone(ctx.workspaceId, await getBusinessInfo(ctx.workspaceId));
  const start = parseConfirmedInstant(args.datetime_iso, zone);
  if ("error" in start) {
    return { ok: false, output: null, error: confirmedInstantError(start.error, zone) };
  }
  if (start.ms < Date.now()) {
    return { ok: false, output: null, error: "Ese horario ya pasó; ofrécele uno futuro." };
  }
  const startIso = new Date(start.ms).toISOString();
  const startLocal = formatWithOffset(start.ms, zone);
  /**
   * What the model gets for a booking Cal.com has. One the host still has to
   * confirm is a request, and the model is told to say so.
   */
  const bookedOutput = (b: CalComBooking) => ({
    booking_uid: b.uid,
    datetime: formatWithOffset(b.startMs, zone),
    ...(b.pending ? { status: "pending", note: PENDING_NOTE } : {}),
  });

  // Cal.com books any eventTypeId, even another account's: only this key's own.
  const eventTypes = await listCalComEventTypes(cfg.apiKey);
  if (!eventTypes) {
    return {
      ok: false,
      output: null,
      error: "No pude consultar los servicios de Cal.com en este momento, así que la cita NO se agendó. Inténtalo de nuevo en un momento.",
    };
  }
  const eventType = eventTypes.find((et) => et.id === args.event_type_id);
  if (!eventType) {
    return {
      ok: false,
      output: null,
      error: "event_type_id no corresponde a ningún tipo de evento de este negocio: usa list_event_types_calcom para obtener uno válido.",
    };
  }
  if (eventType.seated) {
    return {
      ok: false,
      output: null,
      error: "Ese tipo de evento es con cupos (varias personas por horario) y no se puede agendar por WhatsApp todavía: usa uno individual, o pide al negocio que lo agende en Cal.com.",
    };
  }
  if (eventType.recurring) {
    return {
      ok: false,
      output: null,
      error: "Ese tipo de evento es recurrente (crea varias citas en una sola reserva) y no se puede agendar por WhatsApp: usa uno de una sola sesión, o pide al negocio que lo agende en Cal.com.",
    };
  }

  const supabase = createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // Who. In a real conversation it's the chat's contact, with the email the
  // customer gave (or the one saved). The playground has no contact: it books
  // only on an email the tester typed in this conversation, never one the
  // model came up with (a real person would get Cal.com's confirmations).
  const playground = !ctx.contactId ? ctx.playground : undefined;
  let email: string | null = args.attendee_email ?? null;
  let name = args.attendee_name;
  let traceId: string | null = null;
  if (playground) {
    const typed = new Set(
      playground.userMessages.flatMap((m) => m.match(EMAIL_LIKE) ?? []).map((e) => e.toLowerCase()),
    );
    if (!email || !typed.has(email.toLowerCase())) {
      return {
        ok: false,
        output: null,
        error: "Para probar el agendado en Cal.com, escribe en el chat el email de prueba.",
      };
    }
    name = `[Prueba] ${name}`;
    const { data: trace, error: traceError } = await supabase
      .from("events")
      .insert({
        type: "playground_write",
        level: "warn",
        workspace_id: ctx.workspaceId,
        payload: {
          user_id: playground.userId,
          tool: "schedule_calcom",
          email,
          start_time: startLocal,
          event_type_id: args.event_type_id,
          outcome: "attempted",
        },
      })
      .select("id")
      .single();
    if (traceError || !trace) {
      console.error("[schedule_calcom] playground trace failed:", traceError?.message);
      return {
        ok: false,
        output: null,
        error: "No pude registrar la prueba, así que la cita NO se agendó. Inténtalo de nuevo.",
      };
    }
    traceId = (trace as { id: string }).id;
  } else if (!ctx.contactId) {
    return { ok: false, output: null, error: "No hay un contacto en esta conversación para agendar." };
  } else if (!email) {
    email = await contactEmail(supabase, ctx.workspaceId, ctx.contactId);
  }
  if (!email) {
    return {
      ok: false,
      output: null,
      error: "Necesito el email del cliente para agendar en Cal.com: pídeselo y vuelve a intentarlo.",
    };
  }
  /** The playground trace's outcome. Never throws. */
  const traceOutcome = async (outcome: string, extra: Record<string, unknown> = {}) => {
    if (!traceId || !playground) return;
    const { error } = await supabase
      .from("events")
      .update({
        payload: {
          user_id: playground.userId,
          tool: "schedule_calcom",
          email,
          start_time: startLocal,
          event_type_id: args.event_type_id,
          outcome,
          ...extra,
        },
      })
      .eq("id", traceId)
      .eq("workspace_id", ctx.workspaceId);
    if (error) console.warn("[schedule_calcom] playground trace outcome failed:", error.message);
  };

  // Claim the slot BEFORE calling Cal.com (claim_calcom_slot, backed by a
  // unique index): a retried or concurrent call for the same contact and
  // instant finds the claim instead of booking twice. A claim older than the
  // TTL is taken over inside the same call.
  let claimId: string | null = null;
  for (let attempt = 0; attempt < 2 && !claimId; attempt++) {
    const { data, error } = await supabase.rpc("claim_calcom_slot", {
      p_workspace_id: ctx.workspaceId,
      p_contact_id: ctx.contactId || null,
      p_conversation_id: ctx.conversationId || null,
      p_scheduled_at: startIso,
      p_event_type_id: args.event_type_id,
      p_ttl_seconds: CALCOM_CLAIM_TTL_SECONDS,
    });
    const row = ((data as ClaimRow[] | null) ?? [])[0];
    if (error || !row) {
      console.error("[schedule_calcom] claim failed:", error?.message ?? "no row");
      await traceOutcome("not_sent", { reason: "claim_failed" });
      return {
        ok: false,
        output: null,
        error: "No pude reservar el horario en este momento, así que la cita NO se agendó. Inténtalo de nuevo en un momento.",
      };
    }
    if (row.claim_id) {
      claimId = row.claim_id;
      break;
    }

    // Someone holds this slot for this contact.
    const sameService = row.holder_event_type_id === args.event_type_id;
    const otherService: ToolResult = {
      ok: false,
      output: null,
      error: "El cliente ya tiene otra cita a esa hora con otro servicio, así que no se creó otra. Ofrécele otro horario.",
    };
    const heldUnconfirmed = async (why: string): Promise<ToolResult> => {
      await traceOutcome("not_sent", { reason: "slot_unconfirmed" });
      await noteForTeam(
        supabase,
        ctx,
        "calcom_appointment_unconfirmed",
        `El cliente pidió agendar el ${startLocal} en Cal.com y ya hay una reserva a su nombre a esa hora que no se pudo confirmar (${why}). Revísala en Cal.com.`,
      );
      return needsHuman(
        "No pude confirmar si el cliente ya tenía esa cita, así que no se agendó otra. No le digas que quedó agendada ni que falló: dile que una persona del equipo lo confirmará.",
      );
    };
    // The playground has no contact to read a booking for.
    if (!ctx.contactId && (row.holder_uid || row.holder_claim !== "pending")) {
      await traceOutcome("not_sent", { reason: "slot_held" });
      return {
        ok: false,
        output: null,
        error: "Ya hay una reserva de prueba a esa hora, así que no se hizo otra. Prueba con otro horario.",
      };
    }
    if (row.holder_uid) {
      // A booking this tool made (or the cache has) at that time: Cal.com
      // says whether it still stands. Never "already booked" without that.
      if (!hasTimeToLookUp(startedAt, budgetMs)) return heldUnconfirmed("sin tiempo para consultar");
      let read;
      try {
        read = await readCalComBooking(
          { supabase, apiKey: cfg.apiKey, workspaceId: ctx.workspaceId, contactId: ctx.contactId },
          { uid: row.holder_uid, conversationId: ctx.conversationId || null },
        );
      } catch (err) {
        console.error("[schedule_calcom] holder lookup failed:", err);
        return heldUnconfirmed("Cal.com no respondió");
      }
      const stands =
        read !== null &&
        read.booking.state === "active" &&
        Math.abs(read.booking.startMs - start.ms) <= 60_000;
      if (stands) {
        await traceOutcome("not_sent", { reason: "already_booked" });
        return sameService
          ? { ok: true, output: { ...bookedOutput(read!.booking), already_booked: true } }
          : otherService;
      }
      // Cancelled or moved in Cal.com: the read wrote that back, freeing the
      // slot. Claim again.
      if (read === null) {
        await supabase
          .from("appointments")
          .update({ status: "cancelled" })
          .eq("id", row.holder_id as string)
          .eq("workspace_id", ctx.workspaceId);
      }
      continue;
    }
    if (row.holder_claim === "booked_without_uid" || row.holder_claim === "series") {
      // Cal.com booked it, and nothing here can check it.
      return heldUnconfirmed("Cal.com la agendó sin devolver su referencia");
    }
    if (row.holder_claim && MAYBE_BOOKED.has(row.holder_claim)) {
      // Its call may still be running.
      if ((row.holder_age_seconds ?? 0) < CALCOM_CLAIM_TTL_SECONDS) {
        await traceOutcome("not_sent", { reason: "slot_held" });
        return {
          ok: false,
          output: null,
          error: "Ya se está procesando una reserva para ese horario, así que no se hizo otra. Espera unos segundos y vuelve a consultar.",
        };
      }
      // Its call is over and never learned whether Cal.com booked: Cal.com
      // says, by attendee, service and start. Only a complete "no" frees it.
      const lookupEmail = row.holder_email || email;
      if (row.holder_event_type_id === null || !hasTimeToLookUp(startedAt, budgetMs)) {
        return heldUnconfirmed("no se pudo consultar");
      }
      const found = await findCalComBookingAt(cfg.apiKey, {
        email: lookupEmail,
        eventTypeId: row.holder_event_type_id,
        startMs: start.ms,
      });
      if (found.kind === "unknown") return heldUnconfirmed("Cal.com no dio una respuesta completa");
      if (found.kind === "found") {
        // The booking exists: the claim becomes its cache row.
        await supabase
          .from("appointments")
          .update({
            calcom_booking_uid: found.booking.uid,
            status: "booked",
            meta: {},
          })
          .eq("id", row.holder_id as string)
          .eq("workspace_id", ctx.workspaceId)
          .is("calcom_booking_uid", null);
        await traceOutcome("not_sent", { reason: "already_booked" });
        return sameService
          ? { ok: true, output: { ...bookedOutput(found.booking), already_booked: true } }
          : otherService;
      }
      // Cal.com has nothing there: free the claim and claim again.
      await supabase
        .from("appointments")
        .update({ status: "cancelled", meta: { calcom_claim: "released" } })
        .eq("id", row.holder_id as string)
        .eq("workspace_id", ctx.workspaceId)
        .is("calcom_booking_uid", null);
      continue;
    }
    // A 'pending' claim within its TTL: its call hasn't sent anything yet.
    await traceOutcome("not_sent", { reason: "slot_held" });
    return {
      ok: false,
      output: null,
      error: "Ya se está procesando una reserva para ese horario, así que no se hizo otra. Espera unos segundos y vuelve a consultar.",
    };
  }
  if (!claimId) {
    await traceOutcome("not_sent", { reason: "claim_failed" });
    return {
      ok: false,
      output: null,
      error: "No pude reservar el horario en este momento, así que la cita NO se agendó. Inténtalo de nuevo en un momento.",
    };
  }

  /** Frees the claim: nothing was booked. Never throws. */
  const releaseClaim = async () => {
    const { error } = await supabase
      .from("appointments")
      .delete()
      .eq("id", claimId as string)
      .eq("workspace_id", ctx.workspaceId)
      .is("calcom_booking_uid", null);
    if (error) console.warn("[schedule_calcom] could not release the claim:", error.message);
  };
  /**
   * Marks what became of the claim (it keeps the slot), with the email the
   * booking goes out with: a later call asks Cal.com by it. True when the
   * mark was written.
   */
  const markClaim = async (state: string): Promise<boolean> => {
    const { data: marked, error } = await supabase
      .from("appointments")
      .update({ meta: { calcom_claim: state, attendee_email: email } })
      .eq("id", claimId as string)
      .eq("workspace_id", ctx.workspaceId)
      .is("calcom_booking_uid", null)
      .select("id");
    if (error) console.warn("[schedule_calcom] could not mark the claim:", error.message);
    return !error && ((marked as unknown[] | null) ?? []).length > 0;
  };

  // Nothing was sent yet: saying so is true.
  if (!hasTimeToWrite(startedAt, budgetMs)) {
    await releaseClaim();
    await traceOutcome("not_sent", { reason: "no_time" });
    return {
      ok: false,
      output: null,
      error: "El calendario tardó demasiado, así que la cita NO se agendó. Dile al cliente que lo intentas de nuevo en un momento.",
    };
  }

  // From here on the booking may exist: the claim says so before the POST,
  // so no later call can expire it as a dead one. Without that mark nothing
  // is sent.
  if (!(await markClaim("sending"))) {
    await releaseClaim();
    await traceOutcome("not_sent", { reason: "claim_mark_failed" });
    return {
      ok: false,
      output: null,
      error: "No pude reservar el horario en este momento, así que la cita NO se agendó. Inténtalo de nuevo en un momento.",
    };
  }

  const res = await calcomRequest(cfg.apiKey, "/v2/bookings", {
    method: "POST",
    version: CALCOM_API_VERSION.bookings,
    timeoutMs: WRITE_TIMEOUT_MS,
    body: {
      start: startIso,
      eventTypeId: args.event_type_id,
      attendee: { name, email, timeZone: zone },
    },
  });

  if (res.kind === "no_answer" || (res.kind === "http" && res.status >= 500)) {
    // Sent, and no answer: the booking may exist. The claim keeps the slot
    // until Cal.com says otherwise (see the holder handling above).
    console.error("[schedule_calcom] booking got no answer:", res.kind === "http" ? res.status : res.reason);
    await markClaim("unknown");
    await traceOutcome("unknown");
    await noteForTeam(
      supabase,
      ctx,
      "calcom_appointment_unconfirmed",
      `Se pidió agendar la cita del ${startLocal} en Cal.com y no hubo confirmación. Revisa si quedó agendada.`,
    );
    throw new UnknownOutcomeError(UNKNOWN_BOOKING);
  }

  if (res.kind === "http") {
    // Cal.com refused: nothing was booked.
    console.error(`[schedule_calcom] Cal.com ${res.status}:`, res.detail);
    await releaseClaim();
    await traceOutcome("refused", { status: res.status });
    if (res.status < 500 && isSlotTaken(res.detail)) {
      return {
        ok: false,
        output: null,
        error: "Ese horario ya no está disponible, así que la cita NO se agendó. Consulta otra vez check_availability_calcom y ofrécele al cliente otro horario.",
      };
    }
    await noteForTeam(
      supabase,
      ctx,
      "calcom_appointment_failed",
      `Cal.com rechazó agendar la cita del ${startLocal} (error ${res.status}). Revisa la integración.`,
    );
    return needsHuman(
      `El calendario de Cal.com respondió con un error (${res.status}); la cita NO se agendó. Dile al cliente que una persona del equipo lo revisará.`,
    );
  }

  // Booked: whatever happens next, it happened.
  const data = (res.json as { data?: unknown } | null)?.data;
  if (Array.isArray(data)) {
    // A recurring series slipped past the event-type check: it exists, and
    // one appointment row can't hold it.
    await markClaim("series");
    await traceOutcome("booked_series");
    await noteForTeam(
      supabase,
      ctx,
      "calcom_appointment_failed",
      `Cal.com creó una serie de citas recurrentes para el ${startLocal} en lugar de una sola. Revísala en Cal.com.`,
    );
    return needsHuman(
      "Cal.com creó una serie de citas en lugar de una sola. Dile al cliente que su cita quedó registrada y que una persona del equipo le confirmará los detalles.",
    );
  }
  const booking = parseCalComBooking(data);
  if (!booking) {
    await markClaim("booked_without_uid");
    await traceOutcome("booked", { booking_uid: null });
    await noteForTeam(
      supabase,
      ctx,
      "calcom_appointment_unconfirmed",
      `Cal.com agendó la cita del ${startLocal} pero no devolvió su referencia. Revisa que esté en el calendario; cancelarla o moverla desde WhatsApp no va a funcionar.`,
    );
    return {
      ok: true,
      output: {
        booking_uid: null,
        datetime: startLocal,
        warning:
          "La cita quedó agendada, pero si el cliente necesita cancelarla o moverla, una persona del equipo tendrá que hacerlo.",
      },
    };
  }

  // The claim becomes the booking's cache row. `status` too: a claim that
  // expired while this call was slow is live again (or, if another call took
  // the slot meanwhile, the unique index refuses it and a person is told). A
  // local failure can't undo the booking: it's surfaced, and the answer is
  // still success.
  let persistError: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: updated, error } = await supabase
      .from("appointments")
      .update({
        calcom_booking_uid: booking.uid,
        scheduled_at: new Date(booking.startMs).toISOString(),
        status: "booked",
        meta: {},
      })
      .eq("id", claimId)
      .eq("workspace_id", ctx.workspaceId)
      .select("id");
    if (!error && (updated as unknown[] | null)?.length) {
      persistError = null;
      break;
    }
    persistError = error?.message ?? "claim row gone";
    // Another claim holds the slot now: retrying won't change that.
    if (error?.code === "23505") break;
    if (attempt < 2) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
  }
  if (persistError) {
    console.warn("[schedule_calcom] failed to persist the booking:", persistError);
    await supabase.from("events").insert({
      type: "appointment_persist_failed",
      level: "error",
      workspace_id: ctx.workspaceId,
      conversation_id: ctx.conversationId || null,
      payload: {
        provider: "calcom",
        calcom_booking_uid: booking.uid,
        contact_id: ctx.contactId || null,
        scheduled_at: startIso,
        error: persistError,
      },
    });
    await noteForTeam(
      supabase,
      ctx,
      "calcom_appointment_unconfirmed",
      `Cal.com agendó la cita del ${startLocal}, pero no se pudo guardar aquí. Cancelarla o moverla desde WhatsApp no va a funcionar hasta que alguien la revise.`,
    );
  }

  await traceOutcome("booked", { booking_uid: booking.uid });
  return { ok: true, output: bookedOutput(booking) };
}

export const scheduleCalComTool: Tool<Args> = {
  name: "schedule_calcom",
  description:
    "Reserva una cita directamente en el calendario de Cal.com. Antes, usa list_event_types_calcom para saber el event_type_id y check_availability_calcom para ofrecer un horario real; copia su datetime_iso tal cual. Si no tienes el email del cliente, pídeselo primero: Cal.com lo exige. Solo confirma la cita si esta herramienta responde con éxito; si responde status \"pending\", la cita queda solicitada hasta que el negocio la confirme.",
  sensitivity: "write",
  schema,
  enabledFor: () => true,
  run,
  // Event types, the claim, maybe a booking read, and the booking itself.
  preferredTimeoutMs: APPOINTMENT_TOOL_TIMEOUT_MS,
};
