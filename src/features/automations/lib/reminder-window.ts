/**
 * The timing rules of an appointment reminder, shared by the scan that emits
 * it and the executor that sends it.
 */

const DEFAULT_QUIET_START = 8;
const DEFAULT_QUIET_END = 22;

/** Never less than this before the appointment, whatever the lead time. */
export const REMINDER_MIN_LEAD_MS = 30 * 60_000;

export interface ReminderConfig {
  hoursBefore: number;
  /** Local hour (0–23) from which reminders may go out. */
  quietStart: number;
  /** Local hour (0–23) from which they may not. */
  quietEnd: number;
}

/**
 * Validates an `appointment_upcoming` rule's trigger_config. The rule schema
 * rejects bad values before saving, but a legacy or corrupt row must not break
 * the tick: null, and the caller drops the rule.
 */
export function parseReminderConfig(raw: unknown): ReminderConfig | null {
  const cfg = raw as
    | { hours_before?: unknown; quiet_start?: unknown; quiet_end?: unknown }
    | null;

  const hoursBefore = Number(cfg?.hours_before);
  if (!Number.isFinite(hoursBefore) || hoursBefore < 1 || hoursBefore > 168) {
    return null;
  }

  const quietStart =
    cfg?.quiet_start === undefined ? DEFAULT_QUIET_START : Number(cfg.quiet_start);
  const quietEnd =
    cfg?.quiet_end === undefined ? DEFAULT_QUIET_END : Number(cfg.quiet_end);
  if (!Number.isInteger(quietStart) || quietStart < 0 || quietStart > 23) return null;
  if (!Number.isInteger(quietEnd) || quietEnd < 0 || quietEnd > 23) return null;

  return { hoursBefore, quietStart, quietEnd };
}

/** Local hour (0–23) of `now` in `tz`. An invalid `tz` makes Intl throw; the caller decides. */
export function localHour(tz: string, now: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(now),
  );
}

/** Whether `now` falls inside the rule's sending hours, in the business's zone. */
export function withinSendWindow(config: ReminderConfig, tz: string, now: Date): boolean {
  const hour = localHour(tz, now);
  return hour >= config.quietStart && hour < config.quietEnd;
}

/**
 * The least time before the appointment a reminder may still go out: half its
 * lead time, never under 30 minutes. A rule enabled today, or a scan catching
 * up after an outage, would otherwise send a "tomorrow" reminder an hour
 * before the appointment.
 */
export function reminderLeadFloorMs(config: ReminderConfig): number {
  return Math.max(REMINDER_MIN_LEAD_MS, (config.hoursBefore * 3_600_000) / 2);
}
