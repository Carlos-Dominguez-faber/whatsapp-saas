import assert from "node:assert/strict";
import { test } from "node:test";
import { sweepStaleCalComClaims } from "./calcom-claim-sweep.ts";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const START = "2030-06-12T16:00:00.000Z";
const claimRow = (meta: Record<string, unknown>) => ({
  id: "row_1",
  workspace_id: "ws_1",
  conversation_id: "conv_1",
  scheduled_at: START,
  calcom_event_type_id: 7,
  meta,
});
const bookingAt = (uid: string, email = "ana@example.com", eventTypeId = 7) => ({
  uid,
  start: START,
  status: "accepted",
  eventType: { id: eventTypeId },
  attendees: [{ email }],
});

function fake(opts: {
  rows: Array<Record<string, unknown>>;
  list?: { status: number; body: unknown };
  connected?: boolean;
  /** The integrations read fails. */
  configUnreadable?: boolean;
  alreadySwept?: boolean;
}) {
  const calls: Call[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.includes("/rest/v1/rpc/stale_calcom_claims")) return json(200, opts.rows);
    if (url.includes("/rest/v1/appointments")) {
      const swept = decodeURIComponent(url).includes("meta->>calcom_swept=is.null");
      return json(200, swept && opts.alreadySwept ? [] : [{ id: "row_1" }]);
    }
    if (url.includes("/rest/v1/integrations")) {
      if (opts.configUnreadable) return json(500, { message: "db down" });
      return json(200, opts.connected === false ? [] : [{ credentials: { calcom_api_key: "cal_x" }, enabled: true }]);
    }
    if (url.includes("/rest/v1/business_info")) {
      return json(200, [{ structured: { timezone: "America/Mexico_City" }, free_text: null }]);
    }
    if (url.includes("/rest/v1/events")) return new Response(null, { status: 201 });
    if (url.includes("/rest/v1/messages")) return method === "GET" ? json(200, []) : new Response(null, { status: 201 });
    if (url.includes("api.cal.com/v2/bookings")) {
      const l = opts.list ?? { status: 200, body: { status: "success", data: [], pagination: { hasMore: false } } };
      return json(l.status, l.body);
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
  return { fn, calls };
}

async function run(f: ReturnType<typeof fake>) {
  const original = globalThis.fetch;
  globalThis.fetch = f.fn as typeof fetch;
  try {
    return await sweepStaleCalComClaims(Date.now() + 50_000);
  } finally {
    globalThis.fetch = original;
  }
}

const patches = (calls: Call[]) => calls.filter((c) => c.method === "PATCH" && c.url.includes("/appointments"));

test("the sweep asks stale_calcom_claims() for claims older than 10 min, 20 a tick", async () => {
  const f = fake({ rows: [] });
  await run(f);
  assert.ok(f.calls[0].url.endsWith("/rest/v1/rpc/stale_calcom_claims"));
  assert.deepEqual(f.calls[0].body, { p_older_than_seconds: 600, p_limit: 20 });
});

test("every write goes over the claim as it was read (live, no uid, same marker)", async () => {
  const f = fake({ rows: [claimRow({ calcom_claim: "unknown", attendee_email: "ana@example.com" })] });
  await run(f);
  const url = decodeURIComponent(patches(f.calls)[0].url);
  assert.match(url, /calcom_booking_uid=is\.null/);
  assert.match(url, /status=in\.\(booked,confirmed\)/);
  assert.match(url, /meta->>calcom_claim=eq\.unknown/);

  const legacy = fake({ rows: [claimRow({})] });
  await run(legacy);
  assert.match(decodeURIComponent(patches(legacy.calls)[0].url), /meta->>calcom_claim=is\.null/);

  // Changed meanwhile (0 rows): not counted as released.
  const changed = fake({ rows: [claimRow({ calcom_claim: "unknown", attendee_email: "ana@example.com" })], alreadySwept: false });
  changed.fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/rest/v1/appointments") && (init?.method ?? "GET") === "PATCH") return json(200, []);
    return fake({ rows: [claimRow({ calcom_claim: "unknown", attendee_email: "ana@example.com" })] }).fn(input, init);
  }) as typeof changed.fn;
  assert.deepEqual(await run(changed), { resolved: 0, released: 0, flagged: 0 });
});

test("an unreadable Cal.com integration skips the claim this tick; it isn't 'not connected'", async () => {
  const f = fake({ rows: [claimRow({ calcom_claim: "unknown", attendee_email: "ana@example.com" })], configUnreadable: true });
  assert.deepEqual(await run(f), { resolved: 0, released: 0, flagged: 0 });
  assert.equal(patches(f.calls).length, 0);
});

test("before db-push (no stale_calcom_claims) the sweep is skipped, not a failed phase", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    json(404, {
      code: "PGRST202",
      message: "Could not find the function public.stale_calcom_claims(p_limit, p_older_than_seconds)",
      hint: null,
    })) as typeof fetch;
  try {
    assert.deepEqual(await sweepStaleCalComClaims(Date.now() + 50_000), { resolved: 0, released: 0, flagged: 0 });
  } finally {
    globalThis.fetch = original;
  }
});

test("found in Cal.com → linked; a complete 'no' → released", async () => {
  const found = fake({
    rows: [claimRow({ calcom_claim: "sending", attendee_email: "ana@example.com" })],
    list: { status: 200, body: { status: "success", data: [bookingAt("bk_1")], pagination: { hasMore: false } } },
  });
  assert.deepEqual(await run(found), { resolved: 1, released: 0, flagged: 0 });
  assert.deepEqual(patches(found.calls)[0].body, { calcom_booking_uid: "bk_1", status: "booked", meta: {} });

  const none = fake({ rows: [claimRow({ calcom_claim: "unknown", attendee_email: "ana@example.com" })] });
  assert.deepEqual(await run(none), { resolved: 0, released: 1, flagged: 0 });
  assert.equal((patches(none.calls)[0].body as { status: string }).status, "cancelled");
  assert.equal(((patches(none.calls)[0].body as { meta: Record<string, unknown> }).meta).calcom_claim, "released");
  const released = none.calls.find((c) => c.method === "POST" && c.url.includes("/rest/v1/events"))!;
  assert.equal((released.body as { type: string }).type, "calcom_claim_released");

  // A booking at that start that was moved elsewhere was made: not "none".
  const moved = fake({
    rows: [claimRow({ calcom_claim: "unknown", attendee_email: "ana@example.com" })],
    list: {
      status: 200,
      body: {
        status: "success",
        data: [{ ...bookingAt("bk_old"), status: "cancelled", rescheduledToUid: "bk_new" }],
        pagination: { hasMore: false },
      },
    },
  });
  assert.deepEqual(await run(moved), { resolved: 0, released: 0, flagged: 1 });
});

test("no complete answer, no email or no Cal.com → a note and an event, once", async () => {
  for (const [opts, why] of [
    [{ list: { status: 200, body: { status: "success", data: [bookingAt("x", "zoe@o.com")] } } }, /respuesta completa/],
    [{ rows: [claimRow({})] }, /email/],
    [{ connected: false }, /no está conectado/],
  ] as const) {
    const f = fake({
      rows: [claimRow({ calcom_claim: "unknown", attendee_email: "ana@example.com" })],
      ...(opts as Record<string, unknown>),
    });
    assert.deepEqual(await run(f), { resolved: 0, released: 0, flagged: 1 });
    const mark = patches(f.calls)[0];
    assert.ok(decodeURIComponent(mark.url).includes("meta->>calcom_swept=is.null"), "a compare-and-swap");
    const event = f.calls.find((c) => c.method === "POST" && c.url.includes("/rest/v1/events"))!;
    assert.equal((event.body as { type: string }).type, "calcom_claim_unresolved");
    const note = f.calls.find((c) => c.method === "POST" && c.url.includes("/rest/v1/messages"))!;
    assert.match((note.body as { body: string }).body, why);
  }

  // Another tick already reported it: nothing twice.
  const again = fake({ rows: [claimRow({ calcom_claim: "unknown" })], alreadySwept: true });
  assert.deepEqual(await run(again), { resolved: 0, released: 0, flagged: 0 });
  assert.equal(again.calls.filter((c) => c.url.includes("/rest/v1/events")).length, 0);
});

test("a failed lookup is a failed phase; no time left, nothing starts", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => json(500, { message: "down" })) as typeof fetch;
  try {
    assert.equal((await sweepStaleCalComClaims(Date.now() + 50_000)).error, "calcom_sweep_lookup_failed");
    assert.deepEqual(await sweepStaleCalComClaims(Date.now() + 1_000), { resolved: 0, released: 0, flagged: 0 });
  } finally {
    globalThis.fetch = original;
  }
});
