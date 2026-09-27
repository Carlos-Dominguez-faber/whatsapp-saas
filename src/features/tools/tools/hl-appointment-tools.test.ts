import assert from "node:assert/strict";
import { test } from "node:test";
import { cancelHighLevelTool } from "./cancel-highlevel.ts";
import { rescheduleHighLevelTool } from "./reschedule-highlevel.ts";
import { listHighLevelAppointmentsTool } from "./list-highlevel-appointments.ts";
import { parseHLTime } from "../lib/hl-appointment.ts";
import type { ToolContext } from "../core/tool";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

// ── HTTP-level fake: Supabase REST + HighLevel ──────────────────────────────

interface LocalAppointment {
  id: string;
  hl_appointment_id: string | null;
  status: string;
  scheduled_at: string;
  meta?: Record<string, unknown>;
}

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Applies PostgREST's scheduled_at=gte./lte., status=in.() and
 * hl_appointment_id=eq. filters to the fixture rows.
 */
function filterRows(url: string, rows: LocalAppointment[]) {
  const search = new URL(url).searchParams;
  const params = search.getAll("scheduled_at");
  const statusIn = search.get("status")?.match(/^in\.\((.*)\)$/)?.[1].split(",");
  const hlId = search.get("hl_appointment_id")?.match(/^eq\.(.*)$/)?.[1];
  return rows.filter((row) => {
    const at = Date.parse(row.scheduled_at);
    if (statusIn && !statusIn.includes(row.status)) return false;
    if (hlId !== undefined && row.hl_appointment_id !== hlId) return false;
    return params.every((p) => {
      const [op, ...rest] = p.split(".");
      const bound = Date.parse(decodeURIComponent(rest.join(".")).replace(/"/g, ""));
      return op === "gte" ? at >= bound : op === "lte" ? at <= bound : true;
    });
  });
}

function hlFetch(opts: {
  local?: LocalAppointment[];
  calendarId?: string | null;
  contactHlId?: string | null;
  /** The business's zone; null leaves it unset. */
  timezone?: string | null;
  /** The HighLevel integration's configured zone. */
  hlTimezone?: string;
  hlContactEvents?: Array<Record<string, unknown>>;
  /** GET /calendars/events/appointments/{id} → { event } (null: 404). */
  hlEvent?: Record<string, unknown> | null;
  /** The same, per appointment id; ids not listed fall back to hlEvent. */
  hlEvents?: Record<string, Record<string, unknown> | null>;
  hlEventStatus?: number;
  putStatus?: number;
  putThrows?: boolean;
}) {
  const calls: FetchCall[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    if (url.includes("/rest/v1/integrations")) {
      return json(200, [
        {
          credentials: { highlevel_pit: "tok_123" },
          config: {
            location_id: "loc_1",
            calendar_id: opts.calendarId ?? null,
            ...(opts.hlTimezone ? { timezone: opts.hlTimezone } : {}),
          },
          enabled: true,
        },
      ]);
    }
    if (url.includes("/rest/v1/business_info")) {
      return json(
        200,
        opts.timezone === null
          ? []
          : [{ structured: { timezone: opts.timezone ?? "America/Mexico_City" }, free_text: null }],
      );
    }
    if (url.includes("/rest/v1/appointments")) {
      if (method === "GET") return json(200, filterRows(url, opts.local ?? []));
      return new Response(null, { status: 201 });
    }
    if (url.includes("/rest/v1/contacts")) {
      return json(200, opts.contactHlId !== undefined ? [{ hl_contact_id: opts.contactHlId }] : []);
    }
    if (url.includes("/rest/v1/messages")) {
      return method === "GET" ? json(200, []) : new Response(null, { status: 201 });
    }
    if (url.includes("leadconnectorhq.com/contacts/")) {
      return json(200, { events: opts.hlContactEvents ?? [] });
    }
    if (url.includes("leadconnectorhq.com/calendars/events/appointments/")) {
      if (method === "PUT") {
        if (opts.putThrows) throw new Error("socket hang up");
        return json(opts.putStatus ?? 200, {});
      }
      const id = url.split("/").pop()!;
      const event = opts.hlEvents && id in opts.hlEvents ? opts.hlEvents[id] : opts.hlEvent;
      if (event === null) return json(404, {});
      // By default HighLevel has it live, with no start time to compare.
      return json(opts.hlEventStatus ?? 200, {
        event: event ?? { appointmentStatus: "confirmed" },
      });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
  return { fn, calls };
}

const puts = (calls: FetchCall[]) =>
  calls.filter((c) => c.method === "PUT" && c.url.includes("/calendars/events/appointments/"));
const notesIn = (calls: FetchCall[]) =>
  calls.filter((c) => c.method === "POST" && c.url.includes("/rest/v1/messages"));
const hlCalls = (calls: FetchCall[]) => calls.filter((c) => c.url.includes("leadconnectorhq"));
const localWrites = (calls: FetchCall[]) =>
  calls.filter((c) => c.url.includes("/rest/v1/appointments") && c.method !== "GET");

async function withFetch<T>(fake: { fn: typeof fetch }, body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fake.fn as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

const ctx: ToolContext = {
  workspaceId: "ws_1",
  conversationId: "conv_1",
  contactId: "contact_1",
  batchId: "batch_1",
};

// Mexico City is -06:00 all year: 10:00 local = 16:00Z.
const CONFIRMED = "2030-06-12T10:00:00-06:00";
const CONFIRMED_UTC = "2030-06-12T16:00:00.000Z";
const NEW_TIME = "2030-06-15T12:00:00-06:00";
const NEW_TIME_UTC = "2030-06-15T18:00:00.000Z";
const active = (id: string, at: string, meta?: Record<string, unknown>): LocalAppointment => ({
  id,
  hl_appointment_id: `hl_${id}`,
  status: "booked",
  scheduled_at: at,
  meta,
});

// ── cancel_highlevel ────────────────────────────────────────────────────────

test("cancel: cancels the appointment at the confirmed time, with the spec's Version header", async () => {
  const fake = hlFetch({ local: [active("a1", CONFIRMED_UTC)] });
  const result = await withFetch(fake, () =>
    cancelHighLevelTool.run({ appointment_datetime_iso: CONFIRMED }, ctx),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { cancelled: true });
  const [put] = puts(fake.calls);
  assert.ok(put.url.endsWith("/appointments/hl_a1"));
  assert.deepEqual(put.body, { appointmentStatus: "cancelled" });
  assert.equal(put.headers.Version, "2021-04-15");
});

test("cancel: an offset that isn't the zone's at that date is refused; nothing is guessed", async () => {
  // New York in July is -04:00. "10:00-05:00" names 15:00Z, which reads 11:00
  // there: a time copied from another zone (or a winter date). Refused.
  const wrong = hlFetch({
    timezone: "America/New_York",
    local: [active("a1", "2030-07-15T14:00:00.000Z"), active("a2", "2030-07-15T15:00:00.000Z")],
  });
  const refused = await withFetch(wrong, () =>
    cancelHighLevelTool.run({ appointment_datetime_iso: "2030-07-15T10:00:00-05:00" }, ctx),
  );
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? "", /America\/New_York/);
  assert.match(refused.error ?? "", /vuelve a consultar/);
  assert.equal(hlCalls(wrong.calls).length, 0);
  assert.equal(localWrites(wrong.calls).length, 0);

  // The zone's own offset names the instant it says.
  const right = hlFetch({
    timezone: "America/New_York",
    local: [active("a1", "2030-07-15T14:00:00.000Z")],
  });
  const done = await withFetch(right, () =>
    cancelHighLevelTool.run({ appointment_datetime_iso: "2030-07-15T10:00:00-04:00" }, ctx),
  );
  assert.equal(done.ok, true);
  assert.ok(puts(right.calls)[0].url.endsWith("/appointments/hl_a1"));
});

test("cancel: an impossible date or a past appointment is refused before calling anything", async () => {
  for (const iso of ["2030-02-30T10:00:00-06:00", "2020-06-12T10:00:00-06:00"]) {
    const fake = hlFetch({});
    const result = await withFetch(fake, () =>
      cancelHighLevelTool.run({ appointment_datetime_iso: iso }, ctx),
    );
    assert.equal(result.ok, false, iso);
    assert.ok(!fake.calls.some((c) => c.url.includes("leadconnectorhq")), iso);
  }
});

test("cancel: a local row already cancelled is confirmed with HighLevel before saying so", async () => {
  const cancelledHere = { ...active("a1", CONFIRMED_UTC), status: "cancelled" };
  const already = hlFetch({ local: [cancelledHere], hlEvent: { appointmentStatus: "cancelled" } });
  const r1 = await withFetch(already, () =>
    cancelHighLevelTool.run({ appointment_datetime_iso: CONFIRMED }, ctx),
  );
  assert.deepEqual(r1.output, { cancelled: true, already_cancelled: true });
  assert.equal(puts(already.calls).length, 0);

  // Stale locally, still booked in HighLevel: it gets cancelled.
  const stale = hlFetch({ local: [cancelledHere], hlEvent: { appointmentStatus: "confirmed" } });
  const r2 = await withFetch(stale, () =>
    cancelHighLevelTool.run({ appointment_datetime_iso: CONFIRMED }, ctx),
  );
  assert.deepEqual(r2.output, { cancelled: true });
  assert.equal(puts(stale.calls).length, 1);
});

test("cancel: two active appointments at the same time are ambiguous: none is cancelled, a person is told", async () => {
  const fake = hlFetch({ local: [active("a1", CONFIRMED_UTC), active("a2", CONFIRMED_UTC)] });
  const result = await withFetch(fake, () =>
    cancelHighLevelTool.run({ appointment_datetime_iso: CONFIRMED }, ctx),
  );
  assert.equal(result.ok, false);
  assert.equal(puts(fake.calls).length, 0);
  assert.equal(notesIn(fake.calls).length, 1);
});

test("cancel: a HighLevel 5xx or no answer is an unknown outcome: it throws, and a person is told", async () => {
  for (const variant of [{ putStatus: 502 }, { putThrows: true }]) {
    const fake = hlFetch({ local: [active("a1", CONFIRMED_UTC)], ...variant });
    await assert.rejects(
      withFetch(fake, () => cancelHighLevelTool.run({ appointment_datetime_iso: CONFIRMED }, ctx)),
      /No pude confirmar/,
    );
    const [note] = notesIn(fake.calls);
    assert.equal((note.body as { meta: { reason: string } }).meta.reason, "hl_appointment_unconfirmed");
  }
});

test("cancel: a HighLevel 4xx means nothing changed: a plain failure, and a person is told", async () => {
  const fake = hlFetch({ local: [active("a1", CONFIRMED_UTC)], putStatus: 422 });
  const result = await withFetch(fake, () =>
    cancelHighLevelTool.run({ appointment_datetime_iso: CONFIRMED }, ctx),
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /NO se canceló/);
  assert.match(result.error ?? "", /una persona/);
  assert.equal(notesIn(fake.calls).length, 1);
});

test("cancel: the HighLevel fallback needs a calendar, matches it, and reads bare or 'T' times", async () => {
  const noCalendar = hlFetch({ calendarId: null, contactHlId: "hl_c1" });
  await withFetch(noCalendar, () =>
    cancelHighLevelTool.run({ appointment_datetime_iso: CONFIRMED }, ctx),
  );
  assert.ok(!noCalendar.calls.some((c) => c.url.includes("leadconnectorhq.com/contacts/")));

  for (const startTime of ["2030-06-12 10:00:00", "2030-06-12T10:00:00"]) {
    const fake = hlFetch({
      calendarId: "cal_1",
      contactHlId: "hl_c1",
      hlContactEvents: [
        { id: "other", calendarId: "cal_2", appointmentStatus: "booked", startTime },
        { id: "hl_9", calendarId: "cal_1", appointmentStatus: "booked", startTime },
      ],
    });
    const result = await withFetch(fake, () =>
      cancelHighLevelTool.run({ appointment_datetime_iso: CONFIRMED }, ctx),
    );
    assert.equal(result.ok, true, startTime);
    const lookup = fake.calls.find((c) => c.url.includes("leadconnectorhq.com/contacts/"));
    assert.equal(lookup?.headers.Version, "2021-07-28");
    assert.ok(puts(fake.calls)[0].url.endsWith("/appointments/hl_9"));
  }
});

test("cancel: a write tool with a 30 s budget, and nothing runs without a real contact", async () => {
  assert.equal(cancelHighLevelTool.sensitivity, "write");
  assert.equal(cancelHighLevelTool.preferredTimeoutMs, 30_000);
  const fake = hlFetch({});
  const result = await withFetch(fake, () =>
    cancelHighLevelTool.run({ appointment_datetime_iso: CONFIRMED }, { ...ctx, contactId: "" }),
  );
  assert.equal(result.ok, false);
  assert.ok(!fake.calls.some((c) => c.url.includes("/rest/v1/appointments")));
});

// ── reschedule_highlevel ────────────────────────────────────────────────────

test("reschedule: keeps the appointment's length and records where it moved from", async () => {
  const fake = hlFetch({
    local: [active("a1", CONFIRMED_UTC)],
    hlEvent: {
      startTime: "2030-06-12T10:00:00-06:00",
      endTime: "2030-06-12T10:45:00-06:00",
      appointmentStatus: "confirmed",
    },
  });
  const result = await withFetch(fake, () =>
    rescheduleHighLevelTool.run(
      { appointment_datetime_iso: CONFIRMED, new_datetime_iso: NEW_TIME },
      ctx,
    ),
  );
  assert.equal(result.ok, true);
  const [put] = puts(fake.calls);
  assert.equal(put.headers.Version, "2021-04-15");
  assert.deepEqual(put.body, {
    startTime: "2030-06-15T12:00:00-06:00",
    endTime: "2030-06-15T12:45:00-06:00",
  });
  const patch = fake.calls.find((c) => c.method === "PATCH");
  assert.deepEqual(patch?.body, {
    scheduled_at: NEW_TIME_UTC,
    meta: { rescheduled_from: CONFIRMED_UTC },
  });
});

test("reschedule: a retry finds it already moved — only with the recorded origin", async () => {
  const moved = hlFetch({
    local: [active("a1", NEW_TIME_UTC, { rescheduled_from: CONFIRMED_UTC })],
  });
  const r1 = await withFetch(moved, () =>
    rescheduleHighLevelTool.run(
      { appointment_datetime_iso: CONFIRMED, new_datetime_iso: NEW_TIME },
      ctx,
    ),
  );
  assert.equal((r1.output as { already_rescheduled?: boolean }).already_rescheduled, true);
  assert.equal(puts(moved.calls).length, 0);

  // Some other appointment at the new time doesn't prove the move happened.
  const unrelated = hlFetch({ local: [active("a9", NEW_TIME_UTC)] });
  const r2 = await withFetch(unrelated, () =>
    rescheduleHighLevelTool.run(
      { appointment_datetime_iso: CONFIRMED, new_datetime_iso: NEW_TIME },
      ctx,
    ),
  );
  assert.equal(r2.ok, false);
  assert.equal(puts(unrelated.calls).length, 0);
});

test("reschedule: a cancelled appointment is not moved; a past or unknown time is refused", async () => {
  const cancelled = hlFetch({
    local: [{ ...active("a1", CONFIRMED_UTC), status: "cancelled" }],
    hlEvent: { appointmentStatus: "cancelled" },
  });
  const r1 = await withFetch(cancelled, () =>
    rescheduleHighLevelTool.run(
      { appointment_datetime_iso: CONFIRMED, new_datetime_iso: NEW_TIME },
      ctx,
    ),
  );
  assert.match(r1.error ?? "", /cancelada/);

  const past = hlFetch({ local: [active("a1", CONFIRMED_UTC)] });
  const r2 = await withFetch(past, () =>
    rescheduleHighLevelTool.run(
      { appointment_datetime_iso: CONFIRMED, new_datetime_iso: "2020-01-01T10:00:00-06:00" },
      ctx,
    ),
  );
  assert.equal(r2.ok, false);
  for (const fake of [cancelled, past]) assert.equal(puts(fake.calls).length, 0);
});

test("reschedule: an unknown outcome throws and leaves a note", async () => {
  const fake = hlFetch({
    local: [active("a1", CONFIRMED_UTC)],
    hlEvent: { startTime: "2030-06-12T10:00:00-06:00", endTime: "2030-06-12T11:00:00-06:00", appointmentStatus: "confirmed" },
    putStatus: 503,
  });
  await assert.rejects(
    withFetch(fake, () =>
      rescheduleHighLevelTool.run(
        { appointment_datetime_iso: CONFIRMED, new_datetime_iso: NEW_TIME },
        ctx,
      ),
    ),
    /No pude confirmar/,
  );
  assert.equal(notesIn(fake.calls).length, 1);
  assert.equal(rescheduleHighLevelTool.preferredTimeoutMs, 30_000);
});

// ── list_highlevel_appointments ─────────────────────────────────────────────

test("list: the contact's upcoming appointments, with the exact instant to copy", async () => {
  const fake = hlFetch({ local: [active("a1", CONFIRMED_UTC)] });
  const result = await withFetch(fake, () => listHighLevelAppointmentsTool.run({}, ctx));
  assert.equal(result.ok, true);
  const out = result.output as { appointments: Array<{ datetime_iso: string }> };
  assert.deepEqual(out.appointments.map((a) => a.datetime_iso), ["2030-06-12T10:00:00-06:00"]);
  assert.equal(listHighLevelAppointmentsTool.sensitivity, "read");
});

// ── one zone for every scheduling tool ──────────────────────────────────────

/** Moves a1 (at `fromUtc`) to `to`, with the fixture's zones. */
async function reschedule(
  zones: { timezone?: string | null; hlTimezone?: string },
  fromUtc: string,
  from: string,
  to: string,
) {
  const fake = hlFetch({ ...zones, local: [active("a1", fromUtc)] });
  const result = await withFetch(fake, () =>
    rescheduleHighLevelTool.run({ appointment_datetime_iso: from, new_datetime_iso: to }, ctx),
  );
  const patch = fake.calls.find((c) => c.method === "PATCH");
  return {
    result,
    put: puts(fake.calls)[0]?.body as { startTime?: string } | undefined,
    scheduledAt: (patch?.body as { scheduled_at?: string } | undefined)?.scheduled_at,
  };
}

test("zones: business unset and HighLevel in Cancún — the slot check_availability gave moves to that exact instant", async () => {
  // check_availability writes Cancún's slots as "…-05:00" (see its tests).
  const ok = await reschedule(
    { timezone: null, hlTimezone: "America/Cancun" },
    "2030-06-12T15:00:00.000Z",
    "2030-06-12T10:00:00-05:00",
    "2030-06-15T10:00:00-05:00",
  );
  assert.equal(ok.result.ok, true);
  assert.equal(ok.put?.startTime, "2030-06-15T10:00:00-05:00");
  assert.equal(ok.scheduledAt, "2030-06-15T15:00:00.000Z");
  assert.equal((ok.result.output as { new_datetime: string }).new_datetime, "2030-06-15T10:00:00-05:00");

  // Mexico City's offset isn't Cancún's: refused, not moved an hour off.
  const off = await reschedule(
    { timezone: null, hlTimezone: "America/Cancun" },
    "2030-06-12T15:00:00.000Z",
    "2030-06-12T10:00:00-05:00",
    "2030-06-15T10:00:00-06:00",
  );
  assert.equal(off.result.ok, false);
  assert.match(off.result.error ?? "", /America\/Cancun/);
  assert.equal(off.put, undefined);
});

test("zones: no zone anywhere — the default zone reads and writes every date", async () => {
  const ok = await reschedule(
    { timezone: null },
    CONFIRMED_UTC,
    "2030-06-12T10:00:00-06:00",
    "2030-06-15T12:00:00-06:00",
  );
  assert.equal(ok.result.ok, true);
  assert.equal(ok.put?.startTime, "2030-06-15T12:00:00-06:00");
  assert.equal(ok.scheduledAt, NEW_TIME_UTC);

  // A UTC time the model made up is refused, not moved six hours off.
  const off = await reschedule(
    { timezone: null },
    CONFIRMED_UTC,
    "2030-06-12T10:00:00-06:00",
    "2030-06-15T12:00:00Z",
  );
  assert.equal(off.result.ok, false);
  assert.equal(off.put, undefined);
});

test("zones: Madrid — its summer offset works, another zone's is refused", async () => {
  const ok = await reschedule(
    { timezone: "Europe/Madrid" },
    "2030-06-12T08:00:00.000Z",
    "2030-06-12T10:00:00+02:00",
    "2030-06-15T12:00:00+02:00",
  );
  assert.equal(ok.result.ok, true);
  assert.equal(ok.put?.startTime, "2030-06-15T12:00:00+02:00");
  assert.equal(ok.scheduledAt, "2030-06-15T10:00:00.000Z");

  // The default zone's offset (what the model saw elsewhere): 7–8 h off. Refused.
  const off = await reschedule(
    { timezone: "Europe/Madrid" },
    "2030-06-12T08:00:00.000Z",
    "2030-06-12T10:00:00+02:00",
    "2030-06-15T12:00:00-06:00",
  );
  assert.equal(off.result.ok, false);
  assert.equal(off.put, undefined);
});

test("zones: the DST edge — each of the two 01:30 is its own instant, a skipped hour is refused", async () => {
  // New York, 2030-11-03: 01:30 happens at 05:30Z (-04:00) and 06:30Z (-05:00).
  const zones = { timezone: "America/New_York" };
  const from = "2030-10-30T10:00:00-04:00";
  const fromUtc = "2030-10-30T14:00:00.000Z";
  const first = await reschedule(zones, fromUtc, from, "2030-11-03T01:30:00-04:00");
  assert.equal(first.scheduledAt, "2030-11-03T05:30:00.000Z");
  assert.equal(first.put?.startTime, "2030-11-03T01:30:00-04:00");
  const second = await reschedule(zones, fromUtc, from, "2030-11-03T01:30:00-05:00");
  assert.equal(second.scheduledAt, "2030-11-03T06:30:00.000Z");
  assert.equal(second.put?.startTime, "2030-11-03T01:30:00-05:00");
  // Without an offset, the first of the two.
  const bare = await reschedule(zones, fromUtc, from, "2030-11-03T01:30:00");
  assert.equal(bare.scheduledAt, "2030-11-03T05:30:00.000Z");

  // 2030-03-10 02:30 never happens there (02:00 → 03:00).
  const skipped = await reschedule(zones, fromUtc, from, "2030-03-10T02:30:00-05:00");
  assert.equal(skipped.result.ok, false);
  assert.equal(skipped.put, undefined);
});

// ── a cancelled local row doesn't hide a live HighLevel appointment ─────────

const rebooked = () =>
  hlFetch({
    calendarId: "cal_1",
    contactHlId: "hl_c1",
    // a1 was cancelled here; the customer booked again at the same time
    // through the booking link, which only HighLevel knows about.
    local: [{ ...active("a1", CONFIRMED_UTC), status: "cancelled" }],
    hlContactEvents: [
      { id: "hl_a1", calendarId: "cal_1", appointmentStatus: "cancelled", startTime: "2030-06-12 10:00:00" },
      { id: "hl_b", calendarId: "cal_1", appointmentStatus: "confirmed", startTime: "2030-06-12 10:00:00" },
    ],
  });

test("cancel: a cancelled local row at that time doesn't hide the live appointment HighLevel has", async () => {
  const fake = rebooked();
  const result = await withFetch(fake, () =>
    cancelHighLevelTool.run({ appointment_datetime_iso: CONFIRMED }, ctx),
  );
  assert.deepEqual(result.output, { cancelled: true });
  assert.ok(puts(fake.calls)[0].url.endsWith("/appointments/hl_b"));
});

test("reschedule: the same case moves the live appointment, and records it without a duplicate row", async () => {
  const fake = rebooked();
  const result = await withFetch(fake, () =>
    rescheduleHighLevelTool.run(
      { appointment_datetime_iso: CONFIRMED, new_datetime_iso: NEW_TIME },
      ctx,
    ),
  );
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.error ?? "", /cancelada/);
  assert.ok(puts(fake.calls)[0].url.endsWith("/appointments/hl_b"));
  // hl_b had no local row: one is created, holding its HighLevel id.
  const [insert] = localWrites(fake.calls);
  assert.equal(insert.method, "POST");
  assert.equal((insert.body as { hl_appointment_id: string }).hl_appointment_id, "hl_b");
  assert.equal((insert.body as { status: string }).status, "booked");
});

test("reschedule: an appointment found through HighLevel reuses its existing local row", async () => {
  // hl_a1's row says cancelled at another time; HighLevel has it live now.
  const fake = hlFetch({
    calendarId: "cal_1",
    contactHlId: "hl_c1",
    local: [{ ...active("a1", "2030-06-01T16:00:00.000Z"), status: "cancelled" }],
    hlContactEvents: [
      { id: "hl_a1", calendarId: "cal_1", appointmentStatus: "confirmed", startTime: "2030-06-12 10:00:00" },
    ],
  });
  const result = await withFetch(fake, () =>
    rescheduleHighLevelTool.run(
      { appointment_datetime_iso: CONFIRMED, new_datetime_iso: NEW_TIME },
      ctx,
    ),
  );
  assert.equal(result.ok, true);
  const writes = localWrites(fake.calls);
  assert.deepEqual(writes.map((w) => w.method), ["PATCH"]);
  assert.ok(writes[0].url.includes("id=eq.a1"));
  assert.deepEqual(writes[0].body, {
    scheduled_at: NEW_TIME_UTC,
    status: "booked",
    meta: { rescheduled_from: CONFIRMED_UTC },
  });
});

// ── HighLevel is asked before a change ──────────────────────────────────────

test("cancel: an appointment HighLevel has at another time now is not cancelled", async () => {
  const fake = hlFetch({
    local: [active("a1", CONFIRMED_UTC)],
    hlEvent: { appointmentStatus: "confirmed", startTime: "2030-06-12T11:00:00-06:00" },
  });
  const result = await withFetch(fake, () =>
    cancelHighLevelTool.run({ appointment_datetime_iso: CONFIRMED }, ctx),
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /ya no está a esa hora/);
  assert.equal(puts(fake.calls).length, 0);
});

// ── a person follows up on what the tools can't settle ──────────────────────

test("cancel/reschedule: a 4xx, an ambiguous time or a failed lookup ask for a person", async () => {
  const cases = [
    () => hlFetch({ local: [active("a1", CONFIRMED_UTC)], putStatus: 422 }),
    () => hlFetch({ local: [active("a1", CONFIRMED_UTC), active("a2", CONFIRMED_UTC)] }),
    () => hlFetch({ local: [active("a1", CONFIRMED_UTC)], hlEventStatus: 500 }),
  ];
  for (const [i, make] of cases.entries()) {
    const c = make();
    const cancelled = await withFetch(c, () =>
      cancelHighLevelTool.run({ appointment_datetime_iso: CONFIRMED }, ctx),
    );
    assert.deepEqual(cancelled.output, { needs_human: true }, `cancel case ${i}`);
    const r = make();
    const moved = await withFetch(r, () =>
      rescheduleHighLevelTool.run(
        { appointment_datetime_iso: CONFIRMED, new_datetime_iso: NEW_TIME },
        ctx,
      ),
    );
    assert.deepEqual(moved.output, { needs_human: true }, `reschedule case ${i}`);
  }
});

// ── list_highlevel_appointments merges local and HighLevel ──────────────────

test("list: HighLevel is asked even with local rows; merged by id, HighLevel's state winning", async () => {
  const fake = hlFetch({
    calendarId: "cal_1",
    contactHlId: "hl_c1",
    local: [
      active("a1", CONFIRMED_UTC),
      { ...active("a2", "2030-06-13T16:00:00.000Z"), status: "confirmed" },
      active("a3", "2030-06-14T16:00:00.000Z"),
    ],
    hlContactEvents: [
      // Same appointment as a1: listed once.
      { id: "hl_a1", calendarId: "cal_1", appointmentStatus: "confirmed", startTime: "2030-06-12 10:00:00" },
      // Cancelled by staff in HighLevel: gone, though the local row says booked.
      { id: "hl_a3", calendarId: "cal_1", appointmentStatus: "cancelled", startTime: "2030-06-14 10:00:00" },
      // Booked through the booking link: only HighLevel knows it.
      { id: "hl_x", calendarId: "cal_1", appointmentStatus: "booked", startTime: "2030-06-16 09:00:00" },
    ],
    hlEvents: { hl_x: { appointmentStatus: "booked", startTime: "2030-06-16T09:00:00-06:00" } },
  });
  const result = await withFetch(fake, () => listHighLevelAppointmentsTool.run({}, ctx));
  const out = result.output as { appointments: Array<{ datetime_iso: string }> };
  assert.deepEqual(out.appointments.map((a) => a.datetime_iso), [
    "2030-06-12T10:00:00-06:00",
    "2030-06-13T10:00:00-06:00",
    "2030-06-16T09:00:00-06:00",
  ]);
  // Every live local status is included.
  const query = fake.calls.find((c) => c.url.includes("/rest/v1/appointments") && c.method === "GET");
  assert.match(decodeURIComponent(query!.url), /status=in\.\(booked,confirmed\)/);
});

test("list: with the business zone unset, times are written in HighLevel's zone", async () => {
  const fake = hlFetch({
    timezone: null,
    hlTimezone: "America/Cancun",
    local: [active("a1", "2030-06-12T15:00:00.000Z")],
  });
  const result = await withFetch(fake, () => listHighLevelAppointmentsTool.run({}, ctx));
  const out = result.output as { appointments: Array<{ datetime_iso: string }> };
  assert.deepEqual(out.appointments.map((a) => a.datetime_iso), ["2030-06-12T10:00:00-05:00"]);
});

// ── HighLevel confirms what the local rows say ──────────────────────────────

const patchesOf = (calls: FetchCall[]) =>
  calls.filter((c) => c.method === "PATCH" && c.url.includes("/rest/v1/appointments"));

test("cancel: marks every local row of that HighLevel appointment, by its HighLevel id", async () => {
  const fake = hlFetch({ local: [active("a1", CONFIRMED_UTC)] });
  await withFetch(fake, () => cancelHighLevelTool.run({ appointment_datetime_iso: CONFIRMED }, ctx));
  const [patch] = patchesOf(fake.calls);
  assert.ok(decodeURIComponent(patch.url).includes("hl_appointment_id=eq.hl_a1"), patch.url);
  assert.ok(!patch.url.includes("id=eq.a1"), patch.url);
  assert.deepEqual(patch.body, { status: "cancelled" });
});

test("cancel: a live local row HighLevel no longer has is synced, and the live one at that time is cancelled", async () => {
  // a1 is still booked here, but staff deleted it in HighLevel (404); the
  // customer booked hl_b at the same time through the link.
  const fake = hlFetch({
    calendarId: "cal_1",
    contactHlId: "hl_c1",
    local: [active("a1", CONFIRMED_UTC)],
    hlContactEvents: [
      { id: "hl_b", calendarId: "cal_1", appointmentStatus: "confirmed", startTime: "2030-06-12 10:00:00" },
    ],
    hlEvents: { hl_a1: null },
  });
  const result = await withFetch(fake, () =>
    cancelHighLevelTool.run({ appointment_datetime_iso: CONFIRMED }, ctx),
  );
  assert.deepEqual(result.output, { cancelled: true }, "not 'already cancelled'");
  assert.deepEqual(puts(fake.calls).map((p) => p.url.split("/").pop()), ["hl_b"]);
  // a1's row now says what HighLevel says.
  assert.ok(
    patchesOf(fake.calls).some((p) => decodeURIComponent(p.url).includes("hl_appointment_id=eq.hl_a1")),
  );
});

test("cancel: a live local row HighLevel cancelled, and nothing else at that time: already cancelled, row synced", async () => {
  const fake = hlFetch({
    calendarId: "cal_1",
    contactHlId: "hl_c1",
    local: [active("a1", CONFIRMED_UTC)],
    hlContactEvents: [
      { id: "hl_a1", calendarId: "cal_1", appointmentStatus: "cancelled", startTime: "2030-06-12 10:00:00" },
    ],
    hlEvent: { appointmentStatus: "cancelled" },
  });
  const result = await withFetch(fake, () =>
    cancelHighLevelTool.run({ appointment_datetime_iso: CONFIRMED }, ctx),
  );
  assert.deepEqual(result.output, { cancelled: true, already_cancelled: true });
  assert.equal(puts(fake.calls).length, 0);
  assert.equal(patchesOf(fake.calls).length, 1);
});

test("list: a local row keeps its own time; HighLevel's bare time only says whether it's live", async () => {
  const fake = hlFetch({
    calendarId: "cal_1",
    contactHlId: "hl_c1",
    local: [active("a1", CONFIRMED_UTC)],
    hlContactEvents: [
      // Read in a guessed zone, this bare time would be an hour off.
      { id: "hl_a1", calendarId: "cal_1", appointmentStatus: "confirmed", startTime: "2030-06-12 11:00:00" },
      // Only HighLevel knows it: its time comes from the appointment itself.
      { id: "hl_x", calendarId: "cal_1", appointmentStatus: "booked", startTime: "2030-06-16 08:00:00" },
    ],
    hlEvents: { hl_x: { appointmentStatus: "booked", startTime: "2030-06-16T09:00:00-06:00" } },
  });
  const result = await withFetch(fake, () => listHighLevelAppointmentsTool.run({}, ctx));
  const out = result.output as { appointments: Array<{ datetime_iso: string }> };
  assert.deepEqual(out.appointments.map((a) => a.datetime_iso), [
    "2030-06-12T10:00:00-06:00",
    "2030-06-16T09:00:00-06:00",
  ]);
  const read = fake.calls.filter((c) => c.url.includes("/calendars/events/appointments/"));
  assert.deepEqual(read.map((c) => c.url.split("/").pop()), ["hl_x"], "only the HighLevel-only one is read");
  assert.equal(read[0].headers.Version, "2021-04-15");
});

test("parseHLTime: an explicit offset is the instant it names, even at a wall clock the zone skips", () => {
  // 2026-03-29 02:30 never happens in Madrid (02:00 → 03:00), but 02:30Z does.
  assert.equal(
    new Date(parseHLTime("2026-03-29T02:30:00Z", "Europe/Madrid")!).toISOString(),
    "2026-03-29T02:30:00.000Z",
  );
  assert.equal(
    new Date(parseHLTime("2026-06-12T10:00:00-05:00", "Europe/Madrid")!).toISOString(),
    "2026-06-12T15:00:00.000Z",
  );
  // A bare time is still read in the zone, and a skipped one has no instant.
  assert.equal(parseHLTime("2026-03-29 02:30:00", "Europe/Madrid"), null);
  assert.equal(
    new Date(parseHLTime("2026-06-12 10:00:00", "Europe/Madrid")!).toISOString(),
    "2026-06-12T08:00:00.000Z",
  );
});
