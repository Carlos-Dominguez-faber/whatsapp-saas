import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAvailabilityCalComTool } from "./check-availability-calcom.ts";
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
  knownEventTypeIds?: number[];
  timezone?: string;
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
                config: { timezone: opts.timezone ?? "America/Santiago" },
                enabled: true,
              },
            ]
          : [],
      );
    }

    if (url.includes("api.cal.com/v2/event-types")) {
      return jsonResponse(200, {
        status: "success",
        data: (opts.knownEventTypeIds ?? [1]).map((id) => ({ id })),
      });
    }

    if (url.includes("api.cal.com/v2/slots")) {
      return jsonResponse(opts.calcomStatus, opts.calcomBody ?? {});
    }

    throw new Error(`unexpected fetch call: ${url}`);
  };

  return { fn, calls };
}

test("returns available slots for a date range", async () => {
  const { fn, calls } = mockFetch({
    connected: true,
    calcomStatus: 200,
    calcomBody: {
      status: "success",
      data: {
        "2026-06-12": ["2026-06-12T15:00:00Z", "2026-06-12T16:00:00Z"],
        "2026-06-13": ["2026-06-13T15:00:00Z"],
      },
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await checkAvailabilityCalComTool.run(
      { event_type_id: 1, date_from: "2026-06-12", date_to: "2026-06-13" },
      ctx,
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.output, {
      days: {
        "2026-06-12": ["2026-06-12T15:00:00Z", "2026-06-12T16:00:00Z"],
        "2026-06-13": ["2026-06-13T15:00:00Z"],
      },
      count: 3,
      timezone: "America/Santiago",
      covered_until: "2026-06-13",
      omitted_days: 0,
      unreadable: 0,
      message: "Hay 3 horarios disponibles. Cada uno es el instante exacto en ISO: cópialo tal cual para agendar.",
    });

    const call = calls.find((c) => c.url.includes("/v2/slots"));
    assert.ok(call, "expected a call to the Cal.com slots endpoint");
    assert.match(call!.url, /eventTypeId=1/);
    assert.match(call!.url, /timeZone=America%2FSantiago/);
    assert.equal(call!.headers["cal-api-version"], "2024-09-04");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reports no slots without treating it as an error", async () => {
  const { fn } = mockFetch({
    connected: true,
    calcomStatus: 200,
    calcomBody: { status: "success", data: {} },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await checkAvailabilityCalComTool.run(
      { event_type_id: 1, date_from: "2026-06-12", date_to: "2026-06-13" },
      ctx,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.output, {
      days: {},
      count: 0,
      timezone: "America/Santiago",
      covered_until: null,
      omitted_days: 0,
      unreadable: 0,
      message: "No hay horarios disponibles en ese rango.",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects invalid dates before calling Cal.com", async () => {
  const { fn, calls } = mockFetch({ connected: true, calcomStatus: 200 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await checkAvailabilityCalComTool.run(
      { event_type_id: 1, date_from: "not-a-date", date_to: "2026-06-13" },
      ctx,
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, "Fechas inválidas");
    const slotsCall = calls.find((c) => c.url.includes("/v2/slots"));
    assert.equal(slotsCall, undefined, "should not call Cal.com at all");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fails clearly when Cal.com is not connected", async () => {
  const { fn } = mockFetch({ connected: false, calcomStatus: 200 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await checkAvailabilityCalComTool.run(
      { event_type_id: 1, date_from: "2026-06-12", date_to: "2026-06-13" },
      ctx,
    );
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
    const result = await checkAvailabilityCalComTool.run(
      { event_type_id: 1, date_from: "2026-06-12", date_to: "2026-06-13" },
      ctx,
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Cal\.com API error: 401/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects an event_type_id that doesn't belong to this workspace's Cal.com account", async () => {
  const { fn, calls } = mockFetch({
    connected: true,
    calcomStatus: 200,
    knownEventTypeIds: [1, 2],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await checkAvailabilityCalComTool.run(
      { event_type_id: 999, date_from: "2026-06-12", date_to: "2026-06-13" },
      ctx,
    );

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /event_type_id/);

    const slotsCall = calls.find((c) => c.url.includes("/v2/slots"));
    assert.equal(
      slotsCall,
      undefined,
      "should not call Cal.com's slots endpoint for an unverified event_type_id",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("checks availability normally when event_type_id is a known event type", async () => {
  const { fn } = mockFetch({
    connected: true,
    calcomStatus: 200,
    calcomBody: {
      status: "success",
      data: {
        "2026-06-12": ["2026-06-12T15:00:00Z"],
      },
    },
    knownEventTypeIds: [1, 2],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await checkAvailabilityCalComTool.run(
      { event_type_id: 1, date_from: "2026-06-12", date_to: "2026-06-13" },
      ctx,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.output, {
      days: { "2026-06-12": ["2026-06-12T15:00:00Z"] },
      count: 1,
      timezone: "America/Santiago",
      covered_until: "2026-06-12",
      omitted_days: 0,
      unreadable: 0,
      message: "Hay 1 horarios disponibles. Cada uno es el instante exacto en ISO: cópialo tal cual para agendar.",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("acepta el formato real de Cal.com v2: objetos { start }", async () => {
  // El tipo que declaraba el repo decía `string[]` y era falso: la API v2
  // devuelve `{ start }`. Con el tipo viejo estos slots caían como ilegibles y
  // la tool respondía "no hay horarios disponibles".
  const { fn } = mockFetch({
    connected: true,
    calcomStatus: 200,
    calcomBody: {
      status: "success",
      data: {
        "2026-06-12": [
          { start: "2026-06-12T15:00:00Z" },
          { start: "2026-06-12T16:00:00Z" },
        ],
      },
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await checkAvailabilityCalComTool.run(
      { event_type_id: 1, date_from: "2026-06-12", date_to: "2026-06-13" },
      ctx,
    );

    assert.equal(result.ok, true);
    const out = result.output as Record<string, unknown>;
    assert.equal(out.unreadable, 0);
    assert.deepEqual(out.days, {
      "2026-06-12": ["2026-06-12T15:00:00Z", "2026-06-12T16:00:00Z"],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("un slot ilegible no se convierte en 'no hay horarios'", async () => {
  const { fn } = mockFetch({
    connected: true,
    calcomStatus: 200,
    calcomBody: {
      status: "success",
      data: { "2026-06-12": [{ startTime: "2026-06-12T15:00:00Z" }] },
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await checkAvailabilityCalComTool.run(
      { event_type_id: 1, date_from: "2026-06-12", date_to: "2026-06-13" },
      ctx,
    );

    assert.equal(result.ok, true);
    const out = result.output as Record<string, unknown>;
    assert.equal(out.count, 0);
    assert.equal(out.unreadable, 1);
    assert.doesNotMatch(out.message as string, /No hay horarios disponibles/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("con más días que el tope declara hasta qué fecha se sabe", async () => {
  const data: Record<string, string[]> = {};
  for (let i = 0; i < 20; i++) {
    const day = new Date(Date.UTC(2026, 5, 1) + i * 86_400_000)
      .toISOString()
      .slice(0, 10);
    // 15:00Z es el mismo día en Santiago (UTC-4), sin cruce de medianoche.
    data[day] = [`${day}T15:00:00Z`];
  }
  const { fn } = mockFetch({
    connected: true,
    calcomStatus: 200,
    calcomBody: { status: "success", data },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await checkAvailabilityCalComTool.run(
      { event_type_id: 1, date_from: "2026-06-01", date_to: "2026-06-20" },
      ctx,
    );

    assert.equal(result.ok, true);
    const out = result.output as Record<string, unknown>;
    assert.equal(out.omitted_days, 6);
    assert.equal(out.covered_until, "2026-06-14");
    assert.match(out.message as string, /2026-06-14/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("una zona horaria inválida del workspace no se le manda a Cal.com", async () => {
  // Si `integrations.config.timezone` trae basura, agrupar por UTC y pedirle a
  // Cal.com la zona basura son dos verdades distintas: el output declararía una
  // zona y la API habría respondido en otra.
  const { fn, calls } = mockFetch({
    connected: true,
    calcomStatus: 200,
    timezone: "Chile",
    calcomBody: {
      status: "success",
      data: { "2026-06-12": ["2026-06-12T15:00:00Z"] },
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await checkAvailabilityCalComTool.run(
      { event_type_id: 1, date_from: "2026-06-12", date_to: "2026-06-13" },
      ctx,
    );

    assert.equal(result.ok, true);
    assert.equal((result.output as Record<string, unknown>).timezone, "UTC");

    const call = calls.find((c) => c.url.includes("/v2/slots"));
    assert.ok(call);
    assert.match(call!.url, /timeZone=UTC(&|$)/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("una respuesta de Cal.com que no se entiende no es 'no hay horarios'", async () => {
  const { fn } = mockFetch({
    connected: true,
    calcomStatus: 200,
    calcomBody: { status: "error", error: { message: "boom" } },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await checkAvailabilityCalComTool.run(
      { event_type_id: 1, date_from: "2026-06-12", date_to: "2026-06-13" },
      ctx,
    );

    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error ?? "", /No hay horarios/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("un día con más de 20 horarios los devuelve todos", async () => {
  const slots = Array.from(
    { length: 48 },
    (_, i) =>
      `2026-06-12T${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}:00-04:00`,
  );
  const { fn } = mockFetch({
    connected: true,
    calcomStatus: 200,
    calcomBody: { status: "success", data: { "2026-06-12": slots } },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await checkAvailabilityCalComTool.run(
      { event_type_id: 1, date_from: "2026-06-12", date_to: "2026-06-12" },
      ctx,
    );

    assert.equal(result.ok, true);
    assert.equal((result.output as Record<string, unknown>).count, 48);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("el guard de status rechaza aunque el cuerpo traiga data válida", async () => {
  // Aísla el guard: con `data` presente, el único motivo para rechazar es
  // `status`. Sin esta separación, quitar la comprobación dejaba la suite verde.
  const { fn } = mockFetch({
    connected: true,
    calcomStatus: 200,
    calcomBody: {
      status: "error",
      data: { "2026-06-12": ["2026-06-12T15:00:00Z"] },
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;

  try {
    const result = await checkAvailabilityCalComTool.run(
      { event_type_id: 1, date_from: "2026-06-12", date_to: "2026-06-13" },
      ctx,
    );

    assert.equal(result.ok, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
