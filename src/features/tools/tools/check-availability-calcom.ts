import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../core/tool";
import {
  buildAvailabilityOutput,
  groupByDay,
  resolveTimeZone,
} from "../lib/slots";

const schema = z.object({
  event_type_id: z
    .number()
    .describe(
      "ID del tipo de evento de Cal.com (obtenido con list_event_types_calcom)",
    ),
  date_from: z
    .string()
    .describe("Fecha inicial del rango a consultar (ISO, ej: 2026-06-12)"),
  date_to: z.string().describe("Fecha final del rango (ISO, ej: 2026-06-19)"),
});

type Args = z.infer<typeof schema>;

// Cal.com /v2/slots devuelve un objeto por fecha: { "2026-06-12": [...] }.
// Los elementos son objetos `{ start }` en la API v2 — el tipo que declaraba
// este archivo decía `string[]` y era FALSO. `groupByDay` acepta las dos formas
// y cuenta como ilegible lo que no reconozca, en vez de descartarlo en silencio.
interface SlotsResponse {
  status: string;
  data?: Record<string, unknown[]>;
}

async function run(args: Args, ctx: ToolContext): Promise<ToolResult> {
  const {
    getCalComConfig,
    calcomHeaders,
    CALCOM_BASE_URL,
    CALCOM_API_VERSION,
    listCalComEventTypeIds,
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

  const knownEventTypes = await listCalComEventTypeIds(cfg.apiKey);
  if (
    !knownEventTypes ||
    !knownEventTypes.some((et) => et.id === args.event_type_id)
  ) {
    return {
      ok: false,
      output: null,
      error:
        "event_type_id no corresponde a ningún tipo de evento de este workspace — usa list_event_types_calcom para obtener uno válido",
    };
  }

  if (Number.isNaN(Date.parse(args.date_from)) ||
    Number.isNaN(Date.parse(args.date_to))
  ) {
    return { ok: false, output: null, error: "Fechas inválidas" };
  }

  // La zona del workspace es texto libre: si no es IANA válida, agrupar por la
  // resuelta y pedirle a Cal.com la original daría dos verdades distintas.
  const tz = resolveTimeZone(cfg.timezone);

  // Cal.com accepts bare dates directly: a bare `start` defaults to 00:00:00
  // of that day and a bare `end` defaults to 23:59:59 of that day — no
  // client-side end-of-day math needed (unlike the HighLevel equivalent).
  const params = new URLSearchParams({
    eventTypeId: String(args.event_type_id),
    start: args.date_from,
    end: args.date_to,
    timeZone: tz,
  });

  const res = await fetch(`${CALCOM_BASE_URL}/v2/slots?${params.toString()}`, {
    method: "GET",
    headers: calcomHeaders(cfg.apiKey, CALCOM_API_VERSION.slots),
  });

  if (!res.ok) {
    const err = redactCalComApiKey(await res.text(), cfg.apiKey);
    return {
      ok: false,
      output: null,
      error: `Cal.com API error: ${res.status} ${err.slice(0, 150)}`,
    };
  }

  const data = (await res.json()) as SlotsResponse;

  // Un 200 con un cuerpo que no se entiende NO es "no hay horarios": `data.data`
  // ausente daba una lista vacía y la tool afirmaba ausencia de cupos sobre una
  // respuesta que nunca leyó. `status` es el campo de contrato de Cal.com v2.
  if (data.status !== "success" || !data.data || typeof data.data !== "object") {
    return {
      ok: false,
      output: null,
      error:
        "Cal.com respondió en un formato que no se pudo interpretar; no se sabe si hay horarios libres",
    };
  }

  const all = Object.values(data.data).flat();
  const grouped = groupByDay(all, tz);

  return { ok: true, output: buildAvailabilityOutput(grouped, tz) };
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
