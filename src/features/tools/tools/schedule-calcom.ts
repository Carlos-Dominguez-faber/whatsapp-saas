import { createClient as createSbClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../core/tool";

const schema = z.object({
  event_type_id: z
    .number()
    .describe(
      "ID del tipo de evento de Cal.com (obtenido con list_event_types_calcom)",
    ),
  datetime_iso: z
    .string()
    .describe(
      "Inicio de la cita en ISO 8601 UTC, ej: 2026-06-12T15:00:00Z",
    ),
  attendee_name: z.string().describe("Nombre del cliente para la cita"),
  attendee_email: z
    .string()
    .email()
    .optional()
    .describe(
      "Email del cliente. Si no lo tienes y el contacto no tiene uno guardado, pídeselo por WhatsApp antes de llamar esta herramienta — Cal.com lo exige para crear la cita.",
    ),
});

type Args = z.infer<typeof schema>;

interface ContactRow {
  email: string | null;
}

interface CalComBookingResponse {
  status: string;
  // Cal.com's official docs (POST /v2/bookings) state `data` "can be either a
  // BookingOutput object or an array of RecurringBookingOutput objects" — an
  // array response means a recurring event type slipped past the recurrence
  // check below (or Cal.com added a new recurring variant). Reading `.uid`
  // off an array silently yields undefined, which this tool used to
  // misreport as "Cal.com omitted the uid".
  data?: { uid: string } | Array<{ uid: string }>;
}

async function run(args: Args, ctx: ToolContext): Promise<ToolResult> {
  const {
    getCalComConfig,
    calcomHeaders,
    CALCOM_BASE_URL,
    CALCOM_API_VERSION,
    listCalComEventTypeIds,
    redactCalComApiKey,
  } = await import("../../inbox/services/calcom-client.ts");

  const cfg = await getCalComConfig(ctx.workspaceId);
  if (!cfg) {
    return {
      ok: false,
      output: null,
      error: "Cal.com no está conectado para este workspace",
    };
  }

  const knownEventTypes = await listCalComEventTypeIds(cfg.apiKey);
  const matchedEventType = knownEventTypes?.find(
    (et) => et.id === args.event_type_id,
  );
  if (!matchedEventType) {
    return {
      ok: false,
      output: null,
      error:
        "event_type_id no corresponde a ningún tipo de evento de este workspace — usa list_event_types_calcom para obtener uno válido",
    };
  }
  if (matchedEventType.recurring) {
    return {
      ok: false,
      output: null,
      error:
        "Este tipo de evento es recurrente (crea varias citas en una sola reserva) y no está soportado para agendar por WhatsApp — usa un tipo de evento de una sola sesión, o pide al negocio que lo agende directamente en Cal.com",
    };
  }

  const supabase = createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  let email = args.attendee_email ?? null;
  if (!email && ctx.contactId) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("email")
      .eq("id", ctx.contactId)
      .single();
    // Contact may be returned as an object or wrapped in an array by test mocks
    const contactObj = Array.isArray(contact) ? contact[0] : contact;
    email = (contactObj as ContactRow | null)?.email ?? null;
  }

  if (!email) {
    return {
      ok: false,
      output: null,
      error:
        "Necesito el email del cliente para agendar en Cal.com — pídeselo antes de reintentar",
    };
  }

  // Slot claim: atomically reserve this exact (workspace, contact, instant)
  // slot in the local DB BEFORE calling Cal.com, via the unique index added
  // in migration 20260821010000_add_calcom_slot_claim_guard.sql. A plain
  // check-then-act read (this tool's first fix attempt) cannot prevent two
  // concurrent invocations from both passing the check and both calling
  // Cal.com — only a DB constraint enforced at INSERT time can. This
  // doesn't require Cal.com to support an
  // idempotency key (it doesn't — verified against the public API docs).
  let claimError: { code?: string; message: string } | null = null;
  let claimId: string | null = null;
  for (let attempt = 0; attempt <= 2; attempt++) {
    const { data: claimedRow, error } = await supabase
      .from("appointments")
      .insert({
        workspace_id: ctx.workspaceId,
        contact_id: ctx.contactId || null,
        conversation_id: ctx.conversationId,
        scheduled_at: args.datetime_iso,
        status: "booked",
        calcom_booking_uid: null,
        calcom_event_type_id: args.event_type_id,
      })
      .select("id")
      .single();
    claimError = error;
    if (!error) {
      claimId = (claimedRow as { id: string }).id;
      break;
    }
    // A conflict (23505, unique_violation) means someone already holds this
    // slot — retrying won't change that, stop immediately and resolve it
    // below instead of burning retries on a claim that will never succeed.
    if (error.code === "23505" || attempt === 2) break;
    await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
  }

  if (claimError) {
    if (claimError.code === "23505") {
      // Someone already claimed this exact slot — look up who, so the
      // response is honest instead of a blind "already booked" guess.
      let lookupQuery = supabase
        .from("appointments")
        .select("calcom_booking_uid, calcom_event_type_id")
        .eq("workspace_id", ctx.workspaceId)
        .eq("scheduled_at", args.datetime_iso)
        .in("status", ["booked", "confirmed"])
        .not("calcom_event_type_id", "is", null);
      lookupQuery = ctx.contactId
        ? lookupQuery.eq("contact_id", ctx.contactId)
        : lookupQuery.is("contact_id", null);
      const { data: existing } = await lookupQuery.limit(1).maybeSingle();
      const existingRow = existing as {
        calcom_booking_uid: string | null;
        calcom_event_type_id: number | null;
      } | null;

      if (existingRow?.calcom_booking_uid) {
        if (existingRow.calcom_event_type_id === args.event_type_id) {
          // The same request, retried from above (batch reprocessing, the
          // playground's transient-error retry, etc.) — return the booking
          // that already exists instead of creating a second one.
          return {
            ok: true,
            output: {
              booking_uid: existingRow.calcom_booking_uid,
              datetime: args.datetime_iso,
            },
          };
        }
        // A genuinely different service already occupies this exact slot
        // for this contact — a contact can't attend two things at once, so
        // this must not be reported as if the new request succeeded too.
        return {
          ok: false,
          output: null,
          error:
            "Este contacto ya tiene otra cita reservada para ese mismo horario con un servicio distinto — elige un horario diferente",
        };
      }

      // Either a concurrent request is mid-flight (claimed, booking not
      // confirmed yet) or an earlier attempt's claim got stuck without ever
      // reaching Cal.com (e.g. a crash between claim and booking) — either
      // way, an honest "try again shortly" beats a silent duplicate booking.
      return {
        ok: false,
        output: null,
        error:
          "Ya se está procesando una reserva para este horario — espera unos segundos e intenta de nuevo",
      };
    }
    return {
      ok: false,
      output: null,
      error: "No se pudo reservar el horario, intenta de nuevo en un momento",
    };
  }

  const res = await fetch(`${CALCOM_BASE_URL}/v2/bookings`, {
    method: "POST",
    headers: calcomHeaders(cfg.apiKey, CALCOM_API_VERSION.bookings),
    body: JSON.stringify({
      start: args.datetime_iso,
      eventTypeId: args.event_type_id,
      attendee: {
        name: args.attendee_name,
        email,
        timeZone: cfg.timezone,
      },
    }),
  });

  if (!res.ok) {
    // Nothing was actually booked in Cal.com — free the slot instead of
    // leaving a permanent claim that would block every future attempt at
    // this exact time.
    await supabase.from("appointments").delete().eq("id", claimId as string);
    const err = redactCalComApiKey(await res.text(), cfg.apiKey);
    return {
      ok: false,
      output: null,
      error: `Cal.com API error: ${res.status} ${err.slice(0, 150)}`,
    };
  }

  const data = (await res.json()) as CalComBookingResponse;

  if (Array.isArray(data.data)) {
    // A recurring event type should have been rejected above by the
    // event-type validation — reaching here means either that check missed
    // it (Cal.com metadata drifted) or Cal.com returned a recurring-series
    // response for a reason we didn't anticipate. Either way, this system
    // cannot represent a multi-booking series with one calcom_booking_uid
    // column, so fail loudly instead of silently reading `.uid` off an array
    // (undefined) and reporting a lost booking as a generic warning.
    console.error(
      "[schedule_calcom] Cal.com returned a recurring-series response (array) for what should have been a single booking",
    );
    try {
      await supabase.from("events").insert({
        type: "appointment_persist_failed",
        level: "error",
        workspace_id: ctx.workspaceId,
        conversation_id: ctx.conversationId,
        payload: {
          provider: "calcom",
          contact_id: ctx.contactId || null,
          scheduled_at: args.datetime_iso,
          error:
            "Cal.com returned an array (recurring booking series) instead of a single booking — this event type is not supported for WhatsApp booking",
          booking_uids: data.data.map((b) => b.uid),
        },
      });
    } catch (logErr) {
      console.warn("[schedule_calcom] events insert failed:", logErr);
    }
    return {
      ok: false,
      output: null,
      error:
        "Cal.com creó una serie de citas recurrentes en lugar de una sola — esto no está soportado, contacta directamente al negocio para gestionar esta reserva",
    };
  }

  const bookingUid = data.data?.uid ?? null;

  if (!bookingUid) {
    // The booking genuinely exists in Cal.com at this point — unlike
    // reschedule_calcom, we can't hard-fail without leaving an
    // unmanageable booking with no record at all. Surface it visibly
    // instead of silently persisting a row that the
    // .not("calcom_booking_uid", "is", null) filter will make invisible
    // to cancel_calcom/reschedule_calcom later.
    console.warn(
      "[schedule_calcom] Cal.com booking succeeded but the response omitted a uid",
    );
    try {
      await supabase.from("events").insert({
        type: "appointment_persist_failed",
        level: "error",
        workspace_id: ctx.workspaceId,
        conversation_id: ctx.conversationId,
        payload: {
          provider: "calcom",
          contact_id: ctx.contactId || null,
          scheduled_at: args.datetime_iso,
          error:
            "Cal.com booking succeeded but the response omitted data.uid — the appointment cannot be linked for later cancel/reschedule",
        },
      });
    } catch (logErr) {
      // Fire-and-forget: never let logging failures surface to caller
      console.warn("[schedule_calcom] events insert failed:", logErr);
    }
  }

  if (bookingUid) {
    // The claim row already exists (inserted before calling Cal.com) — this
    // just fills in the real uid. The Cal.com booking already succeeded and
    // must never be repeated, but a transient local DB blip here would
    // otherwise leave the claim stuck at calcom_booking_uid: null forever,
    // which any future request for this exact slot would then read as
    // "still in flight" rather than "booked". Retrying the LOCAL update
    // (not the remote booking) is safe — it's the same idempotent write
    // either way. This doesn't cover a sustained DB outage — that residual
    // case still falls through to the visible events-log below, unchanged
    // from before.
    let updateError: { message: string } | null = null;
    for (let attempt = 0; attempt <= 2; attempt++) {
      const { error } = await supabase
        .from("appointments")
        .update({ calcom_booking_uid: bookingUid })
        .eq("id", claimId as string);
      updateError = error;
      if (!error) break;
      if (attempt < 2)
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
    if (updateError) {
      // The booking already exists in Cal.com and can't be undone by this
      // failure alone — don't error out to the user over a cita that
      // actually did get booked. But do surface it visibly (not just
      // console.warn), since a swallowed update error here breaks
      // cancel_calcom/reschedule_calcom for this contact later.
      console.warn(
        "[schedule_calcom] failed to persist appointment:",
        updateError,
      );
      try {
        await supabase.from("events").insert({
          type: "appointment_persist_failed",
          level: "error",
          workspace_id: ctx.workspaceId,
          conversation_id: ctx.conversationId,
          payload: {
            provider: "calcom",
            calcom_booking_uid: bookingUid,
            contact_id: ctx.contactId || null,
            scheduled_at: args.datetime_iso,
            error: updateError.message,
          },
        });
      } catch (logErr) {
        // Fire-and-forget: never let logging failures surface to caller
        console.warn("[schedule_calcom] events insert failed:", logErr);
      }
    }
  }

  return {
    ok: true,
    output: bookingUid
      ? { booking_uid: bookingUid, datetime: args.datetime_iso }
      : {
          booking_uid: null,
          datetime: args.datetime_iso,
          warning:
            "La cita quedó agendada en Cal.com, pero no se recibió un ID de reserva para vincularla — avísale al cliente que la cita está confirmada, pero que si necesita cancelarla o reagendarla más adelante puede que no se pueda hacer automáticamente y haya que contactar directamente.",
        },
  };
}

export const scheduleCalComTool: Tool<Args> = {
  name: "schedule_calcom",
  description:
    "Reserva una cita directamente en el calendario de Cal.com. Antes de llamarlo, usa list_event_types_calcom para saber el event_type_id y check_availability_calcom para confirmar un horario real. Si no tienes el email del cliente, pídeselo en el chat primero — Cal.com lo exige para crear la cita.",
  sensitivity: "write",
  schema,
  enabledFor: () => true,
  run,
};
