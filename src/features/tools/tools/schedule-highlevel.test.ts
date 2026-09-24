import assert from "node:assert/strict";
import { test } from "node:test";
import { scheduleHighLevelTool } from "./schedule-highlevel.ts";
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
}

function mockFetch(opts: {
  hlStatus: number;
  hlBody?: unknown;
  appointmentInsertStatus: number;
  appointmentInsertBody?: unknown;
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
    });

    // Supabase integrations table (get workspace HighLevel config)
    if (url.includes("/rest/v1/integrations")) {
      return jsonResponse(200, [
        {
          credentials: { highlevel_pit: "tok_123" },
          config: { location_id: "loc_1", calendar_id: "cal_1" },
          enabled: true,
        },
      ]);
    }

    // Supabase contacts table (get contact phone for scheduling).
    // NOTE: .single() (unlike .maybeSingle()) does not unwrap a JSON array
    // client-side in postgrest-js — it just sets the
    // "Accept: application/vnd.pgrst.object+json" header and trusts a real
    // Postgrest server to already return a bare object. So this mock must
    // return the object directly, not wrapped in an array.
    if (url.includes("/rest/v1/contacts") && method === "GET") {
      return jsonResponse(200, {
        hl_contact_id: "hl_contact_1",
        phone: "+5215512345678",
        name: "Juan",
      });
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
      { datetime_iso: "2026-06-12T10:00:00-06:00" },
      ctx,
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.output, {
      appointment_id: "hl_evt_1",
      datetime: "2026-06-12T10:00:00-06:00",
    });

    const eventCall = calls.find(
      (c) => c.url.includes("/rest/v1/events") && c.method === "POST",
    );
    assert.equal(
      eventCall,
      undefined,
      "should not log a persist-failed event when the insert succeeds",
    );
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
      { datetime_iso: "2026-06-12T10:00:00-06:00" },
      ctx,
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /HL API error: 400/);
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
      { datetime_iso: "2026-06-12T10:00:00-06:00" },
      ctx,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.output, {
      appointment_id: "hl_evt_1",
      datetime: "2026-06-12T10:00:00-06:00",
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
      { datetime_iso: "2026-06-12T10:00:00-06:00" },
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
