import assert from "node:assert/strict";
import { test } from "node:test";
import {
  nextWindowOpening,
  reminderTiming,
  sendingTimeBetween,
  withinSendWindow,
  type ReminderConfig,
} from "./reminder-window.ts";

// UTC-6 all year (no DST), like central Mexico.
const TZ = "Etc/GMT+6";
const MIN = 60_000;
const HOUR = 60 * MIN;
/** Local wall time on 2026-10-<day> in TZ, as epoch ms. */
const local = (day: number, h: number, m = 0) => Date.UTC(2026, 9, day, h, m) + 6 * HOUR;
const LONG_AGO = local(1, 0);

/**
 * One reminder the way production handles it: the scan ticks every minute and
 * emits on the first tick inside the sending hours at or after `appt - h`
 * while the appointment is still ahead (scan-time.ts); the executor runs it on
 * the next tick. Returns what the executor decides, or null if never emitted.
 */
function simulate(config: ReminderConfig, apptMs: number): string | null {
  for (let t = apptMs - config.hoursBefore * HOUR; t < apptMs; t += MIN) {
    if (!withinSendWindow(config, TZ, new Date(t))) continue;
    const runAt = t + MIN;
    const timing = reminderTiming({
      config,
      tz: TZ,
      scheduledMs: apptMs,
      nowMs: runAt,
      enabledSinceMs: LONG_AGO,
    });
    return timing.action === "skip" ? timing.reason : timing.action;
  }
  return null;
}

test("normal operation drops no daytime reminder: every appointment reachable 30+ min ahead gets one", () => {
  const windows = [
    { quietStart: 8, quietEnd: 22 },
    { quietStart: 9, quietEnd: 18 },
  ];
  const leads = [2, 3, 6, 12, 18, 24, 48];
  let checked = 0;
  for (const w of windows) {
    for (const hoursBefore of leads) {
      const config = { hoursBefore, ...w };
      for (let minute = 0; minute < 24 * 60; minute += 15) {
        const appt = local(20, 0, minute);
        const outcome = simulate(config, appt);
        // Reachable: some minute inside the sending hours at or after the due
        // time leaves the executor 30+ minutes before the appointment.
        let reachable = false;
        for (let t = appt - hoursBefore * HOUR; t < appt; t += MIN) {
          if (withinSendWindow(config, TZ, new Date(t)) && appt - (t + MIN) >= 30 * MIN) {
            reachable = true;
            break;
          }
        }
        const label = `${w.quietStart}-${w.quietEnd} h=${hoursBefore} appt ${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
        if (reachable) {
          assert.equal(outcome, "send", label);
        } else {
          assert.notEqual(outcome, "send", label);
        }
        checked++;
      }
    }
  }
  assert.equal(checked, 2 * 7 * 96);
});

test("the slices the review found dropped now all go out", () => {
  // h=6 from 08:35: before that the first tick of the day (08:01) is already
  // within 30 minutes of the appointment, the floor that stays.
  const cases: Array<[ReminderConfig, number, number]> = [
    [{ hoursBefore: 12, quietStart: 8, quietEnd: 22 }, local(20, 10), local(20, 14)],
    [{ hoursBefore: 6, quietStart: 8, quietEnd: 22 }, local(20, 8, 35), local(20, 11)],
    [{ hoursBefore: 24, quietStart: 9, quietEnd: 18 }, local(20, 18), local(20, 21)],
  ];
  for (const [config, from, to] of cases) {
    for (let appt = from; appt <= to; appt += 5 * MIN) {
      assert.equal(simulate(config, appt), "send", `h=${config.hoursBefore} ${new Date(appt).toISOString()}`);
    }
  }
});

test("a reminder emitted just before the sending hours close waits for them to reopen, then goes out", () => {
  const config = { hoursBefore: 24, quietStart: 8, quietEnd: 22 };
  const appt = local(21, 21, 59); // due 20th 21:59, the executor runs at 22:00
  const atClose = reminderTiming({ config, tz: TZ, scheduledMs: appt, nowMs: local(20, 22), enabledSinceMs: LONG_AGO });
  assert.deepEqual(atClose, { action: "wait", untilMs: local(21, 8) });
  const atOpen = reminderTiming({ config, tz: TZ, scheduledMs: appt, nowMs: local(21, 8, 1), enabledSinceMs: LONG_AGO });
  assert.deepEqual(atOpen, { action: "send" });
});

test("a genuine catch-up is skipped: rule enabled after the due time, or a backlog past the grace", () => {
  const config = { hoursBefore: 24, quietStart: 8, quietEnd: 22 };
  const appt = local(21, 10); // due 20th 10:00
  assert.deepEqual(
    reminderTiming({ config, tz: TZ, scheduledMs: appt, nowMs: local(20, 15), enabledSinceMs: local(20, 14) }),
    { action: "skip", reason: "reminder_too_late" },
  );
  assert.deepEqual(
    reminderTiming({ config, tz: TZ, scheduledMs: appt, nowMs: local(20, 10, 45), enabledSinceMs: LONG_AGO }),
    { action: "skip", reason: "reminder_too_late" },
  );
  assert.deepEqual(
    reminderTiming({ config, tz: TZ, scheduledMs: appt, nowMs: local(20, 10, 20), enabledSinceMs: LONG_AGO }),
    { action: "send" },
  );
});

test("never less than 30 minutes before the appointment, and never after it", () => {
  const config = { hoursBefore: 2, quietStart: 8, quietEnd: 22 };
  assert.deepEqual(
    reminderTiming({ config, tz: TZ, scheduledMs: local(20, 12), nowMs: local(20, 11, 45), enabledSinceMs: LONG_AGO }),
    { action: "skip", reason: "reminder_too_close" },
  );
  assert.deepEqual(
    reminderTiming({ config, tz: TZ, scheduledMs: local(20, 12), nowMs: local(20, 12, 5), enabledSinceMs: LONG_AGO }),
    { action: "skip", reason: "appointment_passed" },
  );
});

test("window arithmetic: next opening and sending time across a night", () => {
  const w = { hoursBefore: 1, quietStart: 8, quietEnd: 22 };
  assert.equal(nextWindowOpening(w, TZ, local(20, 7, 30)), local(20, 8));
  assert.equal(nextWindowOpening(w, TZ, local(20, 22, 10)), local(21, 8));
  assert.equal(nextWindowOpening(w, TZ, local(20, 12, 34)), local(20, 12, 34));
  assert.equal(sendingTimeBetween(w, TZ, local(20, 21, 50), local(21, 8, 10)), 20 * MIN);
});
