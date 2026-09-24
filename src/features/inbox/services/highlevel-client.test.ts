import assert from "node:assert/strict";
import { test } from "node:test";
import { findActiveHLAppointmentByContact } from "./highlevel-client.ts";
import type { HLConfig } from "./highlevel-client.ts";

const cfg: HLConfig = {
  token: "tok_123",
  locationId: "loc_1",
  calendarId: null,
  pipelineId: null,
  pipelineStageId: null,
  timezone: "UTC",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// HighLevel's startTime has no timezone offset (verified against the live
// v3 docs: "startTime": "2021-07-16 11:00:00") — this helper
// produces fixtures in that exact shape, not an idealized ISO string, so
// these tests exercise the real format the client has to parse.
function hlTime(d: Date): string {
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

test("picks the earliest active appointment among today's/future ones, ignoring non-active statuses", async () => {
  const now = Date.now();
  const soon = hlTime(new Date(now + 3600_000)); // 1h from now — expected pick
  const later = hlTime(new Date(now + 7200_000)); // 2h from now — later, not picked
  const clearlyPast = hlTime(new Date(now - 3 * 24 * 3600_000)); // 3 days ago — must be ignored

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    jsonResponse(200, {
      events: [
        { id: "evt_past", status: "booked", startTime: clearlyPast },
        { id: "evt_cancelled", status: "cancelled", startTime: soon },
        { id: "evt_later", status: "confirmed", startTime: later },
        { id: "evt_soon", status: "booked", startTime: soon },
      ],
    })) as typeof fetch;

  try {
    const result = await findActiveHLAppointmentByContact(cfg, "hl_contact_1", "UTC");
    assert.deepEqual(result, {
      id: "evt_soon",
      status: "booked",
      startTime: soon,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps an appointment that started a few minutes ago (in progress), not just strictly-future ones", async () => {
  const startedRecently = hlTime(new Date(Date.now() - 10 * 60_000)); // 10 min ago
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    jsonResponse(200, {
      events: [
        { id: "evt_in_progress", status: "booked", startTime: startedRecently },
      ],
    })) as typeof fetch;

  try {
    const result = await findActiveHLAppointmentByContact(cfg, "hl_contact_1", "UTC");
    assert.deepEqual(result, {
      id: "evt_in_progress",
      status: "booked",
      startTime: startedRecently,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns null when every active appointment is clearly in the past", async () => {
  const clearlyPast = hlTime(new Date(Date.now() - 3 * 24 * 3600_000));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    jsonResponse(200, {
      events: [{ id: "evt_past", status: "booked", startTime: clearlyPast }],
    })) as typeof fetch;

  try {
    const result = await findActiveHLAppointmentByContact(cfg, "hl_contact_1", "UTC");
    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns null (never throws) when the HighLevel API call fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("Internal Server Error", { status: 500 })) as typeof fetch;

  try {
    const result = await findActiveHLAppointmentByContact(cfg, "hl_contact_1", "UTC");
    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("prefers a genuinely future appointment over a stale one that only survived the past-exclusion slack", async () => {
  const now = Date.now();
  // Anchored by calendar-date arithmetic (Date.UTC), not a fixed millisecond
  // delta — "now minus N hours" doesn't reliably land on yesterday's date
  // (it depends on what time of day the test happens to run), so a delta
  // here would be flaky. Noon UTC on the calendar day before today always
  // has a date prefix exactly one day less than today's, matching the
  // cutoff the implementation itself computes (also `Date.now()`-based),
  // regardless of what time "now" is.
  const todayDate = new Date(now).toISOString().slice(0, 10);
  const [y, m, d] = todayDate.split("-").map(Number);
  const staleYesterday = hlTime(new Date(Date.UTC(y, m - 1, d - 1, 12, 0, 0)));
  const futureInTwoDays = hlTime(new Date(now + 48 * 3600_000));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    jsonResponse(200, {
      events: [
        { id: "evt_stale", status: "booked", startTime: staleYesterday },
        { id: "evt_future", status: "booked", startTime: futureInTwoDays },
      ],
    })) as typeof fetch;

  try {
    const result = await findActiveHLAppointmentByContact(cfg, "hl_contact_1", "UTC");
    assert.deepEqual(result, {
      id: "evt_future",
      status: "booked",
      startTime: futureInTwoDays,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scopes the fallback lookup to the workspace's configured calendar, ignoring appointments on other calendars", async () => {
  const scopedCfg: HLConfig = { ...cfg, calendarId: "cal_A" };
  const now = Date.now();
  // The other-calendar appointment is chronologically earlier — if calendarId
  // filtering weren't applied, the plain earliest-first sort would wrongly
  // pick it over the correct-calendar one.
  const otherCalendarSoon = hlTime(new Date(now + 3600_000));
  const sameCalendarLater = hlTime(new Date(now + 7200_000));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    jsonResponse(200, {
      events: [
        {
          id: "evt_other_cal",
          status: "booked",
          startTime: otherCalendarSoon,
          calendarId: "cal_B",
        },
        {
          id: "evt_target_cal",
          status: "booked",
          startTime: sameCalendarLater,
          calendarId: "cal_A",
        },
      ],
    })) as typeof fetch;

  try {
    const result = await findActiveHLAppointmentByContact(
      scopedCfg,
      "hl_contact_1",
      "UTC",
    );
    assert.deepEqual(result, {
      id: "evt_target_cal",
      status: "booked",
      startTime: sameCalendarLater,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("prefers a still-upcoming same-day appointment over one that already elapsed earlier today", async () => {
  const now = Date.now();
  const elapsedEarlierToday = hlTime(new Date(now - 3 * 3600_000)); // 3h ago
  const stillUpcomingToday = hlTime(new Date(now + 3 * 3600_000)); // 3h from now

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    jsonResponse(200, {
      events: [
        { id: "evt_elapsed", status: "booked", startTime: elapsedEarlierToday },
        { id: "evt_upcoming", status: "booked", startTime: stillUpcomingToday },
      ],
    })) as typeof fetch;

  try {
    const result = await findActiveHLAppointmentByContact(cfg, "hl_contact_1", "UTC");
    assert.deepEqual(result, {
      id: "evt_upcoming",
      status: "booked",
      startTime: stillUpcomingToday,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not misclassify a still-upcoming local appointment as past when UTC has already rolled to the next calendar date (negative-offset timezone)", async () => {
  const tz = "Etc/GMT+5"; // fixed UTC-5, no DST — representative of a LatAm business
  // Local wall-clock "now" is 2026-08-21 23:30:00 in this zone, which is
  // 2026-08-22 04:30:00 UTC — UTC's calendar date has already rolled over to
  // the 22nd while it's still the 21st locally.
  const now = new Date("2026-08-22T04:30:00.000Z");
  const stillUpcomingLocal = "2026-08-21 23:50:00"; // 20 min later, local
  const genuinelyLaterLocal = "2026-08-23 09:00:00"; // 2 local days later — must lose

  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  Date.now = () => now.getTime();
  globalThis.fetch = (async () =>
    jsonResponse(200, {
      events: [
        { id: "evt_soonest", status: "booked", startTime: stillUpcomingLocal },
        { id: "evt_later", status: "booked", startTime: genuinelyLaterLocal },
      ],
    })) as typeof fetch;

  try {
    const result = await findActiveHLAppointmentByContact(cfg, "hl_contact_1", tz);
    assert.deepEqual(result, {
      id: "evt_soonest",
      status: "booked",
      startTime: stillUpcomingLocal,
    });
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalDateNow;
  }
});
