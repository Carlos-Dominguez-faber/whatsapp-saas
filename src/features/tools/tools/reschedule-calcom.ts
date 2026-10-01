import { createClient as createSbClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult, ToolRunOptions } from "../core/tool";
import { formatWithOffset } from "@/shared/lib/timezone";
import {
  APPOINTMENT_TOOL_TIMEOUT_MS,
  confirmedInstantError,
  describeInstant,
  hasTimeToWrite,
  noteForTeam,
  parseConfirmedInstant,
  UnknownOutcomeError,
  WRITE_TIMEOUT_MS,
} from "../lib/hl-appointment.ts";

const schema = z.object({
  appointment_datetime_iso: z
    .string()
    .describe(
      "Fecha y hora ACTUAL de la cita que el cliente quiere mover, copiada exactamente de list_calcom_appointments (ISO 8601 con su offset).",
    ),
  new_datetime_iso: z
    .string()
    .describe(
      "Nuevo inicio que el cliente confirmó, copiado exactamente de check_availability_calcom (ISO 8601 con su offset).",
    ),
});

type Args = z.infer<typeof schema>;

/** A tool answer that a person has to follow up: the buffer hands off after the reply. */
function needsHuman(error: string): ToolResult {
  return { ok: false, output: { needs_human: true }, error };
}

const UNCONFIRMED =
  "No pude confirmar la cita en el calendario en este momento, así que NO se movió. Dile al cliente que una persona del equipo lo revisará.";

const UNKNOWN_MOVE =
  "No pude confirmar si la cita se movió. No le digas al cliente que quedó reagendada ni que falló: dile que una persona del equipo lo confirmará.";

async function run(args: Args, ctx: ToolContext, opts?: ToolRunOptions): Promise<ToolResult> {
  const startedAt = Date.now();
  const budgetMs = opts?.timeoutMs ?? APPOINTMENT_TOOL_TIMEOUT_MS;
  const { getCalComConfig, calcomRequest, parseCalComBooking, isSlotTaken, CALCOM_API_VERSION } =
    await import("../../inbox/services/calcom-client.ts");
  const { getBusinessInfo } = await import("../../inbox/services/business-info.ts");
  const { workspaceSchedulingTimeZone } = await import("../../inbox/services/scheduling-timezone.ts");
  const {
    locateCalComBookingAt,
    markCalComCancelledLocally,
    onlyUpcomingCalComHint,
    recordCalComLocally,
  } = await import("../lib/calcom-appointment.ts");

  const cfg = await getCalComConfig(ctx.workspaceId);
  if (!cfg) {
    return { ok: false, output: null, error: "Cal.com no está conectado para este workspace" };
  }
  if (!ctx.contactId) {
    return {
      ok: false,
      output: null,
      error: "No hay un contacto real en esta conversación; no se puede reagendar una cita.",
    };
  }

  const zone = await workspaceSchedulingTimeZone(ctx.workspaceId, await getBusinessInfo(ctx.workspaceId));
  const current = parseConfirmedInstant(args.appointment_datetime_iso, zone);
  if ("error" in current) {
    return { ok: false, output: null, error: confirmedInstantError(current.error, zone) };
  }
  const next = parseConfirmedInstant(args.new_datetime_iso, zone);
  if ("error" in next) {
    return { ok: false, output: null, error: confirmedInstantError(next.error, zone) };
  }
  const currentMs = current.ms;
  const newMs = next.ms;
  if (currentMs === newMs) {
    return { ok: false, output: null, error: "La nueva fecha es la misma que la actual; no hay nada que mover." };
  }
  const now = Date.now();
  if (currentMs < now) {
    return {
      ok: false,
      output: null,
      error: `La cita del ${describeInstant(currentMs, zone)} ya pasó; no se puede mover.`,
    };
  }
  if (newMs < now) {
    return { ok: false, output: null, error: "El nuevo horario ya pasó; ofrécele uno futuro." };
  }

  const supabase = createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const when = describeInstant(currentMs, zone);
  const newLocal = formatWithOffset(newMs, zone);
  const lookup = {
    supabase,
    apiKey: cfg.apiKey,
    workspaceId: ctx.workspaceId,
    contactId: ctx.contactId,
  };
  const unconfirmed = async (err?: unknown) => {
    if (err) console.error("[reschedule_calcom] lookup failed:", err);
    await noteForTeam(
      supabase,
      ctx,
      "calcom_appointment_failed",
      `El cliente pidió mover su cita del ${when} y no se pudo confirmar en Cal.com. Revísalo tú.`,
    );
    return needsHuman(UNCONFIRMED);
  };

  // Cal.com's current view: the local rows are only a cache.
  let located;
  try {
    located = await locateCalComBookingAt({ ...lookup, instantMs: currentMs });
  } catch (err) {
    return unconfirmed(err);
  }

  switch (located.kind) {
    case "unconfirmed":
      return unconfirmed();
    case "ambiguous":
      await noteForTeam(
        supabase,
        ctx,
        "calcom_appointment_failed",
        `El cliente pidió mover su cita del ${when}, pero tiene más de una a esa hora en Cal.com. No se movió ninguna: revísalo tú.`,
      );
      return needsHuman(
        "El cliente tiene más de una cita a esa hora, así que no se movió ninguna. Dile que una persona del equipo lo revisará.",
      );
    case "already_cancelled":
      return {
        ok: false,
        output: null,
        error: "Esa cita está cancelada, así que no se puede mover. Si el cliente quiere una nueva, agéndala.",
      };
    case "not_active":
      return {
        ok: false,
        output: null,
        error: "Esa cita ya no está activa, así que no se puede mover.",
      };
    case "not_found": {
      // A retry of a move that went through: Cal.com moved the booking cached
      // at the current time to the new one, and it's live there.
      const done = located.moved.find(
        (m) => m.booking.state === "active" && Math.abs(m.booking.startMs - newMs) <= 60_000,
      );
      if (done) {
        return {
          ok: true,
          output: { rescheduled: true, already_rescheduled: true, new_datetime: newLocal },
        };
      }
      return {
        ok: false,
        output: null,
        error: `No encontré una cita activa del cliente el ${when}. ${onlyUpcomingCalComHint(located.onlyUpcoming, zone)}No le digas que se reagendó.`,
      };
    }
  }

  const { booking } = located;
  // Nothing was written yet: saying so is true.
  if (!hasTimeToWrite(startedAt, budgetMs)) {
    return {
      ok: false,
      output: null,
      error: "El calendario tardó demasiado, así que la cita NO se movió. Dile al cliente que lo intentas de nuevo en un momento.",
    };
  }

  // Cal.com keeps the event type's length, and moves the booking to a new
  // one (a new uid); the old one stays cancelled with rescheduledToUid.
  const res = await calcomRequest(
    cfg.apiKey,
    `/v2/bookings/${encodeURIComponent(booking.uid)}/reschedule`,
    {
      method: "POST",
      version: CALCOM_API_VERSION.bookings,
      timeoutMs: WRITE_TIMEOUT_MS,
      body: {
        start: new Date(newMs).toISOString(),
        reschedulingReason: "Reagendada por el cliente por WhatsApp",
      },
    },
  );

  if (res.kind === "no_answer" || (res.kind === "http" && res.status >= 500)) {
    console.error("[reschedule_calcom] reschedule got no answer:", res.kind === "http" ? res.status : res.reason);
    await noteForTeam(
      supabase,
      ctx,
      "calcom_appointment_unconfirmed",
      `Se pidió mover la cita del ${when} en Cal.com y no hubo confirmación. Revisa en qué horario quedó.`,
    );
    throw new UnknownOutcomeError(UNKNOWN_MOVE);
  }
  if (res.kind === "http") {
    console.error(`[reschedule_calcom] Cal.com ${res.status}:`, res.detail);
    if (isSlotTaken(res.detail)) {
      return {
        ok: false,
        output: null,
        error: "Ese nuevo horario ya no está disponible, así que la cita NO se movió. Consulta otra vez check_availability_calcom y ofrécele otro.",
      };
    }
    await noteForTeam(
      supabase,
      ctx,
      "calcom_appointment_failed",
      `Cal.com rechazó mover la cita del ${when} (error ${res.status}). Revísalo tú.`,
    );
    return needsHuman(
      `El calendario respondió con un error (${res.status}); la cita NO se movió. Dile al cliente que una persona del equipo lo revisará.`,
    );
  }

  // Moved: whatever happens next, that's the answer.
  const moved = parseCalComBooking((res.json as { data?: unknown } | null)?.data);
  if (moved) {
    const { data: oldRow } = await supabase
      .from("appointments")
      .select("conversation_id, created_at")
      .eq("workspace_id", ctx.workspaceId)
      .eq("calcom_booking_uid", booking.uid)
      .maybeSingle();
    const old = oldRow as { conversation_id: string | null; created_at: string | null } | null;
    await markCalComCancelledLocally(lookup, booking.uid, { rescheduled_to: moved.uid });
    // The same appointment at a new time: its conversation and created_at
    // carry over (the reminder scan needs both).
    await recordCalComLocally(lookup, moved, {
      conversationId: old?.conversation_id ?? (ctx.conversationId || null),
      createdAt: old?.created_at ?? null,
      meta: { rescheduled_from: new Date(currentMs).toISOString() },
    });
  } else {
    // Without the new booking in the answer, the old row stays as it is: the
    // next read follows Cal.com's rescheduledToUid from it to the new one.
    console.warn("[reschedule_calcom] Cal.com moved the booking without returning the new one");
  }

  // A move the host still has to confirm is a request.
  return {
    ok: true,
    output: {
      rescheduled: true,
      new_datetime: newLocal,
      ...(moved?.pending
        ? {
            status: "pending",
            note: "El cambio quedó SOLICITADO, pendiente de que el negocio lo confirme. Díselo así al cliente.",
          }
        : {}),
    },
  };
}

export const rescheduleCalComTool: Tool<Args> = {
  name: "reschedule_calcom",
  description:
    "Mueve en Cal.com la cita del cliente que hoy empieza en appointment_datetime_iso a new_datetime_iso. Úsala solo cuando el cliente haya confirmado cuál cita mover (list_calcom_appointments) y el nuevo horario (check_availability_calcom); copia las fechas exactamente como las dieron esas herramientas. Solo confirma el cambio si esta herramienta responde con éxito; si no encuentra la cita, falla o no pudo confirmar, dile la verdad.",
  sensitivity: "write",
  schema,
  enabledFor: () => true,
  run,
  preferredTimeoutMs: APPOINTMENT_TOOL_TIMEOUT_MS,
};
