import assert from "node:assert/strict";
import { test } from "node:test";
import { cancelCalComTool } from "./cancel-calcom.ts";
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
  headers: Record<string, string>;
}

function mockFetch(opts: {
  activeAppointment: { id: string; calcom_booking_uid: string | null } | { id: string; calcom_booking_uid: string | null }[] | null;
  calcomStatus: number;
  calcomBody?: unknown;
  appointmentUpdateStatus?: number;
  eventsInsertStatus?: number;
}) {
  const calls: FetchCall[] = [];

  const fn = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = (init?.headers as Record<string, string>) ?? {};
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers,
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

    if (url.includes("/rest/v1/appointments") && method === "GET") {
      if (!opts.activeAppointment) {
        return jsonResponse(200, []);
      }
      const appointments = Array.isArray(opts.activeAppointment)
        ? opts.activeAppointment
        : [opts.activeAppointment];
      return jsonResponse(200, appointments);
    }

    if (url.includes("/rest/v1/appointments") && method === "PATCH") {
      return new Response(null, {
        status: opts.appointmentUpdateStatus ?? 204,
      });
    }

    if (url.includes("api.cal.com/v2/bookings/") && url.includes("/cancel")) {
      return jsonResponse(opts.calcomStatus, opts.calcomBody ?? {});
    }

    if (url.includes("/rest/v1/events") && method === "POST") {
      return jsonResponse(opts.eventsInsertStatus ?? 201, {});
    }

    throw new Error(`unexpected fetch call: ${method} ${url}`);
  };

  return { fn, calls };
}

test("cancels the active appointment when Cal.com confirms", async () => {
  const { fn, calls } = mockFetch({
    activeAppointment: { id: "appt_local_1", calcom_booking_uid: "cal_evt_1" },
    calcomStatus: 200,
    calcomBody: { status: "success", data: { uid: "cal_evt_1" } },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await cancelCalComTool.run({}, ctx);

    assert.equal(result.ok, true);
    assert.deepEqual(result.output, { cancelled: true });

    const calcomCall = calls.find((c) => c.url.includes("cal_evt_1/cancel"));
    assert.ok(calcomCall, "expected a call to the Cal.com cancel endpoint");
    assert.equal(calcomCall!.method, "POST");
    assert.equal(calcomCall!.headers["cal-api-version"], "2026-02-25");

    const updateCall = calls.find(
      (c) => c.url.includes("/rest/v1/appointments") && c.method === "PATCH",
    );
    assert.ok(
      updateCall,
      "expected the local appointment to be marked cancelled",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fails clearly when there is no active appointment to cancel", async () => {
  const { fn, calls } = mockFetch({
    activeAppointment: null,
    calcomStatus: 200,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await cancelCalComTool.run({}, ctx);

    assert.equal(result.ok, false);
    assert.equal(result.error, "No encontré una cita activa para cancelar");

    const calcomCall = calls.find((c) => c.url.includes("api.cal.com"));
    assert.equal(calcomCall, undefined, "should not call Cal.com at all");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reports the Cal.com error and does not mark the appointment cancelled locally", async () => {
  const { fn, calls } = mockFetch({
    activeAppointment: { id: "appt_local_1", calcom_booking_uid: "cal_evt_1" },
    calcomStatus: 400,
    calcomBody: { message: "Booking already cancelled" },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await cancelCalComTool.run({}, ctx);

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Cal\.com API error: 400/);

    const updateCall = calls.find(
      (c) => c.url.includes("/rest/v1/appointments") && c.method === "PATCH",
    );
    assert.equal(
      updateCall,
      undefined,
      "should not mark the appointment cancelled when Cal.com rejected it",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("logs a visible error event when the local cancelled-status update fails", async () => {
  const { fn, calls } = mockFetch({
    activeAppointment: { id: "appt_local_1", calcom_booking_uid: "cal_evt_1" },
    calcomStatus: 200,
    calcomBody: { status: "success", data: { uid: "cal_evt_1" } },
    appointmentUpdateStatus: 500,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await cancelCalComTool.run({}, ctx);
    assert.equal(result.ok, true, "the Cal.com cancellation did succeed");

    const eventCall = calls.find(
      (c) => c.url.includes("/rest/v1/events") && c.method === "POST",
    );
    assert.ok(eventCall, "expected an events row logging the failed local update");
    const body = eventCall!.body as { type: string; level: string };
    assert.equal(body.type, "appointment_update_failed");
    assert.equal(body.level, "error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("skips a HighLevel appointment with no calcom_booking_uid and finds the Cal.com one", async () => {
  const { fn, calls } = mockFetch({
    activeAppointment: { id: "appt_calcom_1", calcom_booking_uid: "cal_evt_2" },
    calcomStatus: 200,
    calcomBody: { status: "success", data: { uid: "cal_evt_2" } },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await cancelCalComTool.run({}, ctx);
    assert.equal(result.ok, true);

    const listCall = calls.find(
      (c) => c.url.includes("/rest/v1/appointments") && c.method === "GET",
    );
    assert.ok(listCall, "expected a GET to /rest/v1/appointments");
    assert.match(
      listCall!.url,
      /calcom_booking_uid=not\.is\.null/,
      "the appointments query must filter out rows with no calcom_booking_uid",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("filters out past appointments so a stale unclosed booking can't shadow a future one", async () => {
  const { fn, calls } = mockFetch({
    activeAppointment: { id: "appt_local_1", calcom_booking_uid: "cal_evt_1" },
    calcomStatus: 200,
    calcomBody: { status: "success", data: { uid: "cal_evt_1" } },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    await cancelCalComTool.run({}, ctx);

    const listCall = calls.find(
      (c) => c.url.includes("/rest/v1/appointments") && c.method === "GET",
    );
    assert.ok(listCall, "expected a GET to /rest/v1/appointments");
    assert.match(
      listCall!.url,
      /scheduled_at=gte\./,
      "the appointments query must only consider appointments at or after now",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fails clearly without querying when there is no contactId (playground)", async () => {
  const { fn, calls } = mockFetch({
    activeAppointment: { id: "appt_local_1", calcom_booking_uid: "cal_evt_1" },
    calcomStatus: 200,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;
  const playgroundCtx: ToolContext = {
    workspaceId: "ws_1",
    conversationId: null,
    contactId: null,
  };

  try {
    const result = await cancelCalComTool.run({}, playgroundCtx);
    assert.equal(result.ok, false);
    assert.equal(result.error, "No encontré una cita activa para cancelar");

    const listCall = calls.find((c) =>
      c.url.includes("/rest/v1/appointments"),
    );
    assert.equal(
      listCall,
      undefined,
      "should not attempt a query with no contactId to filter by",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("still returns ok: true when both the local update and the events insert fail", async () => {
  const { fn } = mockFetch({
    activeAppointment: { id: "appt_local_1", calcom_booking_uid: "cal_evt_1" },
    calcomStatus: 200,
    calcomBody: { status: "success", data: { uid: "cal_evt_1" } },
    appointmentUpdateStatus: 500,
    eventsInsertStatus: 500,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await cancelCalComTool.run({}, ctx);
    assert.equal(
      result.ok,
      true,
      "still reports success — the Cal.com cancellation did succeed, even though logging failed",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
