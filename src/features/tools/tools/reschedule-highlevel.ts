import { createClient as createSbClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../core/tool";
import { formatWithOffset } from "@/shared/lib/timezone";
import {
  APPOINTMENT_TOOL_TIMEOUT_MS,
  describeInstant,
  fetchHLEvent,
  hlTimeZone,
  locateAppointmentAt,
  noteForTeam,
  parseConfirmedInstant,
  putHLEvent,
} from "../lib/hl-appointment.ts";

const schema = z.object({
  appointment_datetime_iso: z
    .string()
    .describe(
      "Fecha y hora ACTUAL de la cita que el cliente quiere mover, en ISO 8601 (ej: 2026-06-12T10:00:00-06:00). Cópiala de list_highlevel_appointments.",
    ),
  new_datetime_iso: z
    .string()
    .describe(
      "Nuevo inicio de la cita que el cliente confirmó, en ISO 8601 (ej: 2026-06-15T16:00:00-06:00).",
    ),
});

type Args = z.infer<typeof schema>;

const LOOKUP_FAILED =
  "No pude consultar la agenda en este momento, así que la cita NO se movió. Dile al cliente que una persona del equipo lo revisará.";

/** Same instant, within a minute. */
function sameInstant(a: unknown, ms: number): boolean {
  const parsed = typeof a === "string" ? Date.parse(a) : Number.NaN;
  return !Number.isNaN(parsed) && Math.abs(parsed - ms) <= 60_000;
}

async function run(args: Args, ctx: ToolContext): Promise<ToolResult> {
  const { getHLConfig } = await import("../../inbox/services/highlevel-client.ts");
  const { getBusinessInfo, businessTimeZone } = await import(
    "../../inbox/services/business-info.ts"
  );

  const cfg = await getHLConfig(ctx.workspaceId);
  if (!cfg) {
    return { ok: false, output: null, error: "HighLevel no está conectado para este workspace" };
  }
  if (!ctx.contactId) {
    return {
      ok: false,
      output: null,
      error: "No hay un contacto real en esta conversación; no se puede reagendar una cita.",
    };
  }

  const zone = businessTimeZone(await getBusinessInfo(ctx.workspaceId));
  const hlZone = hlTimeZone(cfg, zone);
  const currentMs = parseConfirmedInstant(args.appointment_datetime_iso, zone);
  const newMs = parseConfirmedInstant(args.new_datetime_iso, zone);
  if (currentMs === null || newMs === null) {
    return {
      ok: false,
      output: null,
      error:
        "Alguna de las dos fechas no es válida (formato ISO 8601, y que exista en el calendario). Confírmalas con el cliente.",
    };
  }
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
  const locate = (instantMs: number) =>
    locateAppointmentAt({
      supabase,
      cfg,
      workspaceId: ctx.workspaceId,
      contactId: ctx.contactId,
      instantMs,
      hlZone,
    });
  const failedLookup = async (err: unknown) => {
    console.error("[reschedule_highlevel] lookup failed:", err);
    await noteForTeam(
      supabase,
      ctx,
      "hl_appointment_failed",
      `El cliente pidió mover su cita del ${when} y no se pudo consultar la agenda. Revísalo tú.`,
    );
    return { ok: false, output: null, error: LOOKUP_FAILED };
  };

  let current;
  try {
    current = await locate(currentMs);
  } catch (err) {
    return failedLookup(err);
  }

  if (current.kind === "ambiguous") {
    await noteForTeam(
      supabase,
      ctx,
      "hl_appointment_failed",
      `El cliente pidió mover su cita del ${when}, pero tiene más de una a esa hora. No se movió ninguna: revísalo tú.`,
    );
    return {
      ok: false,
      output: null,
      error:
        "El cliente tiene más de una cita a esa hora, así que no se movió ninguna. Dile que una persona del equipo lo revisará.",
    };
  }

  if (current.kind !== "found" || current.state !== "active") {
    // A retry of a move that went through: the appointment is now at the new
    // time, and it records the time it was moved from.
    let atNew;
    try {
      atNew = await locate(newMs);
    } catch (err) {
      return failedLookup(err);
    }
    if (
      atNew.kind === "found" &&
      atNew.state === "active" &&
      sameInstant(atNew.meta.rescheduled_from, currentMs)
    ) {
      return {
        ok: true,
        output: { rescheduled: true, already_rescheduled: true, new_datetime: formatWithOffset(newMs, zone) },
      };
    }
    if (current.kind === "found" && current.state === "cancelled") {
      return {
        ok: false,
        output: null,
        error: "Esa cita está cancelada, así que no se puede mover. Si el cliente quiere una nueva, agéndala.",
      };
    }
    return {
      ok: false,
      output: null,
      error: `No encontré una cita activa del cliente el ${when}. Confirma con el cliente la fecha y hora exactas (list_highlevel_appointments te da las suyas); no le digas que se reagendó.`,
    };
  }

  // Keep the appointment's length: HighLevel's end time doesn't follow the
  // start on its own.
  let event;
  try {
    event = await fetchHLEvent(cfg, current.hlAppointmentId, hlZone);
  } catch (err) {
    return failedLookup(err);
  }
  if (!event || event.state !== "active") {
    await noteForTeam(
      supabase,
      ctx,
      "hl_appointment_failed",
      `El cliente pidió mover su cita del ${when}, pero en HighLevel ya no está activa. Revísalo tú.`,
    );
    return {
      ok: false,
      output: null,
      error: "Esa cita ya no está activa en el calendario, así que no se movió. Dile al cliente que una persona del equipo lo revisará.",
    };
  }
  const durationMs =
    event.startMs !== null && event.endMs !== null && event.endMs > event.startMs
      ? event.endMs - event.startMs
      : null;
  const body: Record<string, unknown> = { startTime: formatWithOffset(newMs, hlZone) };
  if (durationMs !== null) body.endTime = formatWithOffset(newMs + durationMs, hlZone);

  const put = await (async () => {
    try {
      return await putHLEvent(
        cfg,
        current.hlAppointmentId,
        body,
        "No pude confirmar si la cita se movió. No le digas al cliente que quedó reagendada ni que falló: dile que una persona del equipo lo confirmará.",
      );
    } catch (err) {
      await noteForTeam(
        supabase,
        ctx,
        "hl_appointment_unconfirmed",
        `Se pidió mover la cita del ${when} en HighLevel y no hubo confirmación. Revisa en qué horario quedó.`,
      );
      throw err;
    }
  })();

  if (!put.ok) {
    await noteForTeam(
      supabase,
      ctx,
      "hl_appointment_failed",
      `HighLevel rechazó mover la cita del ${when} (error ${put.status}). Revísalo tú.`,
    );
    return {
      ok: false,
      output: null,
      error: `El calendario respondió con un error (${put.status}); la cita NO se movió. Dile al cliente que una persona del equipo lo revisará.`,
    };
  }

  // Record where it was moved from, so a retry of this call can tell it
  // already went through.
  const movedFrom = new Date(currentMs).toISOString();
  if (current.localId) {
    const { error } = await supabase
      .from("appointments")
      .update({
        scheduled_at: new Date(newMs).toISOString(),
        meta: { ...current.meta, rescheduled_from: movedFrom },
      })
      .eq("id", current.localId)
      .eq("workspace_id", ctx.workspaceId);
    if (error) console.warn("[reschedule_highlevel] moved in HighLevel but failed to update local record:", error);
  } else {
    const { error } = await supabase.from("appointments").insert({
      workspace_id: ctx.workspaceId,
      contact_id: ctx.contactId,
      conversation_id: ctx.conversationId || null,
      scheduled_at: new Date(newMs).toISOString(),
      status: "booked",
      hl_appointment_id: current.hlAppointmentId,
      meta: { rescheduled_from: movedFrom },
    });
    if (error) console.warn("[reschedule_highlevel] moved in HighLevel but failed to record it locally:", error);
  }

  return { ok: true, output: { rescheduled: true, new_datetime: formatWithOffset(newMs, zone) } };
}

export const rescheduleHighLevelTool: Tool<Args> = {
  name: "reschedule_highlevel",
  description:
    "Mueve en HighLevel la cita del cliente que hoy empieza en appointment_datetime_iso a new_datetime_iso, conservando su duración. Úsala solo cuando el cliente haya confirmado cuál cita mover (list_highlevel_appointments) y el nuevo horario (ofrécele horarios reales con check_availability). Solo confirma el cambio si esta herramienta responde con éxito; si no encuentra la cita, falla o no pudo confirmar, dile la verdad.",
  sensitivity: "write",
  schema,
  enabledFor: () => true,
  run,
  preferredTimeoutMs: APPOINTMENT_TOOL_TIMEOUT_MS,
};
