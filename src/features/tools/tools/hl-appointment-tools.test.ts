import assert from "node:assert/strict";
import { test } from "node:test";
import { cancelHighLevelTool } from "./cancel-highlevel.ts";
import { rescheduleHighLevelTool } from "./reschedule-highlevel.ts";
import { listHighLevelAppointmentsTool } from "./list-highlevel-appointments.ts";
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

/** Applies PostgREST's scheduled_at=gte./lte. filters to the fixture rows. */
function byScheduledAt(url: string, rows: LocalAppointment[]) {
  const params = new URL(url).searchParams.getAll("scheduled_at");
  return rows.filter((row) => {
    const at = Date.parse(row.scheduled_at);
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
  timezone?: string;
  hlContactEvents?: Array<Record<string, unknown>>;
  /** GET /calendars/events/appointments/{id} → { event } (null: 404). */
  hlEvent?: Record<string, unknown> | null;
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
          config: { location_id: "loc_1", calendar_id: opts.calendarId ?? null },
          enabled: true,
        },
      ]);
    }
    if (url.includes("/rest/v1/business_info")) {
      return json(200, [{ structured: { timezone: opts.timezone ?? "America/Mexico_City" }, free_text: null }]);
    }
    if (url.includes("/rest/v1/appointments")) {
      if (method === "GET") return json(200, byScheduledAt(url, opts.local ?? []));
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
      if (opts.hlEvent === null) return json(404, {});
      return json(opts.hlEventStatus ?? 200, { event: opts.hlEvent ?? {} });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
  return { fn, calls };
}

const puts = (calls: FetchCall[]) =>
  calls.filter((c) => c.method === "PUT" && c.url.includes("/calendars/events/appointments/"));
const notesIn = (calls: FetchCall[]) =>
  calls.filter((c) => c.method === "POST" && c.url.includes("/rest/v1/messages"));

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

test("cancel: the wall clock is read in the business's zone, whatever offset the model wrote", async () => {
  // New York in July is -04:00; the model copied today's -05:00. 10:00 local is 14:00Z.
  const fake = hlFetch({
    timezone: "America/New_York",
    local: [active("a1", "2030-07-15T14:00:00.000Z")],
  });
  const result = await withFetch(fake, () =>
    cancelHighLevelTool.run({ appointment_datetime_iso: "2030-07-15T10:00:00-05:00" }, ctx),
  );
  assert.equal(result.ok, true);
  assert.equal(puts(fake.calls).length, 1);
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

test("cancel: a write tool with a 25 s budget, and nothing runs without a real contact", async () => {
  assert.equal(cancelHighLevelTool.sensitivity, "write");
  assert.equal(cancelHighLevelTool.preferredTimeoutMs, 25_000);
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
  const cancelled = hlFetch({ local: [{ ...active("a1", CONFIRMED_UTC), status: "cancelled" }] });
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
  assert.equal(rescheduleHighLevelTool.preferredTimeoutMs, 25_000);
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
