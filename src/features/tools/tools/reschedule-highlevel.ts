import { createClient as createSbClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../core/tool";
import {
  describeInstant,
  locateAppointmentAt,
  parseConfirmedInstant,
} from "../lib/hl-appointment.ts";

const schema = z.object({
  appointment_datetime_iso: z
    .string()
    .describe(
      "Fecha y hora ACTUAL de la cita que el cliente quiere mover, en ISO 8601 con zona horaria (ej: 2026-06-12T10:00:00-06:00).",
    ),
  new_datetime_iso: z
    .string()
    .describe(
      "Nuevo inicio de la cita que el cliente confirmó, en ISO 8601 con zona horaria (ej: 2026-06-15T16:00:00-06:00).",
    ),
});

type Args = z.infer<typeof schema>;

async function run(args: Args, ctx: ToolContext): Promise<ToolResult> {
  const { getHLConfig } = await import(
    "../../inbox/services/highlevel-client.ts"
  );
  const { getBusinessInfo, businessTimeZone } = await import(
    "../../inbox/services/business-info.ts"
  );

  const cfg = await getHLConfig(ctx.workspaceId);
  if (!cfg) {
    return {
      ok: false,
      output: null,
      error: "HighLevel no está conectado para este workspace",
    };
  }

  // The playground has no real contact, so there's no "their appointment".
  if (!ctx.contactId) {
    return {
      ok: false,
      output: null,
      error: "No hay un contacto real en esta conversación; no se puede reagendar una cita.",
    };
  }

  const currentMs = parseConfirmedInstant(args.appointment_datetime_iso);
  const newMs = parseConfirmedInstant(args.new_datetime_iso);
  if (currentMs === null || newMs === null) {
    return {
      ok: false,
      output: null,
      error:
        "Las dos fechas deben ir en ISO 8601 con zona horaria (ej: 2026-06-12T10:00:00-06:00).",
    };
  }
  if (currentMs === newMs) {
    return {
      ok: false,
      output: null,
      error: "La nueva fecha es la misma que la actual; no hay nada que mover.",
    };
  }

  const supabase = createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  let timeZone: string | null = null;
  const zone = async () =>
    (timeZone ??= businessTimeZone(await getBusinessInfo(ctx.workspaceId)));
  const locate = (instantMs: number) =>
    locateAppointmentAt({
      supabase,
      cfg,
      workspaceId: ctx.workspaceId,
      contactId: ctx.contactId,
      instantMs,
      timeZone: zone,
    });

  let found;
  let alreadyAtNew;
  try {
    found = await locate(currentMs);
    // Nothing active at the current time: if the contact already has an
    // active appointment at the new time, this is a retry of a move that went
    // through. Answer that instead of "not found".
    alreadyAtNew =
      found?.state === "active" ? null : await locate(newMs);
  } catch (err) {
    console.error("[reschedule_highlevel] lookup failed:", err);
    return {
      ok: false,
      output: null,
      error:
        "No se pudo consultar la agenda en este momento. Dile al cliente que lo revisarás o pásalo a una persona.",
    };
  }

  if (found?.state !== "active") {
    if (alreadyAtNew?.state === "active") {
      return {
        ok: true,
        output: {
          rescheduled: true,
          already_rescheduled: true,
          new_datetime: args.new_datetime_iso,
        },
      };
    }
    if (found?.state === "cancelled") {
      return {
        ok: false,
        output: null,
        error:
          "Esa cita está cancelada, así que no se puede mover. Si el cliente quiere una nueva, agéndala.",
      };
    }
    return {
      ok: false,
      output: null,
      error: `No encontré una cita activa del cliente el ${describeInstant(currentMs, await zone())}. Confirma con el cliente la fecha y hora exactas de su cita actual; no le digas que se reagendó.`,
    };
  }

  const res = await fetch(
    `https://services.leadconnectorhq.com/calendars/events/appointments/${found.hlAppointmentId}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Version: "v3",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ startTime: args.new_datetime_iso }),
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!res.ok) {
    console.error(
      `[reschedule_highlevel] HighLevel ${res.status}:`,
      (await res.text()).slice(0, 300),
    );
    return {
      ok: false,
      output: null,
      error: `El calendario de HighLevel respondió con un error (${res.status}); la cita NO se movió. Dile al cliente que lo revisarás o pásalo a una persona.`,
    };
  }

  if (found.localId) {
    const { error: updateError } = await supabase
      .from("appointments")
      .update({ scheduled_at: new Date(newMs).toISOString() })
      .eq("id", found.localId)
      .eq("workspace_id", ctx.workspaceId);
    if (updateError) {
      console.warn(
        "[reschedule_highlevel] rescheduled in HighLevel but failed to update local record:",
        updateError,
      );
    }
  }

  return {
    ok: true,
    output: { rescheduled: true, new_datetime: args.new_datetime_iso },
  };
}

export const rescheduleHighLevelTool: Tool<Args> = {
  name: "reschedule_highlevel",
  description:
    "Mueve en HighLevel la cita del cliente que hoy empieza en appointment_datetime_iso a new_datetime_iso. Úsala solo cuando el cliente haya confirmado cuál cita mover y el nuevo horario (ofrécele horarios reales con check_availability). Solo confirma el cambio si esta herramienta responde con éxito; si no encuentra la cita o falla, dile la verdad.",
  sensitivity: "write",
  schema,
  enabledFor: () => true,
  run,
};
