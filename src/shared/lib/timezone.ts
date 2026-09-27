/**
 * timezone.ts — the one resolver for a workspace's time zone.
 *
 * The prompt's "now" and check_availability used to resolve zones on their
 * own, with different fallbacks (the default zone vs. UTC), so the agent could
 * say one time and offer slots in another.
 */

export const DEFAULT_TIMEZONE = "America/Mexico_City";

/**
 * An IANA zone name ("America/Mexico_City", "Etc/GMT+5", "UTC") the runtime
 * knows. Offsets ("-05:00") and abbreviations ("EST", "CST") are refused even
 * where Intl would take them: they carry no DST rules, so the same wall-clock
 * time would be wrong half the year.
 */
export function isIanaTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string") return false;
  const name = tz.trim();
  if (name !== "UTC" && !/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/.test(name)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** The first candidate that is a valid IANA zone, else DEFAULT_TIMEZONE. */
export function resolveTimeZone(
  ...candidates: Array<string | null | undefined>
): string {
  for (const tz of candidates) {
    if (isIanaTimeZone(tz)) return tz.trim();
  }
  return DEFAULT_TIMEZONE;
}
