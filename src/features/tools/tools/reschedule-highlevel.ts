import { createClient as createSbClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult, ToolRunOptions } from "../core/tool";
import { formatWithOffset } from "@/shared/lib/timezone";
import {
  APPOINTMENT_TOOL_TIMEOUT_MS,
  confirmedInstantError,
  describeInstant,
  hasTimeToLookUp,
  hasTimeToWrite,
  hlTimeZone,
  localMetaOf,
  locateAppointmentAt,
  noteForTeam,
  onlyUpcomingHint,
  parseConfirmedInstant,
  putHLEvent,
  recordLocally,
} from "../lib/hl-appointment.ts";

const schema = z.object({
  appointment_datetime_iso: z
    .string()
    .describe(
      "Fecha y hora ACTUAL de la cita que el cliente quiere mover, copiada exactamente de list_highlevel_appointments (ISO 8601 con su offset).",
    ),
  new_datetime_iso: z
    .string()
    .describe(
      "Nuevo inicio que el cliente confirmó, copiado exactamente de check_availability (ISO 8601 con su offset).",
    ),
});

type Args = z.infer<typeof schema>;

/** A tool answer that a person has to follow up: the buffer hands off after the reply. */
function needsHuman(error: string): ToolResult {
  return { ok: false, output: { needs_human: true }, error };
}

const UNCONFIRMED =
  "No pude confirmar la cita en el calendario en este momento, así que NO se movió. Dile al cliente que una persona del equipo lo revisará.";

/** Same instant, within a minute. */
function sameInstant(a: unknown, ms: number): boolean {
  const parsed = typeof a === "string" ? Date.parse(a) : Number.NaN;
  return !Number.isNaN(parsed) && Math.abs(parsed - ms) <= 60_000;
}

async function run(args: Args, ctx: ToolContext, opts?: ToolRunOptions): Promise<ToolResult> {
  const startedAt = Date.now();
  const budgetMs = opts?.timeoutMs ?? APPOINTMENT_TOOL_TIMEOUT_MS;
  const { getHLConfig } = await import("../../inbox/services/highlevel-client.ts");
  const { getBusinessInfo } = await import("../../inbox/services/business-info.ts");
  const { schedulingTimeZone } = await import("../../inbox/services/scheduling-timezone.ts");

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

  const zone = schedulingTimeZone(await getBusinessInfo(ctx.workspaceId), cfg.timezone);
  const hlZone = hlTimeZone(cfg, zone);
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
  const lookup = {
    supabase,
    cfg,
    workspaceId: ctx.workspaceId,
    contactId: ctx.contactId,
    hlZone,
  };
  const unconfirmed = async (err?: unknown) => {
    if (err) console.error("[reschedule_highlevel] lookup failed:", err);
    await noteForTeam(
      supabase,
      ctx,
      "hl_appointment_failed",
      `El cliente pidió mover su cita del ${when} y no se pudo confirmar en la agenda. Revísalo tú.`,
    );
    return needsHuman(UNCONFIRMED);
  };

  // HighLevel's current view: the local rows are only a cache.
  let located;
  try {
    located = await locateAppointmentAt({ ...lookup, instantMs: currentMs });
  } catch (err) {
    return unconfirmed(err);
  }

  if (located.kind === "unconfirmed") return unconfirmed();
  if (located.kind === "ambiguous") {
    await noteForTeam(
      supabase,
      ctx,
      "hl_appointment_failed",
      `El cliente pidió mover su cita del ${when}, pero tiene más de una a esa hora. No se movió ninguna: revísalo tú.`,
    );
    return needsHuman(
      "El cliente tiene más de una cita a esa hora, así que no se movió ninguna. Dile que una persona del equipo lo revisará.",
    );
  }

  if (located.kind !== "found") {
    // Without the time to check whether this is a retry of a move that went
    // through, nothing was changed: that much is true.
    if (!hasTimeToLookUp(startedAt, budgetMs)) return unconfirmed();
    // A retry of a move this tool made: HighLevel has the appointment live at
    // the new time, and its local row records the time it was moved from.
    let atNew;
    try {
      atNew = await locateAppointmentAt({ ...lookup, instantMs: newMs });
    } catch (err) {
      return unconfirmed(err);
    }
    if (
      atNew.kind === "found" &&
      sameInstant(
        (await localMetaOf(supabase, ctx.workspaceId, atNew.appointment.id)).rescheduled_from,
        currentMs,
      )
    ) {
      return {
        ok: true,
        output: { rescheduled: true, already_rescheduled: true, new_datetime: formatWithOffset(newMs, zone) },
      };
    }
    if (located.kind === "already_cancelled") {
      return {
        ok: false,
        output: null,
        error: "Esa cita está cancelada, así que no se puede mover. Si el cliente quiere una nueva, agéndala.",
      };
    }
    if (located.kind === "not_active") {
      return {
        ok: false,
        output: null,
        error: "Esa cita ya no está activa (por ejemplo, ya se atendió), así que no se puede mover.",
      };
    }
    return {
      ok: false,
      output: null,
      error: `No encontré una cita activa del cliente el ${when}. ${onlyUpcomingHint(located.onlyUpcoming, zone)}No le digas que se reagendó.`,
    };
  }

  const { appointment } = located;
  // Keep the appointment's length: HighLevel's end time doesn't follow the
  // start on its own.
  const durationMs =
    appointment.endMs !== null && appointment.endMs > appointment.startMs
      ? appointment.endMs - appointment.startMs
      : null;
  const body: Record<string, unknown> = { startTime: formatWithOffset(newMs, hlZone) };
  if (durationMs !== null) body.endTime = formatWithOffset(newMs + durationMs, hlZone);

  // Nothing was written yet: saying so is true.
  if (!hasTimeToWrite(startedAt, budgetMs)) {
    return {
      ok: false,
      output: null,
      error: "El calendario tardó demasiado, así que la cita NO se movió. Dile al cliente que lo intentas de nuevo en un momento.",
    };
  }

  const put = await (async () => {
    try {
      return await putHLEvent(
        cfg,
        appointment.id,
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
    return needsHuman(
      `El calendario respondió con un error (${put.status}); la cita NO se movió. Dile al cliente que una persona del equipo lo revisará.`,
    );
  }

  // The time it was moved from lets a retry of this call tell it went through.
  await recordLocally(lookup, appointment.id, {
    scheduled_at: new Date(newMs).toISOString(),
    meta: { rescheduled_from: new Date(currentMs).toISOString() },
  });

  return { ok: true, output: { rescheduled: true, new_datetime: formatWithOffset(newMs, zone) } };
}

export const rescheduleHighLevelTool: Tool<Args> = {
  name: "reschedule_highlevel",
  description:
    "Mueve en HighLevel la cita del cliente que hoy empieza en appointment_datetime_iso a new_datetime_iso, conservando su duración. Úsala solo cuando el cliente haya confirmado cuál cita mover (list_highlevel_appointments) y el nuevo horario (check_availability); copia las fechas exactamente como las dieron esas herramientas. Solo confirma el cambio si esta herramienta responde con éxito; si no encuentra la cita, falla o no pudo confirmar, dile la verdad.",
  sensitivity: "write",
  schema,
  enabledFor: () => true,
  run,
  preferredTimeoutMs: APPOINTMENT_TOOL_TIMEOUT_MS,
};
