import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../core/tool";
import { buildAvailabilityOutput, groupByDay, zonedDayRange } from "../lib/slots";

const schema = z.object({
  event_type_id: z
    .number()
    .int()
    .describe("ID del tipo de evento de Cal.com (obtenido con list_event_types_calcom)"),
  date_from: z
    .string()
    .describe("Fecha inicial del rango a consultar (ISO, ej: 2026-06-12)"),
  date_to: z.string().describe("Fecha final del rango (ISO, ej: 2026-06-19)"),
});

type Args = z.infer<typeof schema>;

/**
 * Cal.com /v2/slots (cal-api-version 2024-09-04): `{ status, data: { "YYYY-MM-DD":
 * [{ start }] } }`. Anything else is not "no slots": see readSlots in
 * check-availability.ts for the same rule.
 */
function readSlots(json: unknown): unknown[] | null {
  const body = json as { status?: unknown; data?: unknown } | null;
  if (!body || body.status !== "success") return null;
  const data = body.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const slots: unknown[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !Array.isArray(value)) return null;
    slots.push(...value);
  }
  return slots;
}

async function run(args: Args, ctx: ToolContext): Promise<ToolResult> {
  const { getCalComConfig, listCalComEventTypes, calcomRequest, CALCOM_API_VERSION, CALCOM_READ_TIMEOUT_MS } =
    await import("../../inbox/services/calcom-client.ts");
  const { getBusinessInfo } = await import("../../inbox/services/business-info.ts");
  const { workspaceSchedulingTimeZone } = await import("../../inbox/services/scheduling-timezone.ts");

  const cfg = await getCalComConfig(ctx.workspaceId);
  if (!cfg) {
    return { ok: false, output: null, error: "Cal.com no está conectado para este workspace" };
  }

  const eventTypes = await listCalComEventTypes(cfg.apiKey);
  if (!eventTypes) {
    return {
      ok: false,
      output: null,
      error: "No pude consultar los servicios de Cal.com en este momento; no se sabe si hay horarios libres.",
    };
  }
  if (!eventTypes.some((et) => et.id === args.event_type_id)) {
    return {
      ok: false,
      output: null,
      error: "event_type_id no corresponde a ningún tipo de evento de este negocio: usa list_event_types_calcom para obtener uno válido.",
    };
  }

  // The range and the slots in the workspace's scheduling zone: the one
  // schedule/cancel/reschedule read the copied date in, and the prompt's
  // calendar uses. `date_to` includes that whole local day.
  const tz = await workspaceSchedulingTimeZone(ctx.workspaceId, await getBusinessInfo(ctx.workspaceId));
  const range = zonedDayRange(args.date_from, args.date_to, tz);
  if (!range) {
    return { ok: false, output: null, error: "Fechas inválidas" };
  }

  const params = new URLSearchParams({
    eventTypeId: String(args.event_type_id),
    start: new Date(range.startMs).toISOString(),
    end: new Date(range.endMs).toISOString(),
    timeZone: tz,
  });
  const res = await calcomRequest(cfg.apiKey, `/v2/slots?${params.toString()}`, {
    version: CALCOM_API_VERSION.slots,
    timeoutMs: CALCOM_READ_TIMEOUT_MS,
  });
  if (res.kind !== "ok") {
    if (res.kind === "http") console.error(`[check_availability_calcom] Cal.com ${res.status}:`, res.detail);
    else console.error("[check_availability_calcom] no answer:", res.reason);
    return {
      ok: false,
      output: null,
      error: `El calendario de Cal.com ${res.kind === "http" ? `respondió con un error (${res.status})` : "no respondió"}; no se pudo consultar la disponibilidad. Dile al cliente que lo revisarás o pásalo a una persona.`,
    };
  }

  const all = readSlots(res.json);
  if (all === null) {
    return {
      ok: false,
      output: null,
      error: "El calendario respondió en un formato que no se pudo interpretar; no se sabe si hay horarios libres",
    };
  }
  return { ok: true, output: buildAvailabilityOutput(groupByDay(all, tz), tz) };
}

export const checkAvailabilityCalComTool: Tool<Args> = {
  name: "check_availability_calcom",
  description:
    "Consulta los horarios libres reales del calendario de Cal.com para un tipo de evento en un rango de fechas. Úsalo ANTES de agendar para ofrecer al cliente horarios que sí existen.",
  sensitivity: "read",
  schema,
  enabledFor: () => true,
  run,
};
