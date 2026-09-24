import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAvailabilityTool } from "./check-availability.ts";
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

function mockFetch(opts: {
  connected?: boolean;
  timezone?: string;
  hlStatus?: number;
  hlBody?: unknown;
}) {
  const calls: string[] = [];

  const fn = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    calls.push(url);

    if (url.includes("/rest/v1/integrations")) {
      return jsonResponse(
        200,
        opts.connected === false
          ? []
          : [
              {
                credentials: { highlevel_pit: "pit_test" },
                config: {
                  location_id: "loc_1",
                  calendar_id: "cal_1",
                  timezone: opts.timezone ?? "America/Santiago",
                },
                enabled: true,
              },
            ],
      );
    }

    if (url.includes("/free-slots")) {
      return jsonResponse(opts.hlStatus ?? 200, opts.hlBody ?? {});
    }

    throw new Error(`unexpected fetch call: ${url}`);
  };

  return { fn, calls };
}

async function withFetch<T>(
  fn: typeof fetch,
  body: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

/** Días consecutivos desde `start` (YYYY-MM-DD), un slot a las 15:00Z cada uno. */
function daysWithOneSlot(start: string, n: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const base = Date.parse(`${start}T00:00:00Z`);
  for (let i = 0; i < n; i++) {
    const day = new Date(base + i * 86_400_000).toISOString().slice(0, 10);
    out[day] = { slots: [`${day}T15:00:00Z`] };
  }
  return out;
}

test("devuelve los ISO originales agrupados por día local", async () => {
  const { fn } = mockFetch({
    hlBody: {
      "2026-06-12": {
        slots: ["2026-06-12T15:00:00-04:00", "2026-06-12T16:00:00-04:00"],
      },
      traceId: "abc",
    },
  });

  const result = await withFetch(fn as typeof fetch, () =>
    checkAvailabilityTool.run(
      { date_from: "2026-06-12", date_to: "2026-06-12" },
      ctx,
    ),
  );

  assert.equal(result.ok, true);
  const out = result.output as Record<string, unknown>;
  assert.deepEqual(out.days, {
    "2026-06-12": ["2026-06-12T15:00:00-04:00", "2026-06-12T16:00:00-04:00"],
  });
  assert.equal(out.count, 2);
  assert.equal(out.timezone, "America/Santiago");
  assert.equal(out.covered_until, "2026-06-12");
  assert.equal(out.omitted_days, 0);
  assert.equal(out.unreadable, 0);
});

test("una zona horaria inválida del LLM cae a la del workspace y lo declara", async () => {
  const { fn, calls } = mockFetch({
    hlBody: { "2026-06-12": { slots: ["2026-06-12T15:00:00-04:00"] } },
  });

  const result = await withFetch(fn as typeof fetch, () =>
    checkAvailabilityTool.run(
      {
        date_from: "2026-06-12",
        date_to: "2026-06-12",
        timezone: "America/Santiagoo",
      },
      ctx,
    ),
  );

  assert.equal(result.ok, true);
  const out = result.output as Record<string, unknown>;
  assert.equal(out.timezone, "America/Santiago");
  assert.match(out.message as string, /America\/Santiagoo/);

  // La zona que se le manda a HighLevel también tiene que ser la resuelta.
  const slotsCall = calls.find((u) => u.includes("/free-slots"));
  assert.ok(slotsCall);
  assert.match(slotsCall!, /timezone=America%2FSantiago(&|$)/);
});

test("horarios ilegibles no se convierten en 'no hay disponibilidad'", async () => {
  const { fn } = mockFetch({
    hlBody: { "2026-06-12": { slots: ["mañana", "2026-06-12T15:00:00"] } },
  });

  const result = await withFetch(fn as typeof fetch, () =>
    checkAvailabilityTool.run(
      { date_from: "2026-06-12", date_to: "2026-06-12" },
      ctx,
    ),
  );

  assert.equal(result.ok, true);
  const out = result.output as Record<string, unknown>;
  assert.equal(out.count, 0);
  assert.equal(out.unreadable, 2);
  assert.doesNotMatch(out.message as string, /No hay horarios disponibles/);
});

test("con más días que el tope declara hasta qué fecha se sabe", async () => {
  const { fn } = mockFetch({
    timezone: "UTC",
    hlBody: daysWithOneSlot("2026-06-01", 20),
  });

  const result = await withFetch(fn as typeof fetch, () =>
    checkAvailabilityTool.run(
      { date_from: "2026-06-01", date_to: "2026-06-20" },
      ctx,
    ),
  );

  assert.equal(result.ok, true);
  const out = result.output as Record<string, unknown>;
  assert.equal(out.omitted_days, 6);
  assert.equal(out.covered_until, "2026-06-14");
  assert.match(out.message as string, /2026-06-14/);
});

test("falla claro cuando HighLevel no está conectado", async () => {
  const { fn } = mockFetch({ connected: false });

  const result = await withFetch(fn as typeof fetch, () =>
    checkAvailabilityTool.run(
      { date_from: "2026-06-12", date_to: "2026-06-12" },
      ctx,
    ),
  );

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /HighLevel no está conectado/);
});

test("un día que el calendario devuelve en otra forma se rechaza, no se salta", async () => {
  const { fn } = mockFetch({
    hlBody: { "2026-09-17": { slots: null }, traceId: "x" },
  });

  const result = await withFetch(fn as typeof fetch, () =>
    checkAvailabilityTool.run(
      { date_from: "2026-09-17", date_to: "2026-09-17" },
      ctx,
    ),
  );

  assert.equal(result.ok, false);
  assert.doesNotMatch(result.error ?? "", /No hay horarios/);
});

test("un 200 con cuerpo de error no se lee como agenda vacía", async () => {
  const { fn } = mockFetch({
    hlBody: { status: "error", message: "upstream unavailable" },
  });

  const result = await withFetch(fn as typeof fetch, () =>
    checkAvailabilityTool.run(
      { date_from: "2026-09-17", date_to: "2026-09-17" },
      ctx,
    ),
  );

  assert.equal(result.ok, false);
  assert.doesNotMatch(result.error ?? "", /No hay horarios/);
});

test("un 200 con los días dentro de otra envoltura no se lee como agenda vacía", async () => {
  const { fn } = mockFetch({
    hlBody: { data: { "2026-09-17": { slots: ["2026-09-17T12:00:00-03:00"] } } },
  });

  const result = await withFetch(fn as typeof fetch, () =>
    checkAvailabilityTool.run(
      { date_from: "2026-09-17", date_to: "2026-09-17" },
      ctx,
    ),
  );

  assert.equal(result.ok, false);
});

test("una respuesta bien formada y vacía sí declara que no hay horarios", async () => {
  const { fn } = mockFetch({ hlBody: { "2026-09-17": { slots: [] } } });

  const result = await withFetch(fn as typeof fetch, () =>
    checkAvailabilityTool.run(
      { date_from: "2026-09-17", date_to: "2026-09-17" },
      ctx,
    ),
  );

  assert.equal(result.ok, true);
  const out = result.output as Record<string, unknown>;
  assert.equal(out.count, 0);
  assert.equal(out.message, "No hay horarios disponibles en ese rango.");
});

test("un día con más de 20 horarios los devuelve todos", async () => {
  // Guarda contra reintroducir un recorte por slot DENTRO de la tool: los
  // fixtures del resto de los tests nunca pasan de 20 y no lo detectarían.
  const slots = Array.from(
    { length: 48 },
    (_, i) =>
      `2026-09-17T${String(Math.floor(i / 2) + 0).padStart(2, "0")}:${i % 2 ? "30" : "00"}:00Z`,
  );
  const { fn } = mockFetch({
    timezone: "UTC",
    hlBody: { "2026-09-17": { slots } },
  });

  const result = await withFetch(fn as typeof fetch, () =>
    checkAvailabilityTool.run(
      { date_from: "2026-09-17", date_to: "2026-09-17" },
      ctx,
    ),
  );

  assert.equal(result.ok, true);
  const out = result.output as Record<string, unknown>;
  assert.equal(out.count, 48);
  assert.equal(
    (out.days as Record<string, string[]>)["2026-09-17"].length,
    48,
  );
});
