import assert from "node:assert/strict";
import { test } from "node:test";
import { cancelHighLevelTool } from "./cancel-highlevel.ts";
import type { ToolContext } from "../core/tool";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

const ctx: ToolContext = {
  workspaceId: "ws_1",
  conversationId: "conv_1",
  contactId: "contact_1",
};

const FUTURE_STARTTIME_ISO = new Date(Date.now() + 3600_000).toISOString();
// HighLevel's real startTime format has no timezone offset (verified
// against the live v3 docs).
const FUTURE_STARTTIME = `${FUTURE_STARTTIME_ISO.slice(0, 10)} ${FUTURE_STARTTIME_ISO.slice(11, 19)}`;

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
  activeAppointment:
    | { id: string; hl_appointment_id: string | null }
    | { id: string; hl_appointment_id: string | null }[]
    | null;
  contactHlId?: string | null;
  hlContactAppointments?: Array<{
    id: string;
    status: string;
    startTime: string;
  }>;
  hlStatus: number;
  hlBody?: unknown;
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
          credentials: { highlevel_pit: "tok_123" },
          config: { location_id: "loc_1", calendar_id: null },
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
      return new Response(null, { status: 204 });
    }

    if (url.includes("/rest/v1/contacts") && method === "GET") {
      return jsonResponse(
        200,
        opts.contactHlId !== undefined
          ? [{ hl_contact_id: opts.contactHlId }]
          : [],
      );
    }

    if (
      url.includes("services.leadconnectorhq.com/contacts/") &&
      url.includes("/appointments") &&
      method === "GET"
    ) {
      return jsonResponse(200, { events: opts.hlContactAppointments ?? [] });
    }

    if (url.includes("services.leadconnectorhq.com/calendars/events/appointments/")) {
      return jsonResponse(opts.hlStatus, opts.hlBody ?? {});
    }

    if (url.includes("/rest/v1/business_info")) {
      return jsonResponse(200, [
        { structured: { timezone: "UTC" }, free_text: null },
      ]);
    }

    throw new Error(`unexpected fetch call: ${method} ${url}`);
  };

  return { fn, calls };
}

test("cancels the active appointment when HighLevel confirms", async () => {
  const { fn, calls } = mockFetch({
    activeAppointment: { id: "appt_local_1", hl_appointment_id: "hl_evt_1" },
    hlStatus: 200,
    hlBody: { id: "hl_evt_1", appointmentStatus: "cancelled" },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await cancelHighLevelTool.run({}, ctx);

    assert.equal(result.ok, true);
    assert.deepEqual(result.output, { cancelled: true });

    const hlCall = calls.find((c) => c.url.includes("hl_evt_1"));
    assert.ok(hlCall, "expected a call to the HighLevel cancel endpoint");
    assert.equal(hlCall!.method, "PUT");
    assert.equal(hlCall!.headers.Version, "v3");
    assert.deepEqual(hlCall!.body, { appointmentStatus: "cancelled" });

    const updateCall = calls.find(
      (c) => c.url.includes("/rest/v1/appointments") && c.method === "PATCH",
    );
    assert.ok(updateCall, "expected the local appointment to be marked cancelled");

    const fallbackLookup = calls.find((c) => c.url.includes("/contacts/") && c.url.includes("/appointments"));
    assert.equal(
      fallbackLookup,
      undefined,
      "should not query the HighLevel fallback when a local row already resolves the appointment",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("falls back to HighLevel directly when the local appointment row is missing", async () => {
  const { fn, calls } = mockFetch({
    activeAppointment: null,
    contactHlId: "hl_contact_1",
    hlContactAppointments: [
      { id: "hl_evt_9", status: "booked", startTime: FUTURE_STARTTIME },
    ],
    hlStatus: 200,
    hlBody: { id: "hl_evt_9", appointmentStatus: "cancelled" },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await cancelHighLevelTool.run({}, ctx);

    assert.equal(result.ok, true);
    assert.deepEqual(result.output, { cancelled: true });

    const hlCancelCall = calls.find((c) => c.url.includes("hl_evt_9"));
    assert.ok(hlCancelCall, "expected the fallback-resolved appointment to be cancelled");

    const contactLookupCall = calls.find((c) => c.url.includes("/rest/v1/contacts"));
    assert.ok(contactLookupCall, "expected a contacts lookup call");
    assert.match(
      contactLookupCall!.url,
      /workspace_id=eq\.ws_1/,
      "the contacts fallback lookup must filter by workspace_id, not just id",
    );

    const updateCall = calls.find(
      (c) => c.url.includes("/rest/v1/appointments") && c.method === "PATCH",
    );
    assert.equal(
      updateCall,
      undefined,
      "there was no local row to mark cancelled",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fails clearly when there is no active appointment locally or in HighLevel", async () => {
  const { fn, calls } = mockFetch({
    activeAppointment: null,
    contactHlId: "hl_contact_1",
    hlContactAppointments: [],
    hlStatus: 200,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await cancelHighLevelTool.run({}, ctx);

    assert.equal(result.ok, false);
    assert.equal(result.error, "No encontré una cita activa para cancelar");

    const cancelCall = calls.find((c) =>
      c.url.includes("/calendars/events/appointments/"),
    );
    assert.equal(cancelCall, undefined, "should not call the cancel endpoint");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reports the HighLevel error and does not mark the appointment cancelled locally", async () => {
  const { fn, calls } = mockFetch({
    activeAppointment: { id: "appt_local_1", hl_appointment_id: "hl_evt_1" },
    hlStatus: 400,
    hlBody: { message: "Bad Request" },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await cancelHighLevelTool.run({}, ctx);

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /HL API error: 400/);

    const updateCall = calls.find(
      (c) => c.url.includes("/rest/v1/appointments") && c.method === "PATCH",
    );
    assert.equal(
      updateCall,
      undefined,
      "should not mark the appointment cancelled when HighLevel rejected it",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("skips an appointment row with no hl_appointment_id and finds the HighLevel one", async () => {
  const { fn, calls } = mockFetch({
    activeAppointment: { id: "appt_hl_1", hl_appointment_id: "hl_evt_2" },
    hlStatus: 200,
    hlBody: { id: "hl_evt_2", appointmentStatus: "cancelled" },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await cancelHighLevelTool.run({}, ctx);
    assert.equal(result.ok, true);

    const listCall = calls.find(
      (c) => c.url.includes("/rest/v1/appointments") && c.method === "GET",
    );
    assert.ok(listCall, "expected a GET to /rest/v1/appointments");
    assert.match(
      listCall!.url,
      /hl_appointment_id=not\.is\.null/,
      "the appointments query must filter out rows with no hl_appointment_id",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fails clearly without querying when there is no contactId (playground)", async () => {
  const { fn, calls } = mockFetch({
    activeAppointment: { id: "appt_local_1", hl_appointment_id: "hl_evt_1" },
    hlStatus: 200,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;
  const playgroundCtx: ToolContext = {
    workspaceId: "ws_1",
    conversationId: null,
    contactId: null,
  };

  try {
    const result = await cancelHighLevelTool.run({}, playgroundCtx);
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

test("filters out past appointments so a stale unclosed booking can't shadow a future one", async () => {
  const { fn, calls } = mockFetch({
    activeAppointment: { id: "appt_local_1", hl_appointment_id: "hl_evt_1" },
    hlStatus: 200,
    hlBody: { id: "hl_evt_1", appointmentStatus: "cancelled" },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    await cancelHighLevelTool.run({}, ctx);

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
