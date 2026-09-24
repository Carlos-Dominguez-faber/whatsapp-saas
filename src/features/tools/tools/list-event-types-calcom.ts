import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../core/tool";

const schema = z.object({});

type Args = z.infer<typeof schema>;

interface CalComEventType {
  id: number;
  title: string;
  lengthInMinutes: number;
  recurrence?: { disabled?: boolean } | null;
}

interface EventTypesResponse {
  status: string;
  data?: CalComEventType[];
}

async function run(_args: Args, ctx: ToolContext): Promise<ToolResult> {
  const {
    getCalComConfig,
    calcomHeaders,
    CALCOM_BASE_URL,
    CALCOM_API_VERSION,
    redactCalComApiKey,
  } = await import("../../inbox/services/calcom-client.ts");

  const cfg = await getCalComConfig(ctx.workspaceId);
  if (!cfg) {
    return {
      ok: false,
      output: null,
      error: "Cal.com no está conectado para este workspace",
    };
  }

  const res = await fetch(`${CALCOM_BASE_URL}/v2/event-types`, {
    method: "GET",
    headers: calcomHeaders(cfg.apiKey, CALCOM_API_VERSION.eventTypes),
  });

  if (!res.ok) {
    const err = redactCalComApiKey(await res.text(), cfg.apiKey);
    return {
      ok: false,
      output: null,
      error: `Cal.com API error: ${res.status} ${err.slice(0, 150)}`,
    };
  }

  const data = (await res.json()) as EventTypesResponse;
  const eventTypes = (data.data ?? []).map((et) => ({
    id: et.id,
    title: et.title,
    duration_minutes: et.lengthInMinutes,
    // Recurring event types create a whole series in one booking, which this
    // system can't represent (one calcom_booking_uid per appointment row) —
    // schedule_calcom rejects them, so surface it here too so the LLM
    // doesn't recommend one and waste a round-trip.
    recurring: !!et.recurrence && et.recurrence.disabled !== true,
  }));

  return {
    ok: true,
    output: { event_types: eventTypes, count: eventTypes.length },
  };
}

export const listEventTypesCalComTool: Tool<Args> = {
  name: "list_event_types_calcom",
  description:
    "Lista los tipos de evento (servicios) disponibles en el calendario de Cal.com del negocio. Úsala primero para saber qué event_type_id corresponde a lo que pide el cliente, antes de consultar disponibilidad o agendar. Los tipos marcados recurring:true no se pueden agendar por WhatsApp (crean una serie de citas) — no los ofrezcas para agendar, solo para informar.",
  sensitivity: "read",
  schema,
  enabledFor: () => true,
  run,
};
