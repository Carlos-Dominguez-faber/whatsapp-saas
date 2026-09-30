import { createClient as createSbClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../core/tool";
import { formatWithOffset } from "@/shared/lib/timezone";
import { describeInstant, LIST_TOOL_TIMEOUT_MS } from "../lib/hl-appointment.ts";

const schema = z.object({});

type Args = z.infer<typeof schema>;

async function run(_args: Args, ctx: ToolContext): Promise<ToolResult> {
  const { getCalComConfig } = await import("../../inbox/services/calcom-client.ts");
  const { getBusinessInfo } = await import("../../inbox/services/business-info.ts");
  const { workspaceSchedulingTimeZone } = await import("../../inbox/services/scheduling-timezone.ts");
  const { listUpcomingCalComBookings } = await import("../lib/calcom-appointment.ts");

  const cfg = await getCalComConfig(ctx.workspaceId);
  if (!cfg) {
    return { ok: false, output: null, error: "Cal.com no está conectado para este workspace" };
  }
  // Only the conversation's own contact: the playground has none.
  if (!ctx.contactId) {
    return { ok: true, output: { appointments: [], note: "No hay un contacto real en esta conversación." } };
  }

  const zone = await workspaceSchedulingTimeZone(ctx.workspaceId, await getBusinessInfo(ctx.workspaceId));
  const supabase = createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  try {
    const { bookings, unreadable, more } = await listUpcomingCalComBookings({
      supabase,
      apiKey: cfg.apiKey,
      workspaceId: ctx.workspaceId,
      contactId: ctx.contactId,
    });
    const appointments = bookings.map((b) => ({
      datetime_iso: formatWithOffset(b.startMs, zone),
      cuando: describeInstant(b.startMs, zone),
      ...(b.pending ? { pendiente_de_confirmar: true } : {}),
    }));
    const notes: string[] = [];
    if (appointments.length > 0) {
      notes.push("Para cancelar o reagendar, copia datetime_iso exactamente como aparece.");
    } else if (unreadable === 0 && !more) {
      notes.push("El cliente no tiene citas próximas agendadas por WhatsApp.");
    }
    if (appointments.some((a) => "pendiente_de_confirmar" in a)) {
      notes.push("Las marcadas pendiente_de_confirmar son solicitudes que el negocio todavía no confirma.");
    }
    // A read that failed is not "no appointment": the model must not say so.
    if (unreadable > 0) {
      notes.push(
        `No pude leer ${unreadable === 1 ? "una de sus citas" : `${unreadable} de sus citas`} en el calendario: puede tener más de las que aparecen.`,
      );
    }
    if (more) {
      notes.push(
        "Tiene más citas de las que aparecen aquí: no le digas que no tiene otras; pregúntale la fecha de la que busca.",
      );
    }
    // Only what was booked through WhatsApp is known here.
    notes.push("Las citas que el cliente agendó por fuera de WhatsApp no aparecen en esta lista.");
    return { ok: true, output: { appointments, note: notes.join(" ") } };
  } catch (err) {
    console.error("[list_calcom_appointments] lookup failed:", err);
    return {
      ok: false,
      output: null,
      error: "No pude consultar la agenda en este momento. Dile al cliente que lo revisarás, o pásalo a una persona.",
    };
  }
}

export const listCalComAppointmentsTool: Tool<Args> = {
  name: "list_calcom_appointments",
  description:
    "Lista las próximas citas en Cal.com del cliente de esta conversación (las agendadas por WhatsApp), con la fecha y hora exactas (datetime_iso). Úsala antes de cancelar o reagendar, para confirmar con el cliente cuál cita es y copiar su datetime_iso.",
  sensitivity: "read",
  schema,
  enabledFor: () => true,
  run,
  // The cached bookings, read in parallel.
  preferredTimeoutMs: LIST_TOOL_TIMEOUT_MS,
};
