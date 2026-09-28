/**
 * The timing rules of an appointment reminder, shared by the scan that emits
 * it and the executor that sends it.
 *
 * A reminder is DUE `hours_before` before the appointment; if that falls
 * outside the rule's sending hours, it is due when they next open (the scan
 * emits it then). It goes out when due. It is skipped only when:
 *   - the appointment is less than 30 minutes away (or passed);
 *   - it was due before the rule was enabled (a rule switched on today does
 *     not send yesterday's reminders);
 *   - more than 30 minutes of sending hours passed since it was due (a
 *     backlog after an outage).
 * Outside the sending hours it waits for them to open.
 */

const DEFAULT_QUIET_START = 8;
const DEFAULT_QUIET_END = 22;

/** Never less than this before the appointment. */
export const REMINDER_MIN_LEAD_MS = 30 * 60_000;
/** How much of the sending hours a due reminder may wait before it is late. */
export const REMINDER_GRACE_MS = 30 * 60_000;

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
  if (quietStart >= quietEnd) return null;

  return { hoursBefore, quietStart, quietEnd };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Local hour and minute of `ms` in `tz`. An invalid `tz` makes Intl throw; the caller decides. */
function localClock(tz: string, ms: number): { hour: number; minute: number } {
  let fmt = formatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(tz, fmt);
  }
  let hour = 0;
  let minute = 0;
  for (const part of fmt.formatToParts(ms)) {
    if (part.type === "hour") hour = Number(part.value);
    if (part.type === "minute") minute = Number(part.value);
  }
  return { hour, minute };
}

/** Local hour (0–23) of `now` in `tz`. */
export function localHour(tz: string, now: Date): number {
  return localClock(tz, now.getTime()).hour;
}

/** Whether `now` falls inside the rule's sending hours, in the business's zone. */
export function withinSendWindow(config: ReminderConfig, tz: string, now: Date): boolean {
  const hour = localHour(tz, now);
  return hour >= config.quietStart && hour < config.quietEnd;
}

/** `ms` itself when it is inside the sending hours, else when they next open. */
export function nextWindowOpening(config: ReminderConfig, tz: string, ms: number): number {
  const { hour, minute } = localClock(tz, ms);
  if (hour >= config.quietStart && hour < config.quietEnd) return ms;
  const minuteStart = ms - (ms % 60_000);
  const hoursAhead = hour < config.quietStart ? config.quietStart - hour : 24 - hour + config.quietStart;
  return minuteStart + (hoursAhead * 60 - minute) * 60_000;
}

/** When the sending hours that contain `ms` close. */
function windowClose(config: ReminderConfig, tz: string, ms: number): number {
  const { hour, minute } = localClock(tz, ms);
  const minuteStart = ms - (ms % 60_000);
  return minuteStart + ((config.quietEnd - hour) * 60 - minute) * 60_000;
}

/** How much of the sending hours lies between `fromMs` and `toMs`. */
export function sendingTimeBetween(
  config: ReminderConfig,
  tz: string,
  fromMs: number,
  toMs: number,
): number {
  let elapsed = 0;
  let t = fromMs;
  for (let guard = 0; t < toMs && guard < 400; guard++) {
    const open = nextWindowOpening(config, tz, t);
    if (open >= toMs) break;
    const close = Math.min(toMs, windowClose(config, tz, open));
    elapsed += Math.max(0, close - open);
    t = close;
  }
  return elapsed;
}

/** When the reminder is due: `hours_before` ahead, moved to the sending hours. */
export function reminderDueAt(config: ReminderConfig, tz: string, scheduledMs: number): number {
  return nextWindowOpening(config, tz, scheduledMs - config.hoursBefore * 3_600_000);
}

export type ReminderTiming =
  | { action: "send" }
  | { action: "wait"; untilMs: number }
  | { action: "skip"; reason: "appointment_passed" | "reminder_too_close" | "reminder_too_late" };

/** What to do with a reminder at `nowMs`. */
export function reminderTiming(params: {
  config: ReminderConfig;
  tz: string;
  scheduledMs: number;
  nowMs: number;
  /** When the rule was last enabled; null when unknown. */
  enabledSinceMs: number | null;
}): ReminderTiming {
  const { config, tz, scheduledMs, nowMs, enabledSinceMs } = params;
  if (scheduledMs <= nowMs) return { action: "skip", reason: "appointment_passed" };
  if (scheduledMs - nowMs < REMINDER_MIN_LEAD_MS) {
    return { action: "skip", reason: "reminder_too_close" };
  }
  const dueMs = reminderDueAt(config, tz, scheduledMs);
  if (enabledSinceMs !== null && dueMs < enabledSinceMs) {
    return { action: "skip", reason: "reminder_too_late" };
  }
  if (!withinSendWindow(config, tz, new Date(nowMs))) {
    return { action: "wait", untilMs: nextWindowOpening(config, tz, nowMs) };
  }
  if (sendingTimeBetween(config, tz, dueMs, nowMs) > REMINDER_GRACE_MS) {
    return { action: "skip", reason: "reminder_too_late" };
  }
  return { action: "send" };
}
