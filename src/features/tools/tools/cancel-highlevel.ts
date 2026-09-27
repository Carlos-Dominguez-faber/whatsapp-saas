import { createClient as createSbClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../core/tool";
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
      "Fecha y hora de la cita que el cliente confirmó cancelar, en ISO 8601 (ej: 2026-06-12T10:00:00-06:00). Cópiala de list_highlevel_appointments; si no está claro cuál cita es, pregúntale al cliente.",
    ),
});

type Args = z.infer<typeof schema>;

const LOOKUP_FAILED =
  "No pude consultar la agenda en este momento, así que la cita NO se canceló. Dile al cliente que una persona del equipo lo revisará.";

async function run(args: Args, ctx: ToolContext): Promise<ToolResult> {
  const { getHLConfig } = await import("../../inbox/services/highlevel-client.ts");
  const { getBusinessInfo, businessTimeZone } = await import(
    "../../inbox/services/business-info.ts"
  );

  const cfg = await getHLConfig(ctx.workspaceId);
  if (!cfg) {
    return { ok: false, output: null, error: "HighLevel no está conectado para este workspace" };
  }
  // The playground has no real contact, so there's no "their appointment".
  if (!ctx.contactId) {
    return {
      ok: false,
      output: null,
      error: "No hay un contacto real en esta conversación; no se puede cancelar una cita.",
    };
  }

  const zone = businessTimeZone(await getBusinessInfo(ctx.workspaceId));
  const hlZone = hlTimeZone(cfg, zone);
  const instantMs = parseConfirmedInstant(args.appointment_datetime_iso, zone);
  if (instantMs === null) {
    return {
      ok: false,
      output: null,
      error:
        "Esa fecha y hora no es válida (formato ISO 8601, y que exista en el calendario). Confírmala con el cliente o consúltala con list_highlevel_appointments.",
    };
  }
  if (instantMs < Date.now()) {
    return {
      ok: false,
      output: null,
      error: `La cita del ${describeInstant(instantMs, zone)} ya pasó; no se puede cancelar.`,
    };
  }

  const supabase = createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const when = describeInstant(instantMs, zone);

  let located;
  try {
    located = await locateAppointmentAt({
      supabase,
      cfg,
      workspaceId: ctx.workspaceId,
      contactId: ctx.contactId,
      instantMs,
      hlZone,
    });
  } catch (err) {
    console.error("[cancel_highlevel] lookup failed:", err);
    await noteForTeam(
      supabase,
      ctx,
      "hl_appointment_failed",
      `El cliente pidió cancelar su cita del ${when} y no se pudo consultar la agenda. Revísalo tú.`,
    );
    return { ok: false, output: null, error: LOOKUP_FAILED };
  }

  if (located.kind === "none") {
    return {
      ok: false,
      output: null,
      error: `No encontré una cita del cliente el ${when}. Confirma con el cliente la fecha y hora exactas (list_highlevel_appointments te da las suyas); no le digas que se canceló.`,
    };
  }
  if (located.kind === "ambiguous") {
    await noteForTeam(
      supabase,
      ctx,
      "hl_appointment_failed",
      `El cliente pidió cancelar su cita del ${when}, pero tiene más de una a esa hora. No se canceló ninguna: revísalo tú.`,
    );
    return {
      ok: false,
      output: null,
      error:
        "El cliente tiene más de una cita a esa hora, así que no se canceló ninguna. Dile que una persona del equipo lo revisará.",
    };
  }

  // Not active here: before saying "already cancelled", ask HighLevel, whose
  // word counts (the local row may be stale).
  if (located.state !== "active") {
    let current;
    try {
      current = await fetchHLEvent(cfg, located.hlAppointmentId, hlZone);
    } catch (err) {
      console.error("[cancel_highlevel] confirm lookup failed:", err);
      await noteForTeam(
        supabase,
        ctx,
        "hl_appointment_failed",
        `El cliente pidió cancelar su cita del ${when}; no se pudo confirmar su estado en HighLevel. Revísalo tú.`,
      );
      return { ok: false, output: null, error: LOOKUP_FAILED };
    }
    if (!current || current.state === "cancelled") {
      return { ok: true, output: { cancelled: true, already_cancelled: true } };
    }
    if (current.state !== "active") {
      return {
        ok: false,
        output: null,
        error: "Esa cita ya no está activa (por ejemplo, ya se atendió), así que no se puede cancelar.",
      };
    }
  }

  const put = await (async () => {
    try {
      return await putHLEvent(
        cfg,
        located.hlAppointmentId,
        { appointmentStatus: "cancelled" },
        "No pude confirmar si la cita se canceló. No le digas al cliente que quedó cancelada ni que falló: dile que una persona del equipo lo confirmará.",
      );
    } catch (err) {
      await noteForTeam(
        supabase,
        ctx,
        "hl_appointment_unconfirmed",
        `Se pidió cancelar la cita del ${when} en HighLevel y no hubo confirmación. Revisa si quedó cancelada.`,
      );
      throw err;
    }
  })();

  if (!put.ok) {
    await noteForTeam(
      supabase,
      ctx,
      "hl_appointment_failed",
      `HighLevel rechazó cancelar la cita del ${when} (error ${put.status}). Revísalo tú.`,
    );
    return {
      ok: false,
      output: null,
      error: `El calendario respondió con un error (${put.status}); la cita NO se canceló. Dile al cliente que una persona del equipo lo revisará.`,
    };
  }

  if (located.localId) {
    const { error: updateError } = await supabase
      .from("appointments")
      .update({ status: "cancelled" })
      .eq("id", located.localId)
      .eq("workspace_id", ctx.workspaceId);
    if (updateError) {
      console.warn("[cancel_highlevel] cancelled in HighLevel but failed to update local status:", updateError);
    }
  }

  return { ok: true, output: { cancelled: true } };
}

export const cancelHighLevelTool: Tool<Args> = {
  name: "cancel_highlevel",
  description:
    "Cancela en HighLevel la cita del cliente que empieza en la fecha y hora indicadas. Úsala solo cuando el cliente haya confirmado explícitamente cuál cita quiere cancelar (consulta sus citas con list_highlevel_appointments). Solo confirma la cancelación si esta herramienta responde con éxito; si no encuentra la cita, falla o no pudo confirmar, dile la verdad.",
  sensitivity: "write",
  schema,
  enabledFor: () => true,
  run,
  preferredTimeoutMs: APPOINTMENT_TOOL_TIMEOUT_MS,
};
