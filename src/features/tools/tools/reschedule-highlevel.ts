import { createClient as createSbClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../core/tool";
import { formatWithOffset } from "@/shared/lib/timezone";
import {
  APPOINTMENT_TOOL_TIMEOUT_MS,
  confirmedInstantError,
  describeInstant,
  hlTimeZone,
  LOCAL_ACTIVE_STATUSES,
  type LocatedAppointment,
  locateAppointmentAt,
  locateConfirmedAppointmentAt,
  noteForTeam,
  parseConfirmedInstant,
  putHLEvent,
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

const LOOKUP_FAILED =
  "No pude consultar la agenda en este momento, así que la cita NO se movió. Dile al cliente que una persona del equipo lo revisará.";

/** Same instant, within a minute. */
function sameInstant(a: unknown, ms: number): boolean {
  const parsed = typeof a === "string" ? Date.parse(a) : Number.NaN;
  return !Number.isNaN(parsed) && Math.abs(parsed - ms) <= 60_000;
}

async function run(args: Args, ctx: ToolContext): Promise<ToolResult> {
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
  const lookupFailed = async (err: unknown) => {
    console.error("[reschedule_highlevel] lookup failed:", err);
    await noteForTeam(
      supabase,
      ctx,
      "hl_appointment_failed",
      `El cliente pidió mover su cita del ${when} y no se pudo consultar la agenda. Revísalo tú.`,
    );
    return needsHuman(LOOKUP_FAILED);
  };

  // Confirmed with HighLevel: the local row may be stale, or staff may have
  // moved or cancelled the appointment there.
  let located;
  try {
    located = await locateConfirmedAppointmentAt({ ...lookup, instantMs: currentMs });
  } catch (err) {
    return lookupFailed(err);
  }

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

  if (located.kind === "none" || located.event.state !== "active") {
    // A retry of a move that went through: the appointment is now at the new
    // time, and it records the time it was moved from.
    let atNew;
    try {
      atNew = await locateAppointmentAt({ ...lookup, instantMs: newMs });
    } catch (err) {
      return lookupFailed(err);
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
    if (located.kind === "none" && located.cancelledIds.length > 0) {
      return {
        ok: false,
        output: null,
        error: "Esa cita está cancelada, así que no se puede mover. Si el cliente quiere una nueva, agéndala.",
      };
    }
    if (located.kind === "found") {
      return {
        ok: false,
        output: null,
        error: "Esa cita ya no está activa (por ejemplo, ya se atendió), así que no se puede mover.",
      };
    }
    return {
      ok: false,
      output: null,
      error: `No encontré una cita activa del cliente el ${when}. Confirma con el cliente cuál es (list_highlevel_appointments te da las suyas); no le digas que se reagendó.`,
    };
  }

  const { appointment: found, event } = located;
  if (event.startMs !== null && Math.abs(event.startMs - currentMs) > 60_000) {
    return {
      ok: false,
      output: null,
      error: `Esa cita ya no está a esa hora en el calendario (ahora es el ${describeInstant(event.startMs, zone)}). Consulta otra vez list_highlevel_appointments y confirma con el cliente.`,
    };
  }
  // Keep the appointment's length: HighLevel's end time doesn't follow the
  // start on its own.
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
        found.hlAppointmentId,
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

  // Record where it was moved from, so a retry of this call can tell it
  // already went through. One local row per HighLevel appointment.
  await recordMove(supabase, ctx, found, currentMs, newMs);

  return { ok: true, output: { rescheduled: true, new_datetime: formatWithOffset(newMs, zone) } };
}

/**
 * One local row per HighLevel appointment (unique on workspace and
 * appointment id): the located row, else the one already holding that id —
 * possibly written by someone else meanwhile — else a new one.
 */
async function recordMove(
  supabase: SupabaseClient,
  ctx: ToolContext,
  found: LocatedAppointment,
  fromMs: number,
  toMs: number,
): Promise<void> {
  const patch = (base: Record<string, unknown>, live: boolean) => ({
    scheduled_at: new Date(toMs).toISOString(),
    // HighLevel has it live: a local row that says otherwise was stale.
    ...(live ? {} : { status: "booked" }),
    meta: { ...base, rescheduled_from: new Date(fromMs).toISOString() },
  });
  const warn = (what: string, error: unknown) =>
    console.warn(`[reschedule_highlevel] moved in HighLevel but failed to ${what}:`, error);
  const update = async (id: string, base: Record<string, unknown>, live: boolean) => {
    const { error } = await supabase
      .from("appointments")
      .update(patch(base, live))
      .eq("id", id)
      .eq("workspace_id", ctx.workspaceId);
    if (error) warn("update the local row", error);
  };
  const updateByHlId = async () => {
    const { data, error } = await supabase
      .from("appointments")
      .select("id, status, meta")
      .eq("workspace_id", ctx.workspaceId)
      .eq("hl_appointment_id", found.hlAppointmentId)
      .maybeSingle();
    if (error) {
      // Don't insert a second row for an appointment that may have one.
      warn("look up the local row", error);
      return true;
    }
    const row = data as { id: string; status: string | null; meta: Record<string, unknown> | null } | null;
    if (!row) return false;
    await update(row.id, row.meta ?? {}, LOCAL_ACTIVE_STATUSES.includes(row.status ?? ""));
    return true;
  };

  if (found.localId) return update(found.localId, found.meta, found.localActive);
  if (await updateByHlId()) return;

  const { error } = await supabase.from("appointments").insert({
    workspace_id: ctx.workspaceId,
    contact_id: ctx.contactId,
    conversation_id: ctx.conversationId || null,
    hl_appointment_id: found.hlAppointmentId,
    ...patch({}, false),
  });
  // Written by a concurrent call between the lookup and the insert.
  if (error?.code === "23505") {
    await updateByHlId();
    return;
  }
  if (error) warn("record it locally", error);
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
