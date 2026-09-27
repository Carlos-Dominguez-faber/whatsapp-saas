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

/** What GET /calendars/events/appointments/{id} answers: an event, a 404 (null), or an HTTP error. */
type EventAnswer = Record<string, unknown> | null | { httpStatus: number };

function hlFetch(opts: {
  local?: LocalAppointment[];
  calendarId?: string | null;
  contactHlId?: string | null;
  /** The business's zone; null leaves it unset. */
  timezone?: string | null;
  /** The HighLevel integration's configured zone. */
  hlTimezone?: string;
  hlContactEvents?: Array<Record<string, unknown>>;
  /**
   * Per appointment id. An id not listed answers as its local row says (or
   * 404 when there's none): HighLevel agrees with the cache unless told.
   */
  hlEvents?: Record<string, EventAnswer>;
  putStatus?: number;
  putThrows?: boolean;
  /** HTTP status of GET /contacts/{id}/appointments (200 by default). */
  contactListStatus?: number;
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
      return json(opts.contactListStatus ?? 200, { events: opts.hlContactEvents ?? [] });
    }
    if (url.includes("leadconnectorhq.com/calendars/events/appointments/")) {
      if (method === "PUT") {
        if (opts.putThrows) throw new Error("socket hang up");
        return json(opts.putStatus ?? 200, {});
      }
      const id = url.split("/").pop()!;
      let answer: EventAnswer;
      if (opts.hlEvents && id in opts.hlEvents) {
        answer = opts.hlEvents[id];
      } else {
        const row = (opts.local ?? []).find((r) => r.hl_appointment_id === id);
        answer = row ? { appointmentStatus: row.status, startTime: row.scheduled_at } : null;
      }
      if (answer === null) return json(404, {});
      if ("httpStatus" in answer) return json(answer.httpStatus as number, {});
      return json(200, { event: answer });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
  return { fn, calls };
}

const puts = (calls: FetchCall[]) =>
  calls.filter((c) => c.method === "PUT" && c.url.includes("/calendars/events/appointments/"));
const putIds = (calls: FetchCall[]) => puts(calls).map((c) => c.url.split("/").pop());
const notesIn = (calls: FetchCall[]) =>
  calls.filter((c) => c.method === "POST" && c.url.includes("/rest/v1/messages"));
const hlCalls = (calls: FetchCall[]) => calls.filter((c) => c.url.includes("leadconnectorhq"));
const localWrites = (calls: FetchCall[]) =>
  calls.filter((c) => c.url.includes("/rest/v1/appointments") && c.method !== "GET");
/** Local rows written back by upsert on (workspace_id, hl_appointment_id). */
const upserts = (calls: FetchCall[]) =>
  localWrites(calls)
    .filter((c) => c.method === "POST" && decodeURIComponent(c.url).includes("on_conflict=workspace_id,hl_appointment_id"))
    .map((c) => c.body as Record<string, unknown>);

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
/** A contact appointment on the configured calendar (bare time, no offset). */
const listed = (id: string, bare: string, status = "confirmed") => ({
  id,
  calendarId: "cal_1",
  appointmentStatus: status,
  startTime: bare,
});
const withCalendar = { calendarId: "cal_1", contactHlId: "hl_c1" };

const cancelAt = (fake: ReturnType<typeof hlFetch>, iso = CONFIRMED, timeoutMs?: number) =>
  withFetch(fake, () =>
    cancelHighLevelTool.run(
      { appointment_datetime_iso: iso },
      ctx,
      timeoutMs === undefined ? undefined : { timeoutMs },
    ),
  );
const moveTo = (fake: ReturnType<typeof hlFetch>, to = NEW_TIME, from = CONFIRMED) =>
  withFetch(fake, () =>
    rescheduleHighLevelTool.run({ appointment_datetime_iso: from, new_datetime_iso: to }, ctx),
  );
const listOf = async (fake: ReturnType<typeof hlFetch>) => {
  const result = await withFetch(fake, () => listHighLevelAppointmentsTool.run({}, ctx));
  return result.output as { appointments: Array<{ datetime_iso: string }>; note: string };
};

// ── without a calendar: the local rows say which appointments to read ──────

test("cancel: cancels the appointment at the confirmed time, with the spec's Version header", async () => {
  const fake = hlFetch({ local: [active("a1", CONFIRMED_UTC)] });
  const result = await cancelAt(fake);
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { cancelled: true });
  const [put] = puts(fake.calls);
  assert.ok(put.url.endsWith("/appointments/hl_a1"));
  assert.deepEqual(put.body, { appointmentStatus: "cancelled" });
  assert.equal(put.headers.Version, "2021-04-15");
  // The local row follows, by its HighLevel id.
  const patch = localWrites(fake.calls).find((c) => c.method === "PATCH");
  assert.ok(decodeURIComponent(patch!.url).includes("hl_appointment_id=eq.hl_a1"), patch!.url);
  assert.deepEqual(patch!.body, {
    workspace_id: "ws_1",
    hl_appointment_id: "hl_a1",
    contact_id: "contact_1",
    status: "cancelled",
  });
});

test("cancel: an offset that isn't the zone's at that date is refused; nothing is guessed", async () => {
  // New York in July is -04:00. "10:00-05:00" names 15:00Z, which reads 11:00
  // there: a time copied from another zone (or a winter date). Refused.
  const wrong = hlFetch({
    timezone: "America/New_York",
    local: [active("a1", "2030-07-15T14:00:00.000Z"), active("a2", "2030-07-15T15:00:00.000Z")],
  });
  const refused = await cancelAt(wrong, "2030-07-15T10:00:00-05:00");
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? "", /America\/New_York/);
  assert.match(refused.error ?? "", /vuelve a consultar/);
  assert.equal(hlCalls(wrong.calls).length, 0);
  assert.equal(localWrites(wrong.calls).length, 0);

  const right = hlFetch({
    timezone: "America/New_York",
    local: [active("a1", "2030-07-15T14:00:00.000Z")],
  });
  const done = await cancelAt(right, "2030-07-15T10:00:00-04:00");
  assert.equal(done.ok, true);
  assert.deepEqual(putIds(right.calls), ["hl_a1"]);
});

test("cancel: an impossible date or a past appointment is refused before calling anything", async () => {
  for (const iso of ["2030-02-30T10:00:00-06:00", "2020-06-12T10:00:00-06:00"]) {
    const fake = hlFetch({});
    const result = await cancelAt(fake, iso);
    assert.equal(result.ok, false, iso);
    assert.equal(hlCalls(fake.calls).length, 0, iso);
  }
});

test("cancel: HighLevel's status decides, not the local row's", async () => {
  const cancelledHere = { ...active("a1", CONFIRMED_UTC), status: "cancelled" };
  // Cancelled in HighLevel too: already cancelled, nothing sent.
  const already = hlFetch({ local: [cancelledHere] });
  assert.deepEqual((await cancelAt(already)).output, { cancelled: true, already_cancelled: true });
  assert.equal(puts(already.calls).length, 0);

  // Stale here, still booked in HighLevel: it gets cancelled.
  const stale = hlFetch({
    local: [cancelledHere],
    hlEvents: { hl_a1: { appointmentStatus: "confirmed", startTime: CONFIRMED } },
  });
  assert.deepEqual((await cancelAt(stale)).output, { cancelled: true });
  assert.deepEqual(putIds(stale.calls), ["hl_a1"]);

  // HighLevel no longer has it (404): already cancelled there.
  const gone = hlFetch({ local: [active("a1", CONFIRMED_UTC)], hlEvents: { hl_a1: null } });
  assert.deepEqual((await cancelAt(gone)).output, { cancelled: true, already_cancelled: true });
});

test("cancel: two live appointments at the same time are ambiguous: none is cancelled, a person is told", async () => {
  const fake = hlFetch({ local: [active("a1", CONFIRMED_UTC), active("a2", CONFIRMED_UTC)] });
  const result = await cancelAt(fake);
  assert.equal(result.ok, false);
  assert.deepEqual(result.output, { needs_human: true });
  assert.equal(puts(fake.calls).length, 0);
  assert.equal(notesIn(fake.calls).length, 1);
});

test("cancel: two stale rows HighLevel no longer has and one live: that one is cancelled", async () => {
  const fake = hlFetch({
    local: [active("a1", CONFIRMED_UTC), active("a2", CONFIRMED_UTC), active("a3", CONFIRMED_UTC)],
    hlEvents: { hl_a1: null, hl_a2: null },
  });
  const result = await cancelAt(fake);
  assert.deepEqual(result.output, { cancelled: true });
  assert.deepEqual(putIds(fake.calls), ["hl_a3"]);
});

test("cancel: a HighLevel 5xx or no answer is an unknown outcome: it throws, and a person is told", async () => {
  for (const variant of [{ putStatus: 502 }, { putThrows: true }]) {
    const fake = hlFetch({ local: [active("a1", CONFIRMED_UTC)], ...variant });
    await assert.rejects(cancelAt(fake), /No pude confirmar/);
    const [note] = notesIn(fake.calls);
    assert.equal((note.body as { meta: { reason: string } }).meta.reason, "hl_appointment_unconfirmed");
  }
});

test("cancel: a HighLevel 4xx means nothing changed: a person is told and follows up", async () => {
  const fake = hlFetch({ local: [active("a1", CONFIRMED_UTC)], putStatus: 422 });
  const result = await cancelAt(fake);
  assert.equal(result.ok, false);
  assert.deepEqual(result.output, { needs_human: true });
  assert.match(result.error ?? "", /NO se canceló/);
  assert.equal(notesIn(fake.calls).length, 1);
});

test("cancel: with too little of its budget left for the PUT, nothing is written and it says so", async () => {
  // 9 s left: less than the PUT's 8 s plus the 2 s of slack.
  const fake = hlFetch({ local: [active("a1", CONFIRMED_UTC)] });
  const result = await cancelAt(fake, CONFIRMED, 9_000);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /NO se canceló/);
  assert.equal(puts(fake.calls).length, 0);

  // With the whole budget it goes ahead.
  const full = hlFetch({ local: [active("a1", CONFIRMED_UTC)] });
  assert.equal((await cancelAt(full, CONFIRMED, 30_000)).ok, true);
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

// ── with a calendar: HighLevel is the only source of truth ──────────────────

test("calendar: the contact's appointments are read from the event endpoint; bare times only prefilter", async () => {
  for (const bare of ["2030-06-12 10:00:00", "2030-06-12T10:00:00"]) {
    const fake = hlFetch({
      ...withCalendar,
      hlContactEvents: [
        { ...listed("other", bare), calendarId: "cal_2" },
        listed("hl_9", bare),
      ],
      hlEvents: { hl_9: { appointmentStatus: "confirmed", startTime: CONFIRMED } },
    });
    const result = await cancelAt(fake);
    assert.equal(result.ok, true, bare);
    const lookup = fake.calls.find((c) => c.url.includes("leadconnectorhq.com/contacts/"));
    assert.equal(lookup?.headers.Version, "2021-07-28");
    // Another calendar's appointment is never read nor touched.
    assert.ok(!fake.calls.some((c) => c.url.endsWith("/appointments/other")));
    assert.deepEqual(putIds(fake.calls), ["hl_9"]);
  }
});

test("calendar: local rows decide nothing — a live local row HighLevel doesn't list is ignored", async () => {
  const fake = hlFetch({
    ...withCalendar,
    local: [active("a1", CONFIRMED_UTC)],
    hlContactEvents: [],
  });
  const result = await cancelAt(fake);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /No encontré/);
  assert.equal(puts(fake.calls).length, 0);
});

test("calendar: staff moved the appointment — the list shows the new time and cancel at it works", async () => {
  // The local row still says 10:00; HighLevel has it at 12:00 now. The bare
  // time would be read in a guessed zone, so only the event endpoint counts.
  const moved = {
    ...withCalendar,
    local: [active("a1", CONFIRMED_UTC)],
    hlContactEvents: [listed("hl_a1", "2030-06-12 13:00:00")],
    hlEvents: { hl_a1: { appointmentStatus: "confirmed", startTime: "2030-06-12T12:00:00-06:00" } },
  };
  const listing = hlFetch(moved);
  const out = await listOf(listing);
  assert.deepEqual(out.appointments.map((a) => a.datetime_iso), ["2030-06-12T12:00:00-06:00"]);
  // The read is written back to the cache.
  assert.equal(upserts(listing.calls)[0].scheduled_at, "2030-06-12T18:00:00.000Z");

  const cancel = hlFetch(moved);
  const result = await cancelAt(cancel, "2030-06-12T12:00:00-06:00");
  assert.deepEqual(result.output, { cancelled: true });
  assert.deepEqual(putIds(cancel.calls), ["hl_a1"]);

  // At the old time there's nothing, and the one upcoming appointment is offered.
  const old = hlFetch(moved);
  const notThere = await cancelAt(old, CONFIRMED);
  assert.equal(notThere.ok, false);
  assert.match(notThere.error ?? "", /2030-06-12T12:00:00-06:00/);
  assert.match(notThere.error ?? "", /pregúntale si se refiere a esa/);
  assert.equal(puts(old.calls).length, 0);
});

test("calendar: an appointment moved away plus a live one at that time is found, not ambiguous", async () => {
  const fake = hlFetch({
    ...withCalendar,
    hlContactEvents: [listed("hl_moved", "2030-06-12 10:00:00"), listed("hl_live", "2030-06-12 10:00:00")],
    hlEvents: {
      hl_moved: { appointmentStatus: "confirmed", startTime: "2030-06-13T10:00:00-06:00" },
      hl_live: { appointmentStatus: "confirmed", startTime: CONFIRMED },
    },
  });
  const result = await cancelAt(fake);
  assert.deepEqual(result.output, { cancelled: true });
  assert.deepEqual(putIds(fake.calls), ["hl_live"]);
});

test("calendar: two listed appointments HighLevel no longer has, and one live: found", async () => {
  const fake = hlFetch({
    ...withCalendar,
    hlContactEvents: [
      listed("hl_x", "2030-06-12 10:00:00"),
      listed("hl_y", "2030-06-12 10:00:00"),
      listed("hl_z", "2030-06-12 10:00:00"),
    ],
    hlEvents: { hl_x: null, hl_y: null, hl_z: { appointmentStatus: "booked", startTime: CONFIRMED } },
  });
  const result = await cancelAt(fake);
  assert.deepEqual(result.output, { cancelled: true });
  assert.deepEqual(putIds(fake.calls), ["hl_z"]);
});

test("calendar: only a cancelled one at that time is 'already cancelled'; a rebooked live one is cancelled", async () => {
  const onlyCancelled = hlFetch({
    ...withCalendar,
    hlContactEvents: [listed("hl_a1", "2030-06-12 10:00:00", "cancelled")],
    hlEvents: { hl_a1: { appointmentStatus: "cancelled", startTime: CONFIRMED } },
  });
  assert.deepEqual((await cancelAt(onlyCancelled)).output, { cancelled: true, already_cancelled: true });

  // The customer booked again at the same time through the link.
  const rebooked = hlFetch({
    ...withCalendar,
    local: [{ ...active("a1", CONFIRMED_UTC), status: "cancelled" }],
    hlContactEvents: [
      listed("hl_a1", "2030-06-12 10:00:00", "cancelled"),
      listed("hl_b", "2030-06-12 10:00:00"),
    ],
    hlEvents: {
      hl_a1: { appointmentStatus: "cancelled", startTime: CONFIRMED },
      hl_b: { appointmentStatus: "confirmed", startTime: CONFIRMED },
    },
  });
  assert.deepEqual((await cancelAt(rebooked)).output, { cancelled: true });
  assert.deepEqual(putIds(rebooked.calls), ["hl_b"]);
});

test("calendar: a failed read with no live match is 'no pude confirmar', never ambiguous", async () => {
  const fake = hlFetch({
    ...withCalendar,
    hlContactEvents: [listed("hl_a1", "2030-06-12 10:00:00"), listed("hl_b", "2030-06-12 10:00:00")],
    hlEvents: {
      hl_a1: { httpStatus: 500 },
      hl_b: { appointmentStatus: "confirmed", startTime: "2030-06-14T10:00:00-06:00" },
    },
  });
  const result = await cancelAt(fake);
  assert.deepEqual(result.output, { needs_human: true });
  assert.match(result.error ?? "", /No pude confirmar/);
  assert.doesNotMatch(result.error ?? "", /más de una/);
  assert.equal(puts(fake.calls).length, 0);
});

test("cancel/reschedule: a failed lookup or read, a 4xx or an ambiguous time ask for a person", async () => {
  for (const make of [
    () => hlFetch({ ...withCalendar, contactListStatus: 500 }),
    () => hlFetch({ local: [active("a1", CONFIRMED_UTC)], hlEvents: { hl_a1: { httpStatus: 500 } } }),
    () => hlFetch({ local: [active("a1", CONFIRMED_UTC)], putStatus: 422 }),
    () => hlFetch({ local: [active("a1", CONFIRMED_UTC), active("a2", CONFIRMED_UTC)] }),
  ]) {
    assert.deepEqual((await cancelAt(make())).output, { needs_human: true });
    assert.deepEqual((await moveTo(make())).output, { needs_human: true });
  }
});

// ── reschedule_highlevel ────────────────────────────────────────────────────

/** The write-back that records a move (it carries rescheduled_from). */
const moveRecord = (calls: FetchCall[]) =>
  upserts(calls).find((u) => (u.meta as Record<string, unknown> | undefined)?.rescheduled_from);

test("reschedule: keeps the appointment's length and records where it moved from", async () => {
  const fake = hlFetch({
    local: [active("a1", CONFIRMED_UTC)],
    hlEvents: {
      hl_a1: {
        startTime: "2030-06-12T10:00:00-06:00",
        endTime: "2030-06-12T10:45:00-06:00",
        appointmentStatus: "confirmed",
      },
    },
  });
  const result = await moveTo(fake);
  assert.equal(result.ok, true);
  const [put] = puts(fake.calls);
  assert.equal(put.headers.Version, "2021-04-15");
  assert.deepEqual(put.body, {
    startTime: "2030-06-15T12:00:00-06:00",
    endTime: "2030-06-15T12:45:00-06:00",
  });
  assert.deepEqual(moveRecord(fake.calls), {
    workspace_id: "ws_1",
    hl_appointment_id: "hl_a1",
    contact_id: "contact_1",
    scheduled_at: NEW_TIME_UTC,
    meta: { rescheduled_from: CONFIRMED_UTC },
  });
});

test("reschedule: a retry finds it already moved — only with the recorded origin", async () => {
  const moved = hlFetch({
    local: [active("a1", NEW_TIME_UTC, { rescheduled_from: CONFIRMED_UTC })],
  });
  const r1 = await moveTo(moved);
  assert.equal((r1.output as { already_rescheduled?: boolean }).already_rescheduled, true);
  assert.equal(puts(moved.calls).length, 0);

  // Some other appointment at the new time doesn't prove the move happened.
  const unrelated = hlFetch({ local: [active("a9", NEW_TIME_UTC)] });
  const r2 = await moveTo(unrelated);
  assert.equal(r2.ok, false);
  assert.equal(puts(unrelated.calls).length, 0);
});

test("reschedule: a cancelled appointment is not moved; a past time is refused", async () => {
  const cancelled = hlFetch({ local: [{ ...active("a1", CONFIRMED_UTC), status: "cancelled" }] });
  const r1 = await moveTo(cancelled);
  assert.match(r1.error ?? "", /cancelada/);

  const past = hlFetch({ local: [active("a1", CONFIRMED_UTC)] });
  const r2 = await moveTo(past, "2020-01-01T10:00:00-06:00");
  assert.equal(r2.ok, false);
  for (const fake of [cancelled, past]) assert.equal(puts(fake.calls).length, 0);
});

test("reschedule: an unknown outcome throws and leaves a note", async () => {
  const fake = hlFetch({ local: [active("a1", CONFIRMED_UTC)], putStatus: 503 });
  await assert.rejects(moveTo(fake), /No pude confirmar/);
  assert.equal(notesIn(fake.calls).length, 1);
  assert.equal(rescheduleHighLevelTool.preferredTimeoutMs, 30_000);
});

test("reschedule: the live appointment at that time moves even when a cancelled row there says otherwise", async () => {
  const fake = hlFetch({
    ...withCalendar,
    local: [{ ...active("a1", CONFIRMED_UTC), status: "cancelled" }],
    hlContactEvents: [
      listed("hl_a1", "2030-06-12 10:00:00", "cancelled"),
      listed("hl_b", "2030-06-12 10:00:00"),
    ],
    hlEvents: {
      hl_a1: { appointmentStatus: "cancelled", startTime: CONFIRMED },
      hl_b: { appointmentStatus: "confirmed", startTime: CONFIRMED },
    },
  });
  const result = await moveTo(fake);
  assert.equal(result.ok, true);
  assert.deepEqual(putIds(fake.calls), ["hl_b"]);
  assert.equal(moveRecord(fake.calls)?.hl_appointment_id, "hl_b");
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
  const result = await moveTo(fake, to, from);
  return {
    result,
    put: puts(fake.calls)[0]?.body as { startTime?: string } | undefined,
    scheduledAt: moveRecord(fake.calls)?.scheduled_at,
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
  const ok = await reschedule({ timezone: null }, CONFIRMED_UTC, CONFIRMED, NEW_TIME);
  assert.equal(ok.result.ok, true);
  assert.equal(ok.put?.startTime, "2030-06-15T12:00:00-06:00");
  assert.equal(ok.scheduledAt, NEW_TIME_UTC);

  // A UTC time the model made up is refused, not moved six hours off.
  const off = await reschedule({ timezone: null }, CONFIRMED_UTC, CONFIRMED, "2030-06-15T12:00:00Z");
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

// ── list_highlevel_appointments ─────────────────────────────────────────────

test("list: without a calendar, the contact's upcoming local rows, with the exact instant to copy", async () => {
  const out = await listOf(hlFetch({ local: [active("a1", CONFIRMED_UTC)] }));
  assert.deepEqual(out.appointments.map((a) => a.datetime_iso), ["2030-06-12T10:00:00-06:00"]);
  assert.equal(listHighLevelAppointmentsTool.sensitivity, "read");
  assert.equal(listHighLevelAppointmentsTool.preferredTimeoutMs, 15_000);
});

test("list: with a calendar, HighLevel's live appointments at their event-endpoint instants", async () => {
  const fake = hlFetch({
    ...withCalendar,
    // Stale cache: says booked at 10:00, but HighLevel cancelled it.
    local: [active("a3", "2030-06-14T16:00:00.000Z")],
    hlContactEvents: [
      listed("hl_a1", "2030-06-12 10:00:00"),
      listed("hl_a3", "2030-06-14 10:00:00", "cancelled"),
      listed("hl_x", "2030-06-16 08:00:00", "booked"),
      listed("hl_past", "2020-06-16 08:00:00", "booked"),
    ],
    hlEvents: {
      hl_a1: { appointmentStatus: "confirmed", startTime: CONFIRMED },
      hl_x: { appointmentStatus: "booked", startTime: "2030-06-16T09:00:00-06:00" },
    },
  });
  const out = await listOf(fake);
  assert.deepEqual(out.appointments.map((a) => a.datetime_iso), [
    "2030-06-12T10:00:00-06:00",
    "2030-06-16T09:00:00-06:00",
  ]);
  const reads = fake.calls.filter((c) => c.url.includes("/calendars/events/appointments/"));
  // Only upcoming live ones are read, with the spec's Version.
  assert.deepEqual(reads.map((c) => c.url.split("/").pop()).sort(), ["hl_a1", "hl_x"]);
  assert.equal(reads[0].headers.Version, "2021-04-15");
});

test("list: one failed read doesn't fail the list; it says it may be incomplete", async () => {
  const fake = hlFetch({
    ...withCalendar,
    hlContactEvents: [listed("hl_a1", "2030-06-12 10:00:00"), listed("hl_b", "2030-06-13 10:00:00")],
    hlEvents: {
      hl_a1: { appointmentStatus: "confirmed", startTime: CONFIRMED },
      hl_b: { httpStatus: 502 },
    },
  });
  const result = await withFetch(fake, () => listHighLevelAppointmentsTool.run({}, ctx));
  assert.equal(result.ok, true);
  const out = result.output as { appointments: Array<{ datetime_iso: string }>; note: string };
  assert.deepEqual(out.appointments.map((a) => a.datetime_iso), ["2030-06-12T10:00:00-06:00"]);
  assert.match(out.note, /No pude leer una de sus citas/);
});

test("list: with the business zone unset, times are written in HighLevel's zone", async () => {
  const out = await listOf(
    hlFetch({
      timezone: null,
      hlTimezone: "America/Cancun",
      local: [active("a1", "2030-06-12T15:00:00.000Z")],
    }),
  );
  assert.deepEqual(out.appointments.map((a) => a.datetime_iso), ["2030-06-12T10:00:00-05:00"]);
});

// ── parseHLTime ─────────────────────────────────────────────────────────────

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
