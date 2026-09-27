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
      "Fecha y hora de la cita que el cliente confirmó cancelar, en ISO 8601 con zona horaria (ej: 2026-06-12T10:00:00-06:00). Pregúntale al cliente cuál cita es si no está claro.",
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
      error: "No hay un contacto real en esta conversación; no se puede cancelar una cita.",
    };
  }

  const instantMs = parseConfirmedInstant(args.appointment_datetime_iso);
  if (instantMs === null) {
    return {
      ok: false,
      output: null,
      error:
        "La fecha de la cita debe ir en ISO 8601 con zona horaria (ej: 2026-06-12T10:00:00-06:00).",
    };
  }

  const supabase = createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  let timeZone: string | null = null;
  const zone = async () =>
    (timeZone ??= businessTimeZone(await getBusinessInfo(ctx.workspaceId)));

  let found;
  try {
    found = await locateAppointmentAt({
      supabase,
      cfg,
      workspaceId: ctx.workspaceId,
      contactId: ctx.contactId,
      instantMs,
      timeZone: zone,
    });
  } catch (err) {
    console.error("[cancel_highlevel] lookup failed:", err);
    return {
      ok: false,
      output: null,
      error:
        "No se pudo consultar la agenda en este momento. Dile al cliente que lo revisarás o pásalo a una persona.",
    };
  }

  if (!found) {
    return {
      ok: false,
      output: null,
      error: `No encontré una cita del cliente el ${describeInstant(instantMs, await zone())}. Confirma con el cliente la fecha y hora exactas de su cita; no le digas que se canceló.`,
    };
  }

  // Already cancelled: a retry of this same call, or a cancellation made
  // elsewhere. Nothing to change.
  if (found.state === "cancelled") {
    return {
      ok: true,
      output: { cancelled: true, already_cancelled: true },
    };
  }
  if (found.state !== "active") {
    return {
      ok: false,
      output: null,
      error:
        "Esa cita ya no está activa (por ejemplo, ya pasó), así que no se puede cancelar.",
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
      body: JSON.stringify({ appointmentStatus: "cancelled" }),
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!res.ok) {
    // HighLevel's own wording (English, internal ids) stays in the logs.
    console.error(
      `[cancel_highlevel] HighLevel ${res.status}:`,
      (await res.text()).slice(0, 300),
    );
    return {
      ok: false,
      output: null,
      error: `El calendario de HighLevel respondió con un error (${res.status}); la cita NO se canceló. Dile al cliente que lo revisarás o pásalo a una persona.`,
    };
  }

  if (found.localId) {
    const { error: updateError } = await supabase
      .from("appointments")
      .update({ status: "cancelled" })
      .eq("id", found.localId)
      .eq("workspace_id", ctx.workspaceId);
    if (updateError) {
      console.warn(
        "[cancel_highlevel] cancelled in HighLevel but failed to update local status:",
        updateError,
      );
    }
  }

  return {
    ok: true,
    output: { cancelled: true },
  };
}

export const cancelHighLevelTool: Tool<Args> = {
  name: "cancel_highlevel",
  description:
    "Cancela en HighLevel la cita del cliente que empieza en la fecha y hora indicadas. Úsala solo cuando el cliente haya confirmado explícitamente cuál cita quiere cancelar. Solo confirma la cancelación si esta herramienta responde con éxito; si no encuentra la cita o falla, dile la verdad.",
  sensitivity: "write",
  schema,
  enabledFor: () => true,
  run,
};
