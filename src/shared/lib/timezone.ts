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

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock reading of instant `ms` in `tz`. */
export function wallClockOf(ms: number, tz: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function sameWallClock(a: WallClock, b: WallClock): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second
  );
}

/**
 * The instant at which the clock in `tz` reads `wall`, or null when it never
 * does: an impossible date (February 30) or a time skipped by a DST change.
 * An ambiguous time (the repeated hour when clocks go back) gives the first.
 */
export function wallClockToInstant(wall: WallClock, tz: string): number | null {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  if (Number.isNaN(asUtc)) return null;
  // The offset measured at the naive instant may belong to the other side of
  // a DST change; measuring again at the first guess settles it.
  const offsetAt = (ms: number) => {
    const w = wallClockOf(ms, tz);
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - ms;
  };
  const first = asUtc - offsetAt(asUtc);
  const second = asUtc - offsetAt(first);
  for (const candidate of [Math.min(first, second), Math.max(first, second)]) {
    if (sameWallClock(wallClockOf(candidate, tz), wall)) return candidate;
  }
  return null;
}

/** `YYYY-MM-DDTHH:mm:ss±HH:MM` for instant `ms`, with `tz`'s offset then. */
export function formatWithOffset(ms: number, tz: string): string {
  const w = wallClockOf(ms, tz);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  const offsetMin = Math.round(
    (Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - ms) / 60_000,
  );
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  return (
    `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}
