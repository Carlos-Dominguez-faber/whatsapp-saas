import { createClient as createSbClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../core/tool";
import { hlTimeZone, listUpcomingAppointments } from "../lib/hl-appointment.ts";

const schema = z.object({});

type Args = z.infer<typeof schema>;

async function run(_args: Args, ctx: ToolContext): Promise<ToolResult> {
  const { getHLConfig } = await import("../../inbox/services/highlevel-client.ts");
  const { getBusinessInfo } = await import("../../inbox/services/business-info.ts");
  const { schedulingTimeZone } = await import("../../inbox/services/scheduling-timezone.ts");

  const cfg = await getHLConfig(ctx.workspaceId);
  if (!cfg) {
    return { ok: false, output: null, error: "HighLevel no está conectado para este workspace" };
  }
  // Only the conversation's own contact: the playground has none.
  if (!ctx.contactId) {
    return { ok: true, output: { appointments: [], note: "No hay un contacto real en esta conversación." } };
  }

  const zone = schedulingTimeZone(await getBusinessInfo(ctx.workspaceId), cfg.timezone);
  const supabase = createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  try {
    const appointments = await listUpcomingAppointments({
      supabase,
      cfg,
      workspaceId: ctx.workspaceId,
      contactId: ctx.contactId,
      zone,
      hlZone: hlTimeZone(cfg, zone),
    });
    return {
      ok: true,
      output: {
        appointments,
        note:
          appointments.length > 0
            ? "Para cancelar o reagendar, copia datetime_iso exactamente como aparece."
            : "El cliente no tiene citas próximas registradas.",
      },
    };
  } catch (err) {
    console.error("[list_highlevel_appointments] lookup failed:", err);
    return {
      ok: false,
      output: null,
      error: "No pude consultar la agenda en este momento. Dile al cliente que lo revisarás, o pásalo a una persona.",
    };
  }
}

export const listHighLevelAppointmentsTool: Tool<Args> = {
  name: "list_highlevel_appointments",
  description:
    "Lista las próximas citas del cliente de esta conversación en HighLevel, con la fecha y hora exactas (datetime_iso). Úsala antes de cancelar o reagendar, para confirmar con el cliente cuál cita es y copiar su datetime_iso.",
  sensitivity: "read",
  schema,
  enabledFor: () => true,
  run,
};
