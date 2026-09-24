import { z } from "zod";
import { zonedDayRange } from "@/features/tools/lib/slots";

export const MAX_ACTIVE_TOPICS = 10;
export const MAX_TAG_COLUMNS = 5;
export const MAX_RANGE_DAYS = 366;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PRESETS = ["7", "30", "90"] as const;

export type RangePreset = (typeof PRESETS)[number];

export const TopicInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Escribe un nombre para el tema.")
    .max(60, "El nombre puede tener hasta 60 caracteres."),
  description: z
    .string()
    .trim()
    .min(1, "Describe qué debe detectar este tema.")
    .max(500, "La descripción puede tener hasta 500 caracteres."),
});

export type TopicInput = z.infer<typeof TopicInputSchema>;

export interface InsightsRange {
  preset: RangePreset | null;
  fromDate: string;
  toDate: string;
  fromIso: string;
  /** Exclusivo: medianoche del día siguiente a toDate en la zona. */
  toIso: string;
  tags: string[];
}

type Params = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Las etiquetas viajan como parámetros REPETIDOS (`?tags=a&tags=b`), no
 * separadas por coma. Una etiqueta de contacto puede contener comas, y partirla por coma la convierte en dos
 * etiquetas que no existen. Un solo valor llega como string suelto.
 */
function all(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function isRealDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function todayIn(tz: string, now: Date): string {
  // en-CA formatea como YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function parseInsightsParams(
  params: Params,
  tz: string,
  now: Date = new Date(),
): { ok: true; value: InsightsRange } | { ok: false; error: string } {
  const tags = [...new Set(all(params.tags).map((t) => t.trim()).filter(Boolean))];
  if (tags.length > MAX_TAG_COLUMNS) {
    return { ok: false, error: "Puedes comparar hasta 5 etiquetas a la vez." };
  }

  // El análisis llega hasta el CIERRE DE AYER. Todo corte —preset,
  // rango explícito, universo y evidencia— usa este mismo último día.
  const lastDay = addDays(todayIn(tz, now), -1);

  const from = first(params.from);
  const to = first(params.to);
  let preset: RangePreset | null = null;
  let fromDate: string;
  let toDate: string;

  if (from !== undefined || to !== undefined) {
    if (!from || !to || !isRealDate(from) || !isRealDate(to)) {
      return { ok: false, error: "Las fechas del filtro no son válidas." };
    }
    if (from > to) {
      return { ok: false, error: "La fecha de inicio debe ser anterior a la de término." };
    }
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1;
    if (days > MAX_RANGE_DAYS) {
      return { ok: false, error: "El rango puede ser de hasta 366 días." };
    }
    // Se recorta, no se rechaza: pedir "hasta hoy" es razonable y la respuesta
    // correcta es mostrar hasta ayer, no un error.
    toDate = to > lastDay ? lastDay : to;
    if (from > toDate) {
      return { ok: false, error: "El análisis llega hasta ayer; elige un rango que termine antes de hoy." };
    }
    fromDate = from;
  } else {
    const requested = first(params.range);
    preset = (PRESETS as readonly string[]).includes(requested ?? "") ? (requested as RangePreset) : "30";
    toDate = lastDay;
    fromDate = addDays(toDate, -(Number(preset) - 1));
  }

  const range = zonedDayRange(fromDate, toDate, tz);
  if (!range) return { ok: false, error: "Las fechas del filtro no son válidas." };

  return {
    ok: true,
    value: {
      preset,
      fromDate,
      toDate,
      fromIso: new Date(range.startMs).toISOString(),
      toIso: new Date(range.endMs + 1).toISOString(),
      tags,
    },
  };
}

const MAX_RANGE_MS = (MAX_RANGE_DAYS + 1) * DAY_MS;

export const EvidenceInputSchema = z
  .object({
    topicId: z.uuid(),
    outcome: z.enum(["all", "booked", "handed_off", "tag"]),
    tag: z.string().trim().min(1).max(100).optional(),
    page: z.number().int().min(0).max(1000),
    fromIso: z.iso.datetime(),
    toIso: z.iso.datetime(),
  })
  .refine((v) => v.outcome !== "tag" || Boolean(v.tag), { path: ["tag"] })
  .refine((v) => Date.parse(v.fromIso) < Date.parse(v.toIso), { path: ["toIso"] })
  .refine((v) => Date.parse(v.toIso) - Date.parse(v.fromIso) <= MAX_RANGE_MS, { path: ["fromIso"] });

export type EvidenceInput = z.infer<typeof EvidenceInputSchema>;
