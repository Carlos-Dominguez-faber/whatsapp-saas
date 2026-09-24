import assert from "node:assert/strict";
import { test } from "node:test";
import { scheduleCalComTool } from "./schedule-calcom.ts";
import type { ToolContext } from "../core/tool";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

const ctx: ToolContext = {
  workspaceId: "ws_1",
  conversationId: "conv_1",
  contactId: "contact_1",
};

const playgroundCtx: ToolContext = {
  workspaceId: "ws_1",
  conversationId: null,
  contactId: null,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function conflictResponse(): Response {
  return jsonResponse(409, {
    code: "23505",
    message:
      'duplicate key value violates unique constraint "idx_appointments_calcom_slot_claim"',
    details: null,
    hint: null,
  });
}

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

function mockFetch(opts: {
  contactEmail: string | null;
  calcomStatus: number;
  calcomBody?: unknown;
  knownEventTypeIds?: number[];
  recurringEventTypeIds?: number[];
  claimConflict?: boolean;
  conflictExisting?: {
    calcom_booking_uid: string | null;
    calcom_event_type_id: number | null;
  } | null;
  claimInsertStatus?: number;
  claimInsertAttemptsUntilOk?: number;
  updateStatus?: number;
  updateAttemptsUntilOk?: number;
  eventsInsertStatus?: number;
}) {
  const calls: FetchCall[] = [];
  let claimAttempts = 0;
  let updateAttempts = 0;

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
    });

    if (url.includes("/rest/v1/integrations")) {
      return jsonResponse(200, [
        {
          credentials: { calcom_api_key: "cal_test_123" },
          config: { timezone: "America/Santiago" },
          enabled: true,
        },
      ]);
    }

    if (url.includes("/rest/v1/contacts") && method === "GET") {
      return jsonResponse(200, [{ email: opts.contactEmail }]);
    }

    if (url.includes("api.cal.com/v2/event-types")) {
      return jsonResponse(200, {
        status: "success",
        data: (opts.knownEventTypeIds ?? [1]).map((id) => ({
          id,
          recurrence: (opts.recurringEventTypeIds ?? []).includes(id)
            ? { interval: 1, occurrences: 4, frequency: "weekly", disabled: false }
            : null,
        })),
      });
    }

    if (url.includes("/rest/v1/appointments") && method === "POST") {
      claimAttempts++;
      if (opts.claimConflict) return conflictResponse();
      if (
        opts.claimInsertAttemptsUntilOk &&
        claimAttempts < opts.claimInsertAttemptsUntilOk
      ) {
        return jsonResponse(opts.claimInsertStatus ?? 500, {
          message: "db unavailable",
        });
      }
      return jsonResponse(201, { id: "claim_row_1" });
    }

    if (url.includes("/rest/v1/appointments") && method === "GET") {
      return jsonResponse(
        200,
        opts.conflictExisting ? [opts.conflictExisting] : [],
      );
    }

    if (url.includes("/rest/v1/appointments") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }

    if (url.includes("/rest/v1/appointments") && method === "PATCH") {
      updateAttempts++;
      if (
        opts.updateAttemptsUntilOk &&
        updateAttempts < opts.updateAttemptsUntilOk
      ) {
        return jsonResponse(opts.updateStatus ?? 500, {
          message: "db unavailable",
        });
      }
      return new Response(null, { status: opts.updateStatus ?? 204 });
    }

    if (url.includes("api.cal.com/v2/bookings")) {
      return jsonResponse(opts.calcomStatus, opts.calcomBody ?? {});
    }

    if (url.includes("/rest/v1/events") && method === "POST") {
      return jsonResponse(opts.eventsInsertStatus ?? 201, {});
    }

    throw new Error(`unexpected fetch call: ${method} ${url}`);
  };

  return { fn, calls };
}

test("books an appointment using the contact's stored email", async () => {
  const { fn, calls } = mockFetch({
    contactEmail: "cliente@example.com",
    calcomStatus: 201,
    calcomBody: { status: "success", data: { uid: "booking_uid_1" } },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await scheduleCalComTool.run(
      {
        event_type_id: 1,
        datetime_iso: "2026-06-12T15:00:00Z",
        attendee_name: "Juan Pérez",
      },
      ctx,
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.output, {
      booking_uid: "booking_uid_1",
      datetime: "2026-06-12T15:00:00Z",
    });

    const claimCall = calls.find(
      (c) => c.url.includes("/rest/v1/appointments") && c.method === "POST",
    );
    assert.ok(claimCall, "expected the slot to be claimed before booking");
    assert.equal(
      (claimCall!.body as { calcom_event_type_id?: number })
        .calcom_event_type_id,
      1,
    );
    assert.equal(
      (claimCall!.body as { calcom_booking_uid?: unknown })
        .calcom_booking_uid,
      null,
    );

    const bookingCall = calls.find((c) => c.url.includes("/v2/bookings"));
    assert.ok(bookingCall, "expected a call to create the booking");
    assert.deepEqual(bookingCall!.body, {
      start: "2026-06-12T15:00:00Z",
      eventTypeId: 1,
      attendee: {
        name: "Juan Pérez",
        email: "cliente@example.com",
        timeZone: "America/Santiago",
      },
    });
    assert.ok(
      calls.findIndex((c) => c === claimCall) <
        calls.findIndex((c) => c === bookingCall),
      "the slot must be claimed BEFORE calling Cal.com, not after",
    );

    const updateCall = calls.find(
      (c) => c.url.includes("/rest/v1/appointments") && c.method === "PATCH",
    );
    assert.ok(updateCall, "expected the claim to be filled in with the uid");
    assert.equal(
      (updateCall!.body as { calcom_booking_uid?: string })
        .calcom_booking_uid,
      "booking_uid_1",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("asks for the email instead of guessing one when missing", async () => {
  const { fn, calls } = mockFetch({ contactEmail: null, calcomStatus: 201 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await scheduleCalComTool.run(
      {
        event_type_id: 1,
        datetime_iso: "2026-06-12T15:00:00Z",
        attendee_name: "Juan Pérez",
      },
      ctx,
    );

    assert.equal(result.ok, false);
    assert.equal(
      result.error,
      "Necesito el email del cliente para agendar en Cal.com — pídeselo antes de reintentar",
    );

    const bookingCall = calls.find((c) => c.url.includes("/v2/bookings"));
    assert.equal(bookingCall, undefined, "should not call Cal.com at all");
    const claimCall = calls.find(
      (c) => c.url.includes("/rest/v1/appointments") && c.method === "POST",
    );
    assert.equal(claimCall, undefined, "should not claim a slot either");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reports the Cal.com error, and frees the claimed slot instead of leaving it stuck", async () => {
  const { fn, calls } = mockFetch({
    contactEmail: "cliente@example.com",
    calcomStatus: 400,
    calcomBody: { message: "no_available_users_found_error" },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await scheduleCalComTool.run(
      {
        event_type_id: 1,
        datetime_iso: "2026-06-12T15:00:00Z",
        attendee_name: "Juan Pérez",
      },
      ctx,
    );

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Cal\.com API error: 400/);

    const deleteCall = calls.find(
      (c) => c.url.includes("/rest/v1/appointments") && c.method === "DELETE",
    );
    assert.ok(
      deleteCall,
      "should free the claimed slot when Cal.com rejects the booking",
    );

    const updateCall = calls.find(
      (c) => c.url.includes("/rest/v1/appointments") && c.method === "PATCH",
    );
    assert.equal(
      updateCall,
      undefined,
      "should not try to fill in a uid for a booking that never happened",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fails closed instead of throwing when the event-types lookup itself fails", async () => {
  const fn = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url.includes("/rest/v1/integrations")) {
      return jsonResponse(200, [
        {
          credentials: { calcom_api_key: "cal_test_123" },
          config: { timezone: "America/Santiago" },
          enabled: true,
        },
      ]);
    }
    if (url.includes("api.cal.com/v2/event-types")) {
      throw new TypeError("network error");
    }
    throw new Error(`unexpected fetch call: ${method} ${url}`);
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await scheduleCalComTool.run(
      {
        event_type_id: 1,
        datetime_iso: "2026-06-12T15:00:00Z",
        attendee_name: "Juan Pérez",
      },
      ctx,
    );

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /event_type_id/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects an event_type_id that doesn't belong to this workspace's Cal.com account", async () => {
  const { fn, calls } = mockFetch({
    contactEmail: "cliente@example.com",
    calcomStatus: 201,
    knownEventTypeIds: [1, 2],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await scheduleCalComTool.run(
      {
        event_type_id: 999,
        datetime_iso: "2026-06-12T15:00:00Z",
        attendee_name: "Juan Pérez",
      },
      ctx,
    );

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /event_type_id/);

    const bookingCall = calls.find((c) => c.url.includes("/v2/bookings"));
    assert.equal(
      bookingCall,
      undefined,
      "should not call Cal.com's booking endpoint for an unverified event_type_id",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("books normally when event_type_id is a known event type", async () => {
  const { fn } = mockFetch({
    contactEmail: "cliente@example.com",
    calcomStatus: 201,
    calcomBody: { status: "success", data: { uid: "booking_uid_1" } },
    knownEventTypeIds: [1, 2],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await scheduleCalComTool.run(
      {
        event_type_id: 1,
        datetime_iso: "2026-06-12T15:00:00Z",
        attendee_name: "Juan Pérez",
      },
      ctx,
    );
    assert.equal(result.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects a recurring event type before ever calling Cal.com's booking endpoint", async () => {
  const { fn, calls } = mockFetch({
    contactEmail: "cliente@example.com",
    calcomStatus: 201,
    knownEventTypeIds: [1, 2],
    recurringEventTypeIds: [2],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await scheduleCalComTool.run(
      {
        event_type_id: 2,
        datetime_iso: "2026-06-12T15:00:00Z",
        attendee_name: "Juan Pérez",
      },
      ctx,
    );

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /recurrente/);

    const bookingCall = calls.find((c) => c.url.includes("/v2/bookings"));
    assert.equal(
      bookingCall,
      undefined,
      "must not attempt to book a recurring event type — this system can't represent a series",
    );
    const claimCall = calls.find(
      (c) => c.url.includes("/rest/v1/appointments") && c.method === "POST",
    );
    assert.equal(
      claimCall,
      undefined,
      "must not claim a slot for an event type it's about to reject",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fails clearly instead of misreporting success when Cal.com unexpectedly returns a recurring-series array", async () => {
  const { fn, calls } = mockFetch({
    contactEmail: "cliente@example.com",
    calcomStatus: 201,
    calcomBody: {
      status: "success",
      data: [{ uid: "rec_1" }, { uid: "rec_2" }],
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await scheduleCalComTool.run(
      {
        event_type_id: 1,
        datetime_iso: "2026-06-12T15:00:00Z",
        attendee_name: "Juan Pérez",
      },
      ctx,
    );

    assert.equal(
      result.ok,
      false,
      "must not report success when it can't link the resulting booking(s)",
    );

    const claimCall = calls.find(
      (c) => c.url.includes("/rest/v1/appointments") && c.method === "POST",
    );
    assert.ok(claimCall, "the slot was claimed before the booking call");

    const deleteCall = calls.find(
      (c) => c.url.includes("/rest/v1/appointments") && c.method === "DELETE",
    );
    assert.equal(
      deleteCall,
      undefined,
      "must NOT free the slot — Cal.com actually created a real series there, a retry must not create another one",
    );

    const updateCall = calls.find(
      (c) => c.url.includes("/rest/v1/appointments") && c.method === "PATCH",
    );
    assert.equal(
      updateCall,
      undefined,
      "can't link an array of uids to the single-uid column",
    );

    const eventCall = calls.find(
      (c) => c.url.includes("/rest/v1/events") && c.method === "POST",
    );
    assert.ok(eventCall, "expected a visible error event logging this case");
    const body = eventCall!.body as {
      type: string;
      level: string;
      payload: Record<string, unknown>;
    };
    assert.equal(body.type, "appointment_persist_failed");
    assert.equal(body.level, "error");
    assert.deepEqual(body.payload.booking_uids, ["rec_1", "rec_2"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("logs a visible error event when Cal.com's booking response omits the uid", async () => {
  const { fn, calls } = mockFetch({
    contactEmail: "cliente@example.com",
    calcomStatus: 201,
    calcomBody: { status: "success", data: {} },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await scheduleCalComTool.run(
      {
        event_type_id: 1,
        datetime_iso: "2026-06-12T15:00:00Z",
        attendee_name: "Juan Pérez",
      },
      ctx,
    );
    assert.equal(
      result.ok,
      true,
      "still reports success — the Cal.com booking did succeed",
    );

    const eventCall = calls.find(
      (c) => c.url.includes("/rest/v1/events") && c.method === "POST",
    );
    assert.ok(
      eventCall,
      "expected an events row logging the booking with no linkable uid",
    );
    const body = eventCall!.body as {
      type: string;
      level: string;
      payload: Record<string, unknown>;
    };
    assert.equal(body.type, "appointment_persist_failed");
    assert.equal(body.level, "error");
    assert.equal(body.payload.provider, "calcom");

    const updateCall = calls.find(
      (c) => c.url.includes("/rest/v1/appointments") && c.method === "PATCH",
    );
    assert.equal(
      updateCall,
      undefined,
      "nothing to fill in when there's no uid to persist",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not create a duplicate booking when a retry re-runs the same tool call (contact present)", async () => {
  const { fn, calls } = mockFetch({
    contactEmail: "cliente@example.com",
    calcomStatus: 201,
    claimConflict: true,
    conflictExisting: {
      calcom_booking_uid: "booking_uid_existing",
      calcom_event_type_id: 1,
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await scheduleCalComTool.run(
      {
        event_type_id: 1,
        datetime_iso: "2026-06-12T15:00:00Z",
        attendee_name: "Juan Pérez",
      },
      ctx,
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.output, {
      booking_uid: "booking_uid_existing",
      datetime: "2026-06-12T15:00:00Z",
    });

    const bookingCall = calls.find((c) => c.url.includes("/v2/bookings"));
    assert.equal(
      bookingCall,
      undefined,
      "must not call Cal.com again when an identical booking already exists locally",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not create a duplicate booking in the playground (no contactId) when a retry re-runs the same tool call", async () => {
  const { fn, calls } = mockFetch({
    contactEmail: null,
    calcomStatus: 201,
    claimConflict: true,
    conflictExisting: {
      calcom_booking_uid: "booking_uid_existing",
      calcom_event_type_id: 1,
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await scheduleCalComTool.run(
      {
        event_type_id: 1,
        datetime_iso: "2026-06-12T15:00:00Z",
        attendee_name: "Juan Pérez",
        attendee_email: "cliente@example.com",
      },
      playgroundCtx,
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.output, {
      booking_uid: "booking_uid_existing",
      datetime: "2026-06-12T15:00:00Z",
    });

    const bookingCall = calls.find((c) => c.url.includes("/v2/bookings"));
    assert.equal(
      bookingCall,
      undefined,
      "must not call Cal.com again in the playground either",
    );

    const lookupCall = calls.find(
      (c) => c.url.includes("/rest/v1/appointments") && c.method === "GET",
    );
    assert.ok(lookupCall);
    assert.match(
      lookupCall!.url,
      /contact_id=is\.null/,
      "with no contactId, the conflict lookup must match other contactId-less claims, not skip it",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refuses to report success for a different service booked at the identical slot", async () => {
  const { fn, calls } = mockFetch({
    contactEmail: "cliente@example.com",
    calcomStatus: 201,
    knownEventTypeIds: [1, 2],
    claimConflict: true,
    conflictExisting: {
      calcom_booking_uid: "booking_uid_service_A",
      calcom_event_type_id: 1,
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await scheduleCalComTool.run(
      {
        event_type_id: 2,
        datetime_iso: "2026-06-12T15:00:00Z",
        attendee_name: "Juan Pérez",
      },
      ctx,
    );

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /servicio distinto/);

    const bookingCall = calls.find((c) => c.url.includes("/v2/bookings"));
    assert.equal(bookingCall, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reports a clear conflict (not a silent duplicate) when another request's claim is still in flight", async () => {
  const { fn, calls } = mockFetch({
    contactEmail: "cliente@example.com",
    calcomStatus: 201,
    claimConflict: true,
    conflictExisting: null,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await scheduleCalComTool.run(
      {
        event_type_id: 1,
        datetime_iso: "2026-06-12T15:00:00Z",
        attendee_name: "Juan Pérez",
      },
      ctx,
    );

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /procesando/);

    const bookingCall = calls.find((c) => c.url.includes("/v2/bookings"));
    assert.equal(bookingCall, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("retries claiming the slot on a transient DB error, not on a real conflict", async () => {
  const { fn, calls } = mockFetch({
    contactEmail: "cliente@example.com",
    calcomStatus: 201,
    calcomBody: { status: "success", data: { uid: "booking_uid_1" } },
    claimInsertAttemptsUntilOk: 2,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await scheduleCalComTool.run(
      {
        event_type_id: 1,
        datetime_iso: "2026-06-12T15:00:00Z",
        attendee_name: "Juan Pérez",
      },
      ctx,
    );

    assert.equal(result.ok, true);
    const claimAttempts = calls.filter(
      (c) => c.url.includes("/rest/v1/appointments") && c.method === "POST",
    );
    assert.equal(
      claimAttempts.length,
      2,
      "should retry the claim after a transient (non-conflict) failure",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("retries filling in the booking uid (not the Cal.com booking) when the update fails transiently", async () => {
  const { fn, calls } = mockFetch({
    contactEmail: "cliente@example.com",
    calcomStatus: 201,
    calcomBody: { status: "success", data: { uid: "booking_uid_1" } },
    updateAttemptsUntilOk: 2,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await scheduleCalComTool.run(
      {
        event_type_id: 1,
        datetime_iso: "2026-06-12T15:00:00Z",
        attendee_name: "Juan Pérez",
      },
      ctx,
    );

    assert.equal(result.ok, true);
    const bookingCalls = calls.filter((c) => c.url.includes("/v2/bookings"));
    assert.equal(
      bookingCalls.length,
      1,
      "the Cal.com booking itself must only ever be attempted once",
    );
    const updateAttempts = calls.filter(
      (c) => c.url.includes("/rest/v1/appointments") && c.method === "PATCH",
    );
    assert.equal(
      updateAttempts.length,
      2,
      "should retry filling in the uid after a transient failure",
    );

    const eventCall = calls.find(
      (c) => c.url.includes("/rest/v1/events") && c.method === "POST",
    );
    assert.equal(
      eventCall,
      undefined,
      "no persist-failure event should be logged once the retry succeeds",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("still returns ok: true when the uid update and the events insert both fail", async () => {
  const { fn } = mockFetch({
    contactEmail: "cliente@example.com",
    calcomStatus: 201,
    calcomBody: { status: "success", data: { uid: "booking_uid_1" } },
    updateStatus: 500,
    eventsInsertStatus: 500,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await scheduleCalComTool.run(
      {
        event_type_id: 1,
        datetime_iso: "2026-06-12T15:00:00Z",
        attendee_name: "Juan Pérez",
      },
      ctx,
    );
    assert.equal(
      result.ok,
      true,
      "still reports success — the Cal.com booking did succeed, even though persisting the uid failed",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
