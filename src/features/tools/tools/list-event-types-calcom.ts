import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../core/tool";

const schema = z.object({});

type Args = z.infer<typeof schema>;

async function run(_args: Args, ctx: ToolContext): Promise<ToolResult> {
  const { getCalComConfig, listCalComEventTypes } = await import(
    "../../inbox/services/calcom-client.ts"
  );

  const cfg = await getCalComConfig(ctx.workspaceId);
  if (!cfg) {
    return { ok: false, output: null, error: "Cal.com no está conectado para este workspace" };
  }

  const eventTypes = await listCalComEventTypes(cfg.apiKey);
  if (!eventTypes) {
    return {
      ok: false,
      output: null,
      error: "No pude consultar los servicios de Cal.com en este momento. Dile al cliente que lo revisarás o pásalo a una persona.",
    };
  }
  return {
    ok: true,
    output: {
      event_types: eventTypes.map((et) => ({
        id: et.id,
        title: et.title,
        duration_minutes: et.durationMinutes,
        // schedule_calcom rejects them: said here so the model doesn't offer one.
        recurring: et.recurring,
        con_cupos: et.seated,
      })),
      count: eventTypes.length,
    },
  };
}

export const listEventTypesCalComTool: Tool<Args> = {
  name: "list_event_types_calcom",
  description:
    "Lista los tipos de evento (servicios) del calendario de Cal.com del negocio. Úsala primero para saber qué event_type_id corresponde a lo que pide el cliente, antes de consultar disponibilidad o agendar. Los marcados recurring:true (crean una serie de citas) o con_cupos:true (varias personas por horario) no se pueden agendar por WhatsApp: no los ofrezcas para agendar, solo para informar.",
  sensitivity: "read",
  schema,
  enabledFor: () => true,
  run,
};
