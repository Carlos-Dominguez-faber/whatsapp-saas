import assert from "node:assert/strict";
import { test } from "node:test";
import { cancelHighLevelTool } from "./cancel-highlevel.ts";
import { rescheduleHighLevelTool } from "./reschedule-highlevel.ts";
import type { ToolContext } from "../core/tool";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

// HTTP-level fake for the Supabase REST and HighLevel calls both tools make.

interface LocalAppointment {
  id: string;
  hl_appointment_id: string | null;
  status: string;
  scheduled_at: string;
}

interface HLEventFixture {
  id: string;
  calendarId: string;
  status?: string;
  appointmentStatus?: string;
  startTime: string;
}

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Applies PostgREST's `scheduled_at=gte.X` / `lte.Y` filters to the fixture. */
function filterByScheduledAt(url: string, rows: LocalAppointment[]) {
  const params = new URL(url).searchParams.getAll("scheduled_at");
  return rows.filter((row) => {
    const at = Date.parse(row.scheduled_at);
    return params.every((p) => {
      const [op, ...rest] = p.split(".");
      const bound = Date.parse(decodeURIComponent(rest.join(".")).replace(/"/g, ""));
      if (op === "gte") return at >= bound;
      if (op === "lte") return at <= bound;
      return true;
    });
  });
}

function hlAppointmentFetch(opts: {
  localAppointments?: LocalAppointment[];
  calendarId?: string | null;
  contactHlId?: string | null;
  hlEvents?: HLEventFixture[];
  hlPutStatus?: number;
  hlPutBody?: unknown;
  timezone?: string;
}) {
  const calls: FetchCall[] = [];
  const fn = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: (init?.headers as Record<string, string>) ?? {},
    });

    if (url.includes("/rest/v1/integrations")) {
      return jsonResponse(200, [
        {
          credentials: { highlevel_pit: "tok_123" },
          config: { location_id: "loc_1", calendar_id: opts.calendarId ?? null },
          enabled: true,
        },
      ]);
    }
    if (url.includes("/rest/v1/appointments") && method === "GET") {
      return jsonResponse(
        200,
        filterByScheduledAt(url, opts.localAppointments ?? []),
      );
    }
    if (url.includes("/rest/v1/appointments") && method === "PATCH") {
      return new Response(null, { status: 204 });
    }
    if (url.includes("/rest/v1/contacts") && method === "GET") {
      return jsonResponse(
        200,
        opts.contactHlId !== undefined ? [{ hl_contact_id: opts.contactHlId }] : [],
      );
    }
    if (url.includes("/rest/v1/business_info")) {
      return jsonResponse(200, [
        { structured: { timezone: opts.timezone ?? "UTC" }, free_text: null },
      ]);
    }
    if (
      url.includes("services.leadconnectorhq.com/contacts/") &&
      url.includes("/appointments")
    ) {
      return jsonResponse(200, { events: opts.hlEvents ?? [] });
    }
    if (url.includes("services.leadconnectorhq.com/calendars/events/appointments/")) {
      return jsonResponse(opts.hlPutStatus ?? 200, opts.hlPutBody ?? {});
    }
    throw new Error(`unexpected fetch call: ${method} ${url}`);
  };
  return { fn, calls };
}

const hlPuts = (calls: FetchCall[]) =>
  calls.filter(
    (c) =>
      c.method === "PUT" &&
      c.url.includes("services.leadconnectorhq.com/calendars/events/appointments/"),
  );

const ctx: ToolContext = {
  workspaceId: "ws_1",
  conversationId: "conv_1",
  contactId: "contact_1",
};

// 2030-06-12 10:00 in Mexico City (-06:00) is 16:00 UTC.
const CONFIRMED = "2030-06-12T10:00:00-06:00";
const CONFIRMED_UTC = "2030-06-12T16:00:00+00:00";
const NEW_TIME = "2030-06-15T12:00:00-06:00";
const NEW_TIME_UTC = "2030-06-15T18:00:00+00:00";

async function withFetch<T>(fake: { fn: typeof fetch }, body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fake.fn as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

// ── cancel_highlevel ────────────────────────────────────────────────────────

test("cancel: cancels the appointment at the confirmed time, with Version v3", async () => {
  const fake = hlAppointmentFetch({
    localAppointments: [
      { id: "a1", hl_appointment_id: "hl_1", status: "booked", scheduled_at: CONFIRMED_UTC },
    ],
  });
  const result = await withFetch(fake, () =>
    cancelHighLevelTool.run({ appointment_datetime_iso: CONFIRMED }, ctx),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { cancelled: true });
  const puts = hlPuts(fake.calls);
  assert.equal(puts.length, 1);
  assert.ok(puts[0].url.endsWith("/appointments/hl_1"));
  assert.deepEqual(puts[0].body, { appointmentStatus: "cancelled" });
  assert.equal(puts[0].headers.Version, "v3");
  assert.ok(
    fake.calls.some((c) => c.method === "PATCH" && c.url.includes("/rest/v1/appointments")),
    "marks the local row cancelled",
  );
});

test("cancel: a retry finds the appointment already cancelled and changes nothing", async () => {
  const fake = hlAppointmentFetch({
    localAppointments: [
      { id: "a1", hl_appointment_id: "hl_1", status: "cancelled", scheduled_at: CONFIRMED_UTC },
      // The contact's NEXT appointment must not be cancelled by a retry.
      { id: "a2", hl_appointment_id: "hl_2", status: "booked", scheduled_at: NEW_TIME_UTC },
    ],
  });
  const result = await withFetch(fake, () =>
    cancelHighLevelTool.run({ appointment_datetime_iso: CONFIRMED }, ctx),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { cancelled: true, already_cancelled: true });
  assert.equal(hlPuts(fake.calls).length, 0);
});

test("cancel: never touches an appointment at a different time", async () => {
  const fake = hlAppointmentFetch({
    localAppointments: [
      { id: "a2", hl_appointment_id: "hl_2", status: "booked", scheduled_at: NEW_TIME_UTC },
    ],
  });
  const result = await withFetch(fake, () =>
    cancelHighLevelTool.run({ appointment_datetime_iso: CONFIRMED }, ctx),
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /No encontré una cita/);
  assert.equal(hlPuts(fake.calls).length, 0);
});

test("cancel: refuses a date without an offset before calling anything", async () => {
  const fake = hlAppointmentFetch({});
  const result = await withFetch(fake, () =>
    cancelHighLevelTool.run({ appointment_datetime_iso: "2030-06-12T10:00:00" }, ctx),
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /zona horaria/);
  assert.ok(!fake.calls.some((c) => c.url.includes("leadconnectorhq")));
});

test("cancel: without a local row, asks HighLevel only when a calendar is configured", async () => {
  const fake = hlAppointmentFetch({ calendarId: null, contactHlId: "hl_contact_1" });
  const result = await withFetch(fake, () =>
    cancelHighLevelTool.run({ appointment_datetime_iso: CONFIRMED }, ctx),
  );
  assert.equal(result.ok, false);
  assert.ok(
    !fake.calls.some((c) => c.url.includes("leadconnectorhq.com/contacts/")),
    "no calendar configured: no HighLevel fallback",
  );
});

test("cancel: the HighLevel fallback matches the wall clock and calendar, and reads appointmentStatus first", async () => {
  const fake = hlAppointmentFetch({
    calendarId: "cal_1",
    contactHlId: "hl_contact_1",
    timezone: "America/Mexico_City",
    hlEvents: [
      // Same time, other calendar: not ours.
      { id: "other_cal", calendarId: "cal_2", status: "booked", startTime: "2030-06-12 10:00:00" },
      { id: "hl_9", calendarId: "cal_1", status: "booked", startTime: "2030-06-12 10:00:00" },
    ],
  });
  const result = await withFetch(fake, () =>
    cancelHighLevelTool.run({ appointment_datetime_iso: CONFIRMED }, ctx),
  );
  assert.equal(result.ok, true);
  const puts = hlPuts(fake.calls);
  assert.equal(puts.length, 1);
  assert.ok(puts[0].url.endsWith("/appointments/hl_9"));
  assert.equal(
    fake.calls.filter((c) => c.method === "PATCH").length,
    0,
    "no local row to update",
  );

  const cancelledFake = hlAppointmentFetch({
    calendarId: "cal_1",
    contactHlId: "hl_contact_1",
    timezone: "America/Mexico_City",
    hlEvents: [
      {
        id: "hl_9",
        calendarId: "cal_1",
        status: "booked",
        appointmentStatus: "cancelled",
        startTime: "2030-06-12 10:00:00",
      },
    ],
  });
  const again = await withFetch(cancelledFake, () =>
    cancelHighLevelTool.run({ appointment_datetime_iso: CONFIRMED }, ctx),
  );
  assert.deepEqual(again.output, { cancelled: true, already_cancelled: true });
  assert.equal(hlPuts(cancelledFake.calls).length, 0);
});

test("cancel: a HighLevel error says it wasn't cancelled, without HighLevel's raw text", async () => {
  const fake = hlAppointmentFetch({
    localAppointments: [
      { id: "a1", hl_appointment_id: "hl_1", status: "booked", scheduled_at: CONFIRMED_UTC },
    ],
    hlPutStatus: 422,
    hlPutBody: { message: "internal calendar id cal_secret is locked" },
  });
  const result = await withFetch(fake, () =>
    cancelHighLevelTool.run({ appointment_datetime_iso: CONFIRMED }, ctx),
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /NO se canceló/);
  assert.doesNotMatch(result.error ?? "", /cal_secret/);
});

test("cancel: the playground (no real contact) does nothing", async () => {
  const fake = hlAppointmentFetch({});
  const result = await withFetch(fake, () =>
    cancelHighLevelTool.run(
      { appointment_datetime_iso: CONFIRMED },
      { ...ctx, contactId: "" },
    ),
  );
  assert.equal(result.ok, false);
  assert.ok(!fake.calls.some((c) => c.url.includes("/rest/v1/appointments")));
});

// ── reschedule_highlevel ────────────────────────────────────────────────────

test("reschedule: moves the appointment at the confirmed time and updates the local row", async () => {
  const fake = hlAppointmentFetch({
    localAppointments: [
      { id: "a1", hl_appointment_id: "hl_1", status: "booked", scheduled_at: CONFIRMED_UTC },
    ],
  });
  const result = await withFetch(fake, () =>
    rescheduleHighLevelTool.run(
      { appointment_datetime_iso: CONFIRMED, new_datetime_iso: NEW_TIME },
      ctx,
    ),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { rescheduled: true, new_datetime: NEW_TIME });
  const puts = hlPuts(fake.calls);
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0].body, { startTime: NEW_TIME });
  const patch = fake.calls.find((c) => c.method === "PATCH");
  assert.deepEqual(patch?.body, { scheduled_at: "2030-06-15T18:00:00.000Z" });
});

test("reschedule: a retry finds the appointment already at the new time and changes nothing", async () => {
  const fake = hlAppointmentFetch({
    localAppointments: [
      { id: "a1", hl_appointment_id: "hl_1", status: "booked", scheduled_at: NEW_TIME_UTC },
    ],
  });
  const result = await withFetch(fake, () =>
    rescheduleHighLevelTool.run(
      { appointment_datetime_iso: CONFIRMED, new_datetime_iso: NEW_TIME },
      ctx,
    ),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, {
    rescheduled: true,
    already_rescheduled: true,
    new_datetime: NEW_TIME,
  });
  assert.equal(hlPuts(fake.calls).length, 0);
});

test("reschedule: a cancelled appointment is not moved", async () => {
  const fake = hlAppointmentFetch({
    localAppointments: [
      { id: "a1", hl_appointment_id: "hl_1", status: "cancelled", scheduled_at: CONFIRMED_UTC },
    ],
  });
  const result = await withFetch(fake, () =>
    rescheduleHighLevelTool.run(
      { appointment_datetime_iso: CONFIRMED, new_datetime_iso: NEW_TIME },
      ctx,
    ),
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /cancelada/);
  assert.equal(hlPuts(fake.calls).length, 0);
});

test("reschedule: nothing at the confirmed time means not found, never the next appointment", async () => {
  const fake = hlAppointmentFetch({
    localAppointments: [
      {
        id: "a3",
        hl_appointment_id: "hl_3",
        status: "booked",
        scheduled_at: "2030-07-01T16:00:00+00:00",
      },
    ],
  });
  const result = await withFetch(fake, () =>
    rescheduleHighLevelTool.run(
      { appointment_datetime_iso: CONFIRMED, new_datetime_iso: NEW_TIME },
      ctx,
    ),
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /No encontré una cita activa/);
  assert.equal(hlPuts(fake.calls).length, 0);
});

test("reschedule: the same time twice is refused", async () => {
  const fake = hlAppointmentFetch({});
  const result = await withFetch(fake, () =>
    rescheduleHighLevelTool.run(
      { appointment_datetime_iso: CONFIRMED, new_datetime_iso: CONFIRMED_UTC },
      ctx,
    ),
  );
  assert.equal(result.ok, false);
  assert.ok(!fake.calls.some((c) => c.url.includes("leadconnectorhq")));
});

test("both tools are write tools, so the registry never retries them", () => {
  assert.equal(cancelHighLevelTool.sensitivity, "write");
  assert.equal(rescheduleHighLevelTool.sensitivity, "write");
});
