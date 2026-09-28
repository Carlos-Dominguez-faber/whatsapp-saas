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
  hlEvents?: Record<string, Record<string, unknown> | { httpStatus: number }>;
  /** The booking's 2xx body isn't JSON. */
  hlBodyRaw?: string;
  /** The events table refuses inserts (the playground trace). */
  eventsFail?: boolean;
  /** The workspace's country code (business_info), for numbers typed without one. */
  countryCode?: string;
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
      const structured = {
        ...(opts.businessTimezone ? { timezone: opts.businessTimezone } : {}),
        ...(opts.countryCode ? { default_country_code: opts.countryCode } : {}),
      };
      return jsonResponse(
        200,
        Object.keys(structured).length > 0 ? [{ structured, free_text: null }] : [],
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

    // HighLevel: a contact upserted by phone (the playground books that way).
    if (url.includes("leadconnectorhq.com/contacts/upsert")) {
      return jsonResponse(200, { contact: { id: "hl_playground_contact" } });
    }

    // HighLevel: the contact's appointments, and one appointment.
    if (url.includes("leadconnectorhq.com/contacts/hl_contact_1/appointments")) {
      return jsonResponse(200, { events: opts.hlContactEvents ?? [] });
    }
    if (url.includes("leadconnectorhq.com/calendars/events/appointments/") && method === "GET") {
      const event = opts.hlEvents?.[url.split("/").pop()!];
      if (event && "httpStatus" in event) return jsonResponse(event.httpStatus as number, {});
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
      if (opts.hlBodyRaw !== undefined) return new Response(opts.hlBodyRaw, { status: opts.hlStatus });
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

    // Supabase events table: the playground trace (insert, then its
    // outcome), and persist failures.
    if (url.includes("/rest/v1/events") && method === "POST") {
      if (opts.eventsFail) return jsonResponse(500, { message: "db down" });
      const wantsObject = new Headers(init?.headers).get("Accept")?.includes("pgrst.object");
      return jsonResponse(201, wantsObject ? { id: "evt_trace" } : [{ id: "evt_trace" }]);
    }
    if (url.includes("/rest/v1/events") && method === "PATCH") {
      return new Response(null, { status: 204 });
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
    // Created a minute ago: this tool's earlier call.
    hlEvents: {
      hl_mine: {
        appointmentStatus: "booked",
        startTime: "2027-06-12T10:00:00-06:00",
        dateAdded: new Date(Date.now() - 60_000).toISOString(),
      },
    },
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

const SLOT_TAKEN_400 = {
  hlStatus: 400,
  hlBody: { message: "The slot you have selected is no longer available." },
  appointmentInsertStatus: 201,
};
const mineAt10 = (fields: Record<string, unknown>) => ({
  hlContactEvents: [
    { id: "hl_mine", calendarId: "cal_1", appointmentStatus: "booked", startTime: "2027-06-12 10:00:00" },
  ],
  hlEvents: { hl_mine: { appointmentStatus: "booked", startTime: "2027-06-12T10:00:00-06:00", ...fields } },
});

test("'slot taken' by an appointment the contact already had (not this tool's): nothing new, neutral answer", async () => {
  // A parent booking for a child: the old booking is theirs, but no new one was made.
  const { fn } = mockFetch({
    ...SLOT_TAKEN_400,
    ...mineAt10({ dateAdded: new Date(Date.now() - 30 * 24 * 3600_000).toISOString() }),
  });
  const result = await runWith(fn as typeof fetch, { datetime_iso: "2027-06-12T10:00:00-06:00" });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /ya tenía una cita a esa hora/);
  assert.match(result.error ?? "", /no se creó otra/);
  assert.deepEqual(result.output, { existing_appointment: "2027-06-12T10:00:00-06:00" });

  // Without dateAdded it can't be told apart: neutral too.
  const { fn: noDate } = mockFetch({ ...SLOT_TAKEN_400, ...mineAt10({}) });
  const r2 = await runWith(noDate as typeof fetch, { datetime_iso: "2027-06-12T10:00:00-06:00" });
  assert.equal(r2.ok, false);
});

test("'slot taken' that can't be confirmed (a failed read, or two of theirs) hands off", async () => {
  const { fn } = mockFetch({
    ...SLOT_TAKEN_400,
    hlContactEvents: [
      { id: "hl_x", calendarId: "cal_1", appointmentStatus: "booked", startTime: "2027-06-12 10:00:00" },
    ],
    hlEvents: { hl_x: { httpStatus: 500 } },
  });
  const unconfirmed = await runWith(fn as typeof fetch, { datetime_iso: "2027-06-12T10:00:00-06:00" });
  assert.deepEqual(unconfirmed.output, { needs_human: true });
  assert.match(unconfirmed.error ?? "", /No pude confirmar/);

  const two = { appointmentStatus: "booked", startTime: "2027-06-12T10:00:00-06:00" };
  const { fn: ambiguous } = mockFetch({
    ...SLOT_TAKEN_400,
    hlContactEvents: [
      { id: "hl_a", calendarId: "cal_1", appointmentStatus: "booked", startTime: "2027-06-12 10:00:00" },
      { id: "hl_b", calendarId: "cal_1", appointmentStatus: "booked", startTime: "2027-06-12 10:00:00" },
    ],
    hlEvents: { hl_a: two, hl_b: two },
  });
  const r2 = await runWith(ambiguous as typeof fetch, { datetime_iso: "2027-06-12T10:00:00-06:00" });
  assert.deepEqual(r2.output, { needs_human: true });
});

test("'slot taken' with no budget left to ask whose it is: a plain 'not booked'", async () => {
  // 13 s: enough for the POST (10 s), not for the lookup after it (14 s).
  const { fn, calls } = mockFetch({ ...SLOT_TAKEN_400, ...mineAt10({}) });
  const result = await runWith(fn as typeof fetch, { datetime_iso: "2027-06-12T10:00:00-06:00" }, 13_000);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /NO se agendó/);
  assert.equal(result.output, null);
  assert.ok(!calls.some((c) => c.url.includes("leadconnectorhq.com/contacts/")), "no lookup");
});

test("a 2xx whose body can't be read is still a booking: ok, no id, and a note for the team", async () => {
  const { fn, calls } = mockFetch({ hlStatus: 201, hlBodyRaw: "<html>ok</html>", appointmentInsertStatus: 201 });
  const result = await runWith(fn as typeof fetch, { datetime_iso: "2027-06-12T10:00:00-06:00" });
  assert.equal(result.ok, true);
  assert.equal((result.output as { appointment_id: unknown }).appointment_id, null);
  assert.ok(calls.some((c) => c.method === "POST" && c.url.includes("/rest/v1/messages")), "a note");
});

test("the booking's local row is an upsert on the HighLevel id, keeping the conversation", async () => {
  const { fn, calls } = mockFetch({ hlStatus: 200, hlBody: { id: "hl_evt_1" }, appointmentInsertStatus: 201 });
  await runWith(fn as typeof fetch, { datetime_iso: "2027-06-12T10:00:00-06:00" });
  const write = calls.find((c) => c.url.includes("/rest/v1/appointments") && c.method === "POST");
  assert.ok(decodeURIComponent(write!.url).includes("on_conflict=workspace_id,hl_appointment_id"), write!.url);
  assert.equal((write!.body as { conversation_id: string }).conversation_id, "conv_1");
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

/** Runs the tool as the playground does: no contact, no conversation. */
async function runInPlayground(
  fn: typeof fetch,
  args: Record<string, unknown>,
  userMessages: string[],
) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn;
  try {
    return await scheduleHighLevelTool.run(
      { datetime_iso: "2027-06-12T10:00:00-06:00", ...args } as never,
      {
        workspaceId: "ws_1",
        conversationId: "",
        contactId: "",
        playground: { userId: "admin_1", userMessages },
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("playground: a phone the tester typed books a marked test appointment, with a trace", async () => {
  const { fn, calls } = mockFetch({ hlStatus: 200, hlBody: { id: "hl_evt_pg" }, appointmentInsertStatus: 201 });
  // Typed with spaces and the old Mexican mobile prefix; the model passes it compact.
  const result = await runInPlayground(
    fn as typeof fetch,
    { contact_phone: "+525512345678", contact_name: "Nombre Inventado" },
    ["hola, quiero agendar", "mi teléfono de prueba es +52 1 55 1234 5678"],
  );
  assert.equal(result.ok, true);

  // The number as typed (placed), and an existing contact keeps its name.
  const upsert = calls.find((c) => c.url.includes("/contacts/upsert"));
  assert.deepEqual(upsert?.body, { locationId: "loc_1", phone: "+5215512345678" });

  const booking = calls.find((c) => c.method === "POST" && c.url.endsWith("/calendars/events/appointments"));
  assert.equal((booking?.body as { contactId: string }).contactId, "hl_playground_contact");
  assert.match((booking?.body as { title: string }).title, /^\[Prueba\] /);

  // Who ran it, with what phone — recorded before HighLevel is touched —
  // and then how it went.
  const traceAt = calls.findIndex((c) => c.url.includes("/rest/v1/events") && c.method === "POST");
  const upsertAt = calls.findIndex((c) => c.url.includes("/contacts/upsert"));
  assert.ok(traceAt >= 0 && traceAt < upsertAt, "the trace comes first");
  const event = calls[traceAt].body as { type: string; payload: Record<string, unknown> };
  assert.equal(event.type, "playground_write");
  assert.equal(event.payload.user_id, "admin_1");
  assert.equal(event.payload.tool, "schedule_highlevel");
  assert.equal(event.payload.phone, "+5215512345678");
  assert.equal(event.payload.outcome, "attempted");
  const outcome = calls.find((c) => c.url.includes("/rest/v1/events") && c.method === "PATCH");
  assert.equal((outcome?.body as { payload: Record<string, unknown> }).payload.outcome, "booked");
  assert.equal((outcome?.body as { payload: Record<string, unknown> }).payload.appointment_id, "hl_evt_pg");

  // No conversation: null, not "".
  const row = calls.find((c) => c.url.includes("/rest/v1/appointments") && c.method === "POST");
  assert.equal((row?.body as { conversation_id: unknown }).conversation_id, null);
});

test("playground: a phone the tester never typed is refused before anything is written", async () => {
  for (const phone of ["+5215512345678", "+5215599990000"]) {
    const { fn, calls } = mockFetch({ hlStatus: 200, hlBody: { id: "x" }, appointmentInsertStatus: 201 });
    const result = await runInPlayground(fn as typeof fetch, { contact_phone: phone }, [
      "quiero una cita el martes",
      "mi número es +52 998 111 2222",
    ]);
    assert.equal(result.ok, false, phone);
    assert.match(result.error ?? "", /escribe en el chat el teléfono de prueba/);
    assert.ok(!calls.some((c) => c.url.includes("leadconnectorhq")), phone);
  }
});

test("outside the playground, a turn with no contact never books on a phone the model passes", async () => {
  const { fn, calls } = mockFetch({ hlStatus: 200, hlBody: { id: "x" }, appointmentInsertStatus: 201 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;
  try {
    const result = await scheduleHighLevelTool.run(
      { datetime_iso: "2027-06-12T10:00:00-06:00", contact_phone: "+5215512345678" },
      { workspaceId: "ws_1", conversationId: "", contactId: "" },
    );
    assert.equal(result.ok, false);
    assert.ok(!calls.some((c) => c.url.includes("leadconnectorhq")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the tool's descriptions carry no example phone the model could use", () => {
  const shape = (scheduleHighLevelTool.schema as unknown as {
    shape: Record<string, { description?: string }>;
  }).shape;
  const texts = [scheduleHighLevelTool.description, ...Object.values(shape).map((f) => f.description ?? "")];
  assert.match(shape.contact_phone.description ?? "", /tal como el usuario lo escribió/);
  for (const text of texts) assert.doesNotMatch(text, /\+\d[\d\s]{9,}/, text);
});

/** The phone HighLevel was asked to upsert, if any. */
const upsertedPhone = (calls: FetchCall[]) =>
  (calls.find((c) => c.url.includes("/contacts/upsert"))?.body as { phone?: string } | undefined)?.phone;

test("playground: a Mexican mobile typed with its old 1 is not a US number the model can swap in", async () => {
  const { fn, calls } = mockFetch({ hlStatus: 200, hlBody: { id: "x" }, appointmentInsertStatus: 201 });
  // "1 55 1234 5678", bare, is a Mexican mobile (+52 1 55…); "+15512345678" is a US line.
  const result = await runInPlayground(fn as typeof fetch, { contact_phone: "+15512345678" }, [
    "mi cel es 1 55 1234 5678",
  ]);
  assert.equal(result.ok, false);
  assert.equal(upsertedPhone(calls), undefined);

  // The model's value for the same line books the typed number.
  const ok = mockFetch({ hlStatus: 200, hlBody: { id: "x" }, appointmentInsertStatus: 201 });
  const booked = await runInPlayground(ok.fn as typeof fetch, { contact_phone: "+525512345678" }, [
    "mi cel es 1 55 1234 5678",
  ]);
  assert.equal(booked.ok, true);
  assert.equal(upsertedPhone(ok.calls), "+525512345678");
});

test("playground: an Argentine mobile typed with its 9 is not an Indian number", async () => {
  const { fn, calls } = mockFetch({
    hlStatus: 200,
    hlBody: { id: "x" },
    appointmentInsertStatus: 201,
    countryCode: "54",
  });
  const result = await runInPlayground(fn as typeof fetch, { contact_phone: "+91123456789" }, [
    "llamame al 9 11 2345 6789",
  ]);
  assert.equal(result.ok, false);
  assert.equal(upsertedPhone(calls), undefined);

  const ok = mockFetch({ hlStatus: 200, hlBody: { id: "x" }, appointmentInsertStatus: 201, countryCode: "54" });
  const booked = await runInPlayground(ok.fn as typeof fetch, { contact_phone: "+5491123456789" }, [
    "llamame al 9 11 2345 6789",
  ]);
  assert.equal(booked.ok, true);
  assert.equal(upsertedPhone(ok.calls), "+541123456789");
});

test("playground: whatever the model adds to the number, HighLevel gets the typed one", async () => {
  const { fn, calls } = mockFetch({ hlStatus: 200, hlBody: { id: "x" }, appointmentInsertStatus: 201 });
  const result = await runInPlayground(fn as typeof fetch, { contact_phone: "+529981112222 (casa)" }, [
    "es el +52 998 111 2222",
  ]);
  assert.equal(result.ok, true);
  assert.equal(upsertedPhone(calls), "+529981112222");

  // Digits the tester never typed make it another number.
  const extra = mockFetch({ hlStatus: 200, hlBody: { id: "x" }, appointmentInsertStatus: 201 });
  const refused = await runInPlayground(extra.fn as typeof fetch, { contact_phone: "+52 998 111 2222 ext 5" }, [
    "es el +52 998 111 2222",
  ]);
  assert.equal(refused.ok, false);
});

test("playground: the same digits under another country code are another line", async () => {
  const { fn, calls } = mockFetch({ hlStatus: 200, hlBody: { id: "x" }, appointmentInsertStatus: 201 });
  const result = await runInPlayground(fn as typeof fetch, { contact_phone: "+1 998 111 2222" }, [
    "es el +52 998 111 2222",
  ]);
  assert.equal(result.ok, false);
  assert.equal(upsertedPhone(calls), undefined);
});

test("playground: without its trace, nothing is booked", async () => {
  const { fn, calls } = mockFetch({
    hlStatus: 200,
    hlBody: { id: "x" },
    appointmentInsertStatus: 201,
    eventsFail: true,
  });
  const result = await runInPlayground(fn as typeof fetch, { contact_phone: "+529981112222" }, [
    "+52 998 111 2222",
  ]);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /NO se agendó/);
  assert.ok(!calls.some((c) => c.url.includes("leadconnectorhq")), "HighLevel untouched");
});

test("playground: a refused or unknown booking is recorded as such in its trace", async () => {
  const outcomeOf = (calls: FetchCall[]) =>
    (calls.find((c) => c.url.includes("/rest/v1/events") && c.method === "PATCH")?.body as {
      payload: { outcome: string };
    } | undefined)?.payload.outcome;

  const refused = mockFetch({ hlStatus: 401, hlBody: { message: "Invalid JWT" }, appointmentInsertStatus: 201 });
  await runInPlayground(refused.fn as typeof fetch, { contact_phone: "+529981112222" }, ["+52 998 111 2222"]);
  assert.equal(outcomeOf(refused.calls), "refused");

  const unknown = mockFetch({ hlStatus: 503, appointmentInsertStatus: 201 });
  await assert.rejects(
    runInPlayground(unknown.fn as typeof fetch, { contact_phone: "+529981112222" }, ["+52 998 111 2222"]),
  );
  assert.equal(outcomeOf(unknown.calls), "unknown");
});
