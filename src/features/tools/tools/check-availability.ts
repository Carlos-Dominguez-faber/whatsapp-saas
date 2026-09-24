import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../core/tool";
import {
  buildAvailabilityOutput,
  groupByDay,
  resolveTimeZone,
  zonedDayRange,
} from "../lib/slots";

const schema = z.object({
  date_from: z
    .string()
    .describe("Fecha inicial del rango a consultar (ISO, ej: 2026-06-12)"),
  date_to: z.string().describe("Fecha final del rango (ISO, ej: 2026-06-19)"),
  timezone: z
    .string()
    .optional()
    .describe("Zona horaria IANA, ej: America/Mexico_City"),
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

  const cfg = await getHLConfig(ctx.workspaceId);
  if (!cfg) {
    return {
      ok: false,
      output: null,
      error: "HighLevel no está conectado para este workspace",
    };
  }

  const calendarId = args.calendar_id ?? cfg.calendarId;
  if (!calendarId) {
    return {
      ok: false,
      output: null,
      error: "No hay un calendario de HighLevel configurado",
    };
  }

  // El rango se interpreta en la zona del workspace (o la que pida el LLM):
  // `date_to` queda inclusivo hasta el final de ese día, en hora local.
  // La zona del LLM es texto libre: si no es una zona IANA válida se cae a la
  // del workspace y el output lo declara, en vez de etiquetar una zona que no
  // se usó (el bot ofrecía "12:00" que en Santiago eran las 09:00).
  const tz = resolveTimeZone(args.timezone, cfg.timezone);
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
        Version: "2021-07-28",
      },
    },
  );

  if (!res.ok) {
    const err = await res.text();
    return {
      ok: false,
      output: null,
      error: `HL API error: ${res.status} ${err.slice(0, 150)}`,
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
    output: buildAvailabilityOutput(grouped, tz, args.timezone),
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
