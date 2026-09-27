import assert from "node:assert/strict";
import { test } from "node:test";
import { scheduleHighLevelTool } from "./schedule-highlevel.ts";
import { UnknownOutcomeError } from "../lib/hl-appointment.ts";
import type { ToolContext } from "../core/tool";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

const ctx: ToolContext = {
  workspaceId: "ws_1",
  conversationId: "conv_1",
  contactId: "contact_1",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
  version: string | null;
}

function mockFetch(opts: {
  hlStatus: number;
  hlBody?: unknown;
  appointmentInsertStatus: number;
  appointmentInsertBody?: unknown;
  businessTimezone?: string;
  hlTimezone?: string;
  /** The contact's appointments in HighLevel, and each one's event read. */
  hlContactEvents?: Array<Record<string, unknown>>;
  hlEvents?: Record<string, Record<string, unknown>>;
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
      version: new Headers(init?.headers).get("Version"),
    });

    // Supabase integrations table (get workspace HighLevel config)
    if (url.includes("/rest/v1/integrations")) {
      return jsonResponse(200, [
        {
          credentials: { highlevel_pit: "tok_123" },
          config: {
            location_id: "loc_1",
            calendar_id: "cal_1",
            ...(opts.hlTimezone ? { timezone: opts.hlTimezone } : {}),
          },
          enabled: true,
        },
      ]);
    }

    if (url.includes("/rest/v1/business_info")) {
      return jsonResponse(
        200,
        opts.businessTimezone
          ? [{ structured: { timezone: opts.businessTimezone }, free_text: null }]
          : [],
      );
    }

    // Supabase contacts table (get contact phone for scheduling).
    // NOTE: .single() (unlike .maybeSingle()) does not unwrap a JSON array
    // client-side in postgrest-js — it just sets the
    // "Accept: application/vnd.pgrst.object+json" header and trusts a real
    // Postgrest server to already return a bare object. So this mock must
    // return the object directly, not wrapped in an array.
    if (url.includes("/rest/v1/contacts") && method === "GET") {
      const row = { hl_contact_id: "hl_contact_1", phone: "+5215512345678", name: "Juan" };
      // .maybeSingle() reads an array; .single() asks for a bare object.
      const wantsObject = new Headers(init?.headers).get("Accept")?.includes("pgrst.object");
      return jsonResponse(200, wantsObject ? row : [row]);
    }

    // HighLevel: the contact's appointments, and one appointment.
    if (url.includes("leadconnectorhq.com/contacts/hl_contact_1/appointments")) {
      return jsonResponse(200, { events: opts.hlContactEvents ?? [] });
    }
    if (url.includes("leadconnectorhq.com/calendars/events/appointments/") && method === "GET") {
      const event = opts.hlEvents?.[url.split("/").pop()!];
      return event ? jsonResponse(200, { event }) : jsonResponse(404, {});
    }
    if (url.includes("/rest/v1/messages")) {
      return method === "GET" ? jsonResponse(200, []) : new Response(null, { status: 201 });
    }

    // HighLevel API: create appointment
    if (
      url.includes(
        "services.leadconnectorhq.com/calendars/events/appointments",
      ) &&
      method === "POST"
    ) {
      return jsonResponse(opts.hlStatus, opts.hlBody ?? {});
    }

    if (url.includes("/rest/v1/appointments") && method === "GET") {
      return jsonResponse(200, []);
    }

    // Supabase appointments table: persist the booking locally
    if (url.includes("/rest/v1/appointments") && method === "POST") {
      return jsonResponse(
        opts.appointmentInsertStatus,
        opts.appointmentInsertBody ?? {},
      );
    }

    // Supabase events table: log errors when persistence fails
    if (url.includes("/rest/v1/events") && method === "POST") {
      return jsonResponse(201, {});
    }

    throw new Error(`unexpected fetch call: ${method} ${url}`);
  };

  return { fn, calls };
}

test("books the appointment and persists it locally on the happy path", async () => {
  const { fn, calls } = mockFetch({
    hlStatus: 200,
    hlBody: { id: "hl_evt_1" },
    appointmentInsertStatus: 201,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await scheduleHighLevelTool.run(
      { datetime_iso: "2027-06-12T10:00:00-06:00" },
      ctx,
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.output, {
      appointment_id: "hl_evt_1",
      datetime: "2027-06-12T10:00:00-06:00",
    });

    const eventCall = calls.find(
      (c) => c.url.includes("/rest/v1/events") && c.method === "POST",
    );
    assert.equal(
      eventCall,
      undefined,
      "should not log a persist-failed event when the insert succeeds",
    );
    // POST /calendars/events/appointments in HighLevel's OpenAPI spec.
    const booking = calls.find((c) => c.method === "POST" && c.url.includes("leadconnectorhq"));
    assert.equal(booking?.version, "2021-04-15");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reports the HighLevel error when the API call itself fails", async () => {
  const { fn } = mockFetch({
    hlStatus: 400,
    hlBody: { message: "Slot not available" },
    appointmentInsertStatus: 201,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await scheduleHighLevelTool.run(
      { datetime_iso: "2027-06-12T10:00:00-06:00" },
      ctx,
    );
    assert.equal(result.ok, false);
    // A slot taken by someone else: nothing was booked, and the model offers another.
    assert.match(result.error ?? "", /check_availability/);
    assert.doesNotMatch(result.error ?? "", /Slot not available/);
    assert.equal(result.output, null, "no needs_human: nothing to follow up");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("still reports success to the caller when the local insert fails (the HL booking already happened)", async () => {
  const { fn } = mockFetch({
    hlStatus: 200,
    hlBody: { id: "hl_evt_1" },
    appointmentInsertStatus: 500,
    appointmentInsertBody: { message: "db unavailable" },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await scheduleHighLevelTool.run(
      { datetime_iso: "2027-06-12T10:00:00-06:00" },
      ctx,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.output, {
      appointment_id: "hl_evt_1",
      datetime: "2027-06-12T10:00:00-06:00",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("logs a visible error event to the events table when the local insert fails", async () => {
  const { fn, calls } = mockFetch({
    hlStatus: 200,
    hlBody: { id: "hl_evt_1" },
    appointmentInsertStatus: 500,
    appointmentInsertBody: { message: "db unavailable" },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    await scheduleHighLevelTool.run(
      { datetime_iso: "2027-06-12T10:00:00-06:00" },
      ctx,
    );

    const eventCall = calls.find(
      (c) => c.url.includes("/rest/v1/events") && c.method === "POST",
    );
    assert.ok(eventCall, "expected an events row logging the failed persist");
    const body = eventCall!.body as {
      type: string;
      level: string;
      workspace_id: string;
      conversation_id: string;
      payload: Record<string, unknown>;
    };
    assert.equal(body.type, "appointment_persist_failed");
    assert.equal(body.level, "error");
    assert.equal(body.workspace_id, "ws_1");
    assert.equal(body.conversation_id, "conv_1");
    assert.equal(body.payload.provider, "highlevel");
    assert.equal(body.payload.hl_appointment_id, "hl_evt_1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("in a real conversation, a phone passed by the model is ignored: it books the chat's contact", async () => {
  const { fn, calls } = mockFetch({
    hlStatus: 200,
    hlBody: { id: "hl_evt_1" },
    appointmentInsertStatus: 201,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await scheduleHighLevelTool.run(
      { datetime_iso: "2027-06-12T10:00:00-06:00", contact_phone: "+15550009999" },
      ctx,
    );
    assert.equal(result.ok, true);
    const booking = calls.find(
      (c) =>
        c.method === "POST" &&
        c.url.includes("services.leadconnectorhq.com/calendars/events/appointments"),
    );
    assert.equal((booking?.body as { contactId?: string }).contactId, "hl_contact_1");
    assert.ok(
      !calls.some((c) => c.url.includes("services.leadconnectorhq.com/contacts")),
      "never upserts a HighLevel contact for the model's phone",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function runWith(fn: typeof fetch, args: { datetime_iso: string }, timeoutMs?: number) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn;
  try {
    return await scheduleHighLevelTool.run(args, ctx, timeoutMs === undefined ? undefined : { timeoutMs });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const bookingOf = (calls: FetchCall[]) =>
  calls.find((c) => c.method === "POST" && c.url.includes("leadconnectorhq"));

test("a slot with another zone's offset is refused, never booked", async () => {
  // Business in Cancún (-05:00): "10:00-06:00" is 11:00 there — a slot copied
  // from somewhere else, so nothing is guessed.
  const { fn, calls } = mockFetch({
    hlStatus: 200,
    hlBody: { id: "hl_evt_1" },
    appointmentInsertStatus: 201,
    businessTimezone: "America/Cancun",
  });
  const result = await runWith(fn as typeof fetch, { datetime_iso: "2027-06-12T10:00:00-06:00" });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /America\/Cancun/);
  assert.equal(bookingOf(calls), undefined);
});

test("business zone unset: the HighLevel zone reads the slot, and the booking carries its offset", async () => {
  const { fn, calls } = mockFetch({
    hlStatus: 200,
    hlBody: { id: "hl_evt_1" },
    appointmentInsertStatus: 201,
    hlTimezone: "America/Cancun",
  });
  const result = await runWith(fn as typeof fetch, { datetime_iso: "2027-06-12T10:00:00" });
  assert.equal(result.ok, true);
  assert.equal((bookingOf(calls)?.body as { startTime: string }).startTime, "2027-06-12T10:00:00-05:00");
  const local = calls.find((c) => c.url.includes("/rest/v1/appointments") && c.method === "POST");
  assert.equal((local?.body as { scheduled_at: string }).scheduled_at, "2027-06-12T15:00:00.000Z");
});

test("a 401 (or another 4xx that isn't a taken slot) hands off, with a note for the team", async () => {
  const { fn, calls } = mockFetch({ hlStatus: 401, hlBody: { message: "Invalid JWT" }, appointmentInsertStatus: 201 });
  const result = await runWith(fn as typeof fetch, { datetime_iso: "2027-06-12T10:00:00-06:00" });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /\(401\)/);
  assert.match(result.error ?? "", /NO se agendó/);
  assert.deepEqual(result.output, { needs_human: true });
  assert.ok(calls.some((c) => c.method === "POST" && c.url.includes("/rest/v1/messages")), "a note");
});

test("'slot taken' by the contact's own booking (an earlier call's answer was lost): already booked", async () => {
  const { fn, calls } = mockFetch({
    hlStatus: 400,
    hlBody: { message: "The slot you have selected is no longer available." },
    appointmentInsertStatus: 201,
    hlContactEvents: [
      { id: "hl_mine", calendarId: "cal_1", appointmentStatus: "booked", startTime: "2027-06-12 10:00:00" },
    ],
    hlEvents: { hl_mine: { appointmentStatus: "booked", startTime: "2027-06-12T10:00:00-06:00" } },
  });
  const result = await runWith(fn as typeof fetch, { datetime_iso: "2027-06-12T10:00:00-06:00" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, {
    appointment_id: "hl_mine",
    datetime: "2027-06-12T10:00:00-06:00",
    already_booked: true,
  });
  // HighLevel's read is the answer, not a second booking.
  assert.equal(calls.filter((c) => c.method === "POST" && c.url.includes("leadconnectorhq")).length, 1);
});

test("the slot-taken wording is narrow: a 400 about something else isn't read as a taken slot", async () => {
  const { fn } = mockFetch({
    hlStatus: 400,
    hlBody: { message: "calendarId is not available for this location" },
    appointmentInsertStatus: 201,
  });
  const result = await runWith(fn as typeof fetch, { datetime_iso: "2027-06-12T10:00:00-06:00" });
  assert.deepEqual(result.output, { needs_human: true });
});

test("with too little of its budget left for the POST, nothing is booked and it says so", async () => {
  const { fn, calls } = mockFetch({ hlStatus: 200, hlBody: { id: "hl_evt_1" }, appointmentInsertStatus: 201 });
  const result = await runWith(fn as typeof fetch, { datetime_iso: "2027-06-12T10:00:00-06:00" }, 9_000);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /NO se agendó/);
  assert.equal(bookingOf(calls), undefined);
});

test("a past slot is refused", async () => {
  const { fn, calls } = mockFetch({ hlStatus: 200, appointmentInsertStatus: 201 });
  const result = await runWith(fn as typeof fetch, { datetime_iso: "2020-06-12T10:00:00-06:00" });
  assert.equal(result.ok, false);
  assert.equal(bookingOf(calls), undefined);
});

test("a 5xx or no answer from HighLevel is an unknown outcome, not a failure", async () => {
  const { fn } = mockFetch({ hlStatus: 502, appointmentInsertStatus: 201 });
  await assert.rejects(
    runWith(fn as typeof fetch, { datetime_iso: "2027-06-12T10:00:00-06:00" }),
    (err: unknown) => err instanceof UnknownOutcomeError && /No pude confirmar/.test(err.message),
  );

  const dropped = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("leadconnectorhq")) throw new TypeError("fetch failed");
    return fn(input, init);
  }) as typeof fetch;
  await assert.rejects(
    runWith(dropped, { datetime_iso: "2027-06-12T10:00:00-06:00" }),
    (err: unknown) => err instanceof UnknownOutcomeError,
  );
});
