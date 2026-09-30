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
const LONG_AGO = Date.UTC(2020, 0, 1);

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

// ── DST: openings and closes are wall-clock times ───────────────────────────

import { wallClockOf, wallClockToInstant } from "@/shared/lib/timezone";

const at = (tz: string, y: number, mo: number, d: number, h: number, mi = 0) =>
  wallClockToInstant({ year: y, month: mo, day: d, hour: h, minute: mi, second: 0 }, tz)!;
const wall = (tz: string, ms: number) => {
  const w = wallClockOf(ms, tz);
  return `${w.month}-${w.day} ${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
};

for (const [tz, spring, fall] of [
  ["Europe/Madrid", [3, 28], [10, 24]],
  ["America/New_York", [3, 7], [10, 31]],
] as const) {
  test(`${tz}: the sending hours open at 08:00 local on both DST nights`, () => {
    const w = { hoursBefore: 24, quietStart: 8, quietEnd: 22 };
    for (const [mo, d] of [spring, fall]) {
      const evening = at(tz, 2026, mo, d, 22, 30);
      const opening = nextWindowOpening(w, tz, evening);
      assert.equal(wall(tz, opening), `${mo === 10 && d === 31 ? "11-1" : `${mo}-${d + 1}`} 08:00`);
      assert.equal(withinSendWindow(w, tz, new Date(opening)), true, "woken inside the hours");
      assert.equal(withinSendWindow(w, tz, new Date(opening - MIN)), false, "not an hour late");
      // The night holds no sending time, however long it is.
      assert.equal(sendingTimeBetween(w, tz, at(tz, 2026, mo, d, 21, 50), opening + 10 * MIN), 20 * MIN);
    }
  });
}

test("an opening hour a DST change skips starts when the clock jumps past it", () => {
  const w = { hoursBefore: 1, quietStart: 2, quietEnd: 22 };
  const tz = "America/New_York";
  const opening = nextWindowOpening(w, tz, at(tz, 2026, 3, 8, 1, 30));
  assert.equal(wall(tz, opening), "3-8 03:00");
  assert.equal(opening - at(tz, 2026, 3, 8, 1, 30), 30 * MIN, "two in the morning never happens that night");
});

test("a reminder due in the night of a DST change goes out at the opening, not an hour off", () => {
  for (const tz of ["Europe/Madrid", "America/New_York"]) {
    const config = { hoursBefore: 24, quietStart: 8, quietEnd: 22 };
    for (const day of tz === "Europe/Madrid" ? [29, 25] : [8, 1]) {
      const month = tz === "Europe/Madrid" ? (day === 29 ? 3 : 10) : day === 8 ? 3 : 11;
      const appt = at(tz, 2026, month, day + 1, 3); // due at 03:00 local on the DST day
      const due = at(tz, 2026, month, day, 8);
      assert.deepEqual(
        reminderTiming({ config, tz, scheduledMs: appt, nowMs: due + MIN, enabledSinceMs: LONG_AGO }),
        { action: "send" },
        `${tz} ${month}-${day}`,
      );
    }
  }
});

// ── The scan's batch limit ──────────────────────────────────────────────────

/**
 * The scan as it runs: every minute inside the sending hours it asks
 * automation_reminder_candidates for up to 50 appointments that are due and
 * NOT emitted yet (booked with enough lead), earliest due first, and the
 * executor runs each on the next tick. This mirrors that SQL; pgTAP and the
 * database simulation check the SQL itself.
 */
function simulateBusyCalendar(opts: {
  hoursBefore: number;
  perDay: number;
  days: number;
  window: { quietStart: number; quietEnd: number };
  lateBookedEvery?: number;
}) {
  const config = { hoursBefore: opts.hoursBefore, ...opts.window };
  const h = opts.hoursBefore * HOUR;
  const start = local(5, 0);
  const appts: Array<{ at: number; created: number; emittedAt?: number; outcome?: string }> = [];
  const step = Math.floor((24 * 60) / opts.perDay) * MIN;
  for (let t = start + h; t < start + h + opts.days * 24 * HOUR; t += step) {
    const lateBooked = opts.lateBookedEvery && appts.length % opts.lateBookedEvery === 0;
    appts.push({ at: t, created: lateBooked ? t - 10 * MIN : LONG_AGO });
  }
  const end = appts[appts.length - 1].at;
  for (let tick = start; tick < end; tick += MIN) {
    if (!withinSendWindow(config, TZ, new Date(tick))) continue;
    const batch = appts
      .filter((a) => a.emittedAt === undefined && a.at > tick && a.at - h <= tick && a.created <= a.at - h)
      .sort((a, b) => a.at - b.at)
      .slice(0, 50);
    for (const a of batch) {
      a.emittedAt = tick;
      const timing = reminderTiming({ config, tz: TZ, scheduledMs: a.at, nowMs: tick + MIN, enabledSinceMs: LONG_AGO });
      a.outcome = timing.action === "skip" ? timing.reason : timing.action;
    }
  }
  let reachable = 0;
  let dropped = 0;
  for (const a of appts) {
    if (a.created > a.at - h) continue;
    let ok = false;
    for (let t = a.at - h; t < a.at; t += MIN) {
      if (withinSendWindow(config, TZ, new Date(t)) && a.at - (t + MIN) >= 30 * MIN) {
        ok = true;
        break;
      }
    }
    if (!ok) continue;
    reachable++;
    if (a.outcome !== "send") dropped++;
  }
  return { reachable, dropped };
}

for (const [hoursBefore, perDay, days] of [
  [24, 60, 3],
  [48, 30, 3],
  [168, 8, 10],
  [2, 200, 2],
] as const) {
  test(`busy calendar: h=${hoursBefore} with ${perDay} appointments a day drops nothing`, () => {
    const result = simulateBusyCalendar({
      hoursBefore,
      perDay,
      days,
      window: { quietStart: 8, quietEnd: 22 },
      lateBookedEvery: 5,
    });
    assert.ok(result.reachable > 50, `more than 50 in play (${result.reachable})`);
    assert.equal(result.dropped, 0);
  });
}
