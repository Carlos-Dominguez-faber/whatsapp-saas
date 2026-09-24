import assert from "node:assert/strict";
import { test } from "node:test";
import { listEventTypesCalComTool } from "./list-event-types-calcom.ts";
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
  headers: Record<string, string>;
}

function mockFetch(opts: {
  connected: boolean;
  calcomStatus: number;
  calcomBody?: unknown;
}) {
  const calls: FetchCall[] = [];

  const fn = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const headers = (init?.headers as Record<string, string>) ?? {};
    calls.push({ url, headers });

    if (url.includes("/rest/v1/integrations")) {
      return jsonResponse(
        200,
        opts.connected
          ? [
              {
                credentials: { calcom_api_key: "cal_test_123" },
                config: { timezone: "America/Santiago" },
                enabled: true,
              },
            ]
          : [],
      );
    }

    if (url.includes("api.cal.com/v2/event-types")) {
      return jsonResponse(opts.calcomStatus, opts.calcomBody ?? {});
    }

    throw new Error(`unexpected fetch call: ${url}`);
  };

  return { fn, calls };
}

test("lists event types when Cal.com is connected", async () => {
  const { fn, calls } = mockFetch({
    connected: true,
    calcomStatus: 200,
    calcomBody: {
      status: "success",
      data: [
        { id: 1, title: "Consulta", lengthInMinutes: 30 },
        { id: 2, title: "Corte de pelo", lengthInMinutes: 45 },
      ],
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await listEventTypesCalComTool.run({}, ctx);

    assert.equal(result.ok, true);
    assert.deepEqual(result.output, {
      event_types: [
        { id: 1, title: "Consulta", duration_minutes: 30, recurring: false },
        { id: 2, title: "Corte de pelo", duration_minutes: 45, recurring: false },
      ],
      count: 2,
    });

    const call = calls.find((c) => c.url.includes("event-types"));
    assert.ok(call, "expected a call to the Cal.com event-types endpoint");
    assert.equal(call!.headers["cal-api-version"], "2024-06-14");
    assert.equal(call!.headers.Authorization, "Bearer cal_test_123");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fails clearly when Cal.com is not connected", async () => {
  const { fn } = mockFetch({ connected: false, calcomStatus: 200 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await listEventTypesCalComTool.run({}, ctx);
    assert.equal(result.ok, false);
    assert.equal(
      result.error,
      "Cal.com no está conectado para este workspace",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reports the Cal.com error", async () => {
  const { fn } = mockFetch({
    connected: true,
    calcomStatus: 401,
    calcomBody: { message: "Invalid API key" },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await listEventTypesCalComTool.run({}, ctx);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Cal\.com API error: 401/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("flags a recurring event type as not bookable via WhatsApp", async () => {
  const { fn } = mockFetch({
    connected: true,
    calcomStatus: 200,
    calcomBody: {
      status: "success",
      data: [
        {
          id: 3,
          title: "Terapia semanal",
          lengthInMinutes: 60,
          recurrence: { interval: 1, occurrences: 8, frequency: "weekly", disabled: false },
        },
      ],
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await listEventTypesCalComTool.run({}, ctx);
    assert.equal(result.ok, true);
    assert.deepEqual(result.output, {
      event_types: [
        { id: 3, title: "Terapia semanal", duration_minutes: 60, recurring: true },
      ],
      count: 1,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("redacts the workspace's own API key out of the upstream error text", async () => {
  const { fn } = mockFetch({
    connected: true,
    calcomStatus: 401,
    calcomBody: { message: "Invalid credentials for key cal_test_123" },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await listEventTypesCalComTool.run({}, ctx);
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error ?? "", /cal_test_123/);
    assert.match(result.error ?? "", /\[REDACTED\]/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
