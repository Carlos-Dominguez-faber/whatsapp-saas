import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getHLConfig,
  hlConfiguredTimeZone,
  saveHLLocationTimeZone,
} from "./highlevel-client.ts";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Call {
  url: string;
  method: string;
  body: unknown;
  version: string | null;
}

/** Supabase REST (the HighLevel integration row) + HighLevel's location. */
function fake(opts: {
  config?: Record<string, unknown>;
  integrationsError?: boolean;
  location?: Record<string, unknown>;
}) {
  const calls: Call[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      version: new Headers(init?.headers).get("Version"),
    });
    if (url.includes("/rest/v1/integrations")) {
      if (method !== "GET") return new Response(null, { status: 204 });
      if (opts.integrationsError) return json(500, { message: "db down" });
      return json(200, [
        {
          credentials: { highlevel_pit: "tok_1" },
          config: { location_id: "loc_1", ...(opts.config ?? {}) },
          enabled: true,
        },
      ]);
    }
    if (url.includes("leadconnectorhq.com/locations/loc_1")) {
      return json(200, { location: opts.location ?? {} });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
  return { fn: fn as typeof fetch, calls };
}

async function withFetch<T>(f: { fn: typeof fetch }, body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = f.fn;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

test("a stored 'UTC' is 'not configured' unless the location lookup wrote it", async () => {
  const legacy = fake({ config: { timezone: "UTC" } });
  assert.equal((await withFetch(legacy, () => getHLConfig("ws_1")))?.timezone, null);
  assert.equal(await withFetch(legacy, () => hlConfiguredTimeZone("ws_1")), null);

  const fromLocation = fake({ config: { timezone: "UTC", timezone_source: "location" } });
  assert.equal((await withFetch(fromLocation, () => getHLConfig("ws_1")))?.timezone, "UTC");
  assert.equal(await withFetch(fromLocation, () => hlConfiguredTimeZone("ws_1")), "UTC");

  const set = fake({ config: { timezone: "America/Cancun" } });
  assert.equal((await withFetch(set, () => getHLConfig("ws_1")))?.timezone, "America/Cancun");
});

test("the location's zone is read with the spec's Version and stored, marked as the location's", async () => {
  const f = fake({ config: { calendar_id: "cal_1" }, location: { timezone: "America/Cancun" } });
  const tz = await withFetch(f, () => saveHLLocationTimeZone("ws_1"));
  assert.equal(tz, "America/Cancun");
  const lookup = f.calls.find((c) => c.url.includes("/locations/loc_1"));
  // GET /locations/{locationId} in HighLevel's OpenAPI spec.
  assert.equal(lookup?.version, "2021-07-28");
  const write = f.calls.find((c) => c.url.includes("/rest/v1/integrations") && c.method === "PATCH");
  assert.deepEqual(write?.body, {
    config: {
      location_id: "loc_1",
      calendar_id: "cal_1",
      timezone: "America/Cancun",
      timezone_source: "location",
    },
  });
});

test("a location without a valid zone changes nothing", async () => {
  const f = fake({ config: { timezone: "America/Cancun" } });
  const tz = await withFetch(f, () => saveHLLocationTimeZone("ws_1", { timezone: "CST" }));
  assert.equal(tz, null);
  assert.ok(!f.calls.some((c) => c.method === "PATCH"));
});

test("a failed zone lookup is logged, not swallowed", async () => {
  const f = fake({ integrationsError: true });
  const logged: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    assert.equal(await withFetch(f, () => hlConfiguredTimeZone("ws_1")), null);
  } finally {
    console.error = original;
  }
  assert.ok(logged.some((l) => String((l as unknown[])[0]).includes("zone lookup failed")));
});
