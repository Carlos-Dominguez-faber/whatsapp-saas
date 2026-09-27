import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../core/tool";
import { resolveCalendarId } from "../lib/calendar-id";
import { buildAvailabilityOutput, groupByDay, zonedDayRange } from "../lib/slots";

const schema = z.object({
  date_from: z
    .string()
    .describe("Fecha inicial del rango a consultar (ISO, ej: 2026-06-12)"),
  date_to: z.string().describe("Fecha final del rango (ISO, ej: 2026-06-19)"),
  calendar_id: z
    .string()
    .optional()
    .describe(
      "ID del calendario de HighLevel (usa el del workspace si se omite)",
    ),
});

type Args = z.infer<typeof schema>;

// GHL free-slots returns an object keyed by date: { "2026-06-12": { slots: [...] }, ... }
// plus non-date keys (e.g. traceId) treated as metadata. Cualquier otra
// clave significa que la respuesta no es la que conocemos: ver readSlots.
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const META_KEYS = new Set(["traceId"]);

interface FreeSlotsResponse {
  [key: string]: { slots?: string[] } | unknown;
}

/**
 * Slots de la respuesta de GHL, o `null` si la respuesta **no se entendió**.
 *
 * El criterio es positivo a propósito: enumerar formas ilegibles desde abajo
 * siempre deja alguna capa más arriba que convierte un cuerpo desconocido en
 * "No hay horarios disponibles". Acá la tool solo puede afirmar ausencia de
 * cupos si RECONOCIÓ la respuesta: un objeto cuyas claves son días
 * `YYYY-MM-DD` con `{ slots: [] }`, más metadatos conocidos. Cualquier otra
 * cosa —un 200 con `{status:"error"}`, los días dentro de otra envoltura, un
 * `slots` que no es arreglo— es un error explícito, no una agenda vacía.
 *
 * Residuo conocido: un cuerpo sin ningún día y sin claves inesperadas (`{}` o
 * solo `traceId`) se lee como vacío: no se distingue de un rango legítimamente
 * sin cupos.
 */
function readSlots(data: unknown): unknown[] | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const slots: unknown[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (META_KEYS.has(key)) continue;
    if (!DATE_KEY.test(key)) return null;
    const inner = (value as { slots?: unknown } | null)?.slots;
    if (!Array.isArray(inner)) return null;
    slots.push(...inner);
  }
  return slots;
}

async function run(args: Args, ctx: ToolContext): Promise<ToolResult> {
  const { getHLConfig } = await import("../../inbox/services/highlevel-client");
  const { getBusinessInfo } = await import("../../inbox/services/business-info");
  const { schedulingTimeZone } = await import("../../inbox/services/scheduling-timezone");

  const cfg = await getHLConfig(ctx.workspaceId);
  if (!cfg) {
    return {
      ok: false,
      output: null,
      error: "HighLevel no está conectado para este workspace",
    };
  }

  const calendarId = resolveCalendarId(cfg.calendarId, args.calendar_id);
  if (!calendarId) {
    return {
      ok: false,
      output: null,
      error: "No hay un calendario de HighLevel configurado",
    };
  }

  // El rango y los horarios van en la zona de agenda del workspace (la del
  // negocio, la de HighLevel o la por defecto): la misma con la que schedule,
  // cancel y reschedule leen la fecha que el modelo copia de acá. Una zona
  // que pida el modelo ya no se acepta: sus slots se rechazarían allá.
  // `date_to` queda inclusivo hasta el final de ese día, en hora local.
  const tz = schedulingTimeZone(await getBusinessInfo(ctx.workspaceId), cfg.timezone);
  const range = zonedDayRange(args.date_from, args.date_to, tz);
  if (!range) {
    return { ok: false, output: null, error: "Fechas inválidas" };
  }
  const { startMs, endMs } = range;

  const params = new URLSearchParams({
    startDate: String(startMs),
    endDate: String(endMs),
    timezone: tz,
  });

  const res = await fetch(
    `https://services.leadconnectorhq.com/calendars/${calendarId}/free-slots?${params.toString()}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        // GET /calendars/{calendarId}/free-slots, HighLevel's OpenAPI spec.
        Version: "2021-04-15",
      },
    },
  );

  if (!res.ok) {
    // The raw body is HighLevel's own wording (English, internal ids): log
    // it, but give the model a plain reason it can relay.
    console.error(
      `[check_availability] HighLevel ${res.status}:`,
      (await res.text()).slice(0, 300),
    );
    return {
      ok: false,
      output: null,
      error: `El calendario de HighLevel respondió con un error (${res.status}); no se pudo consultar la disponibilidad. Dile al cliente que lo revisarás o pásalo a una persona.`,
    };
  }

  const data = (await res.json()) as FreeSlotsResponse;
  const all = readSlots(data);

  if (all === null) {
    return {
      ok: false,
      output: null,
      error:
        "El calendario respondió en un formato que no se pudo interpretar; no se sabe si hay horarios libres",
    };
  }

  const grouped = groupByDay(all, tz);
  return {
    ok: true,
    output: buildAvailabilityOutput(grouped, tz),
  };
}

export const checkAvailabilityTool: Tool<Args> = {
  name: "check_availability",
  description:
    "Consulta los horarios libres reales del calendario de HighLevel en un rango de fechas. Úsalo ANTES de agendar para ofrecer al cliente horarios que sí existen.",
  sensitivity: "read",
  schema,
  enabledFor: () => true,
  run,
};
