// F7: Business info loader — loads structured + free_text data to inject into system prompts.

import { createClient as createSbClient } from "@supabase/supabase-js";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export interface BusinessInfo {
  structured: Record<string, unknown>;
  free_text: string | null;
}

/**
 * Loads business info for a workspace from the business_info table.
 * Returns null when no record exists yet.
 */
export async function getBusinessInfo(
  workspaceId: string,
): Promise<BusinessInfo | null> {
  const supabase = svc();

  const { data, error } = await supabase
    .from("business_info")
    .select("structured, free_text")
    .eq("workspace_id", workspaceId)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[business-info] getBusinessInfo error:", error);
    return null;
  }

  if (!data) return null;

  return {
    structured: (data.structured as Record<string, unknown>) ?? {},
    free_text: data.free_text ?? null,
  };
}

/** UTC offset (e.g. "-05:00") for a timezone right now. */
function offsetFor(timeZone: string, now: Date): string {
  const raw =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(now)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
  // "GMT-05:00" → "-05:00"; "GMT" (UTC) → "+00:00"
  return raw.replace("GMT", "") || "+00:00";
}

/**
 * Renders the next 7 calendar days in `timeZone` as "- <día>: YYYY-MM-DD" lines.
 *
 * Anchors "today" once via Intl (the only place `timeZone`-aware wall-clock
 * conversion happens), then advances by pure calendar-day arithmetic in UTC
 * space (`Date.UTC` normalizes day-of-month overflow). This is immune to
 * `timeZone`'s DST transitions — adding fixed 24h instants is not, because a
 * DST shift changes how many wall-clock hours a UTC day spans locally, which
 * can skip or duplicate a calendar date (see business-info.test.ts's DST
 * regression test).
 */
export function buildUpcomingDaysTable(timeZone: string, now: Date): string {
  const lines: string[] = ["## Próximos 7 días"];
  const todayIso = now.toLocaleDateString("en-CA", { timeZone }); // "YYYY-MM-DD" anchor
  const [year, month, day] = todayIso.split("-").map(Number);
  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(Date.UTC(year, month - 1, day + i));
    const isoDate = dayDate.toISOString().slice(0, 10);
    // The weekday for a calendar date doesn't depend on the viewing timezone
    // once the date itself is correct — format against UTC to avoid a second
    // timeZone-aware conversion.
    const dayName = dayDate.toLocaleDateString("es-MX", {
      timeZone: "UTC",
      weekday: "long",
    });
    // Noon UTC of this calendar date is safely past every real-world DST
    // transition time (which happens in the small hours local), so it
    // always resolves to the offset that applies for the rest of that local
    // day — unlike reusing "now"'s offset, which is wrong for a date on the
    // other side of a DST change.
    const dayOffset = offsetFor(
      timeZone,
      new Date(Date.UTC(year, month - 1, day + i, 12)),
    );
    lines.push(`- ${dayName}: ${isoDate} (offset ${dayOffset})`);
  }
  return lines.join("\n");
}

const DEFAULT_TIMEZONE = "America/Mexico_City";

/**
 * True when `tz` is a timezone the runtime's Intl implementation can
 * resolve. `Intl.DateTimeFormat` throws RangeError synchronously for an
 * unrecognized IANA zone — this is the standard way to validate one.
 */
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * A workspace admin can save an arbitrary string as the business timezone
 * (business_info.structured.timezone has no server-side IANA validation).
 * An invalid one used to throw uncaught here, dead-lettering every message
 * in the workspace after 3 retries — fall back to the default instead.
 */
export function buildNowContext(timeZone = DEFAULT_TIMEZONE): string {
  const tz = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIMEZONE;
  if (tz !== timeZone) {
    console.warn(
      `[business-info] buildNowContext: invalid timezone "${timeZone}", falling back to ${DEFAULT_TIMEZONE}`,
    );
  }
  const now = new Date();
  const human = now.toLocaleString("es-MX", {
    timeZone: tz,
    dateStyle: "full",
    timeStyle: "short",
  });
  const offset = offsetFor(tz, now);
  const upcoming = buildUpcomingDaysTable(tz, now);
  return `## Fecha actual\nHoy es ${human} (zona horaria ${tz}, offset ${offset}).\n\n${upcoming}\n\nUsa esta tabla para resolver referencias como "el martes", "mañana", "en 3 días", etc. — copia la fecha exacta de la tabla, no la calcules tú. Cuando agendes, construye las horas en ISO con el offset que aparece junto a esa fecha en la tabla (no siempre es el mismo que el de "Hoy es...", puede cambiar por horario de verano), y pasa la zona horaria ${tz} a la herramienta de disponibilidad.`;
}

/**
 * Formats business info into a string block suitable for injection
 * at the top of an AI system prompt.
 * Returns an empty string when info is null.
 */
export function buildBusinessInfoContext(info: BusinessInfo | null): string {
  if (!info) return "";

  const lines: string[] = ["## Información del Negocio"];

  const hasStructured =
    info.structured && Object.keys(info.structured).length > 0;

  if (hasStructured) {
    lines.push(JSON.stringify(info.structured, null, 2));
  }

  if (info.free_text) {
    if (hasStructured) lines.push("");
    lines.push(info.free_text);
  }

  if (!hasStructured && !info.free_text) return "";

  return lines.join("\n");
}

/**
 * Upserts business info for a workspace.
 * Merges partial updates — only provided fields are overwritten.
 */
export async function upsertBusinessInfo(
  workspaceId: string,
  data: Partial<BusinessInfo>,
): Promise<void> {
  const supabase = svc();

  const payload: Record<string, unknown> = {
    workspace_id: workspaceId,
    updated_at: new Date().toISOString(),
  };

  if (data.structured !== undefined) payload.structured = data.structured;
  if (data.free_text !== undefined) payload.free_text = data.free_text;

  const { error } = await supabase
    .from("business_info")
    .upsert(payload, { onConflict: "workspace_id" });

  if (error) {
    console.error("[business-info] upsertBusinessInfo error:", error);
    throw new Error(`Failed to upsert business info: ${error.message}`);
  }
}
