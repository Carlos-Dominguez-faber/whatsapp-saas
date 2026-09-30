import assert from "node:assert/strict";
import { test } from "node:test";
import { scheduleCalComTool } from "./schedule-calcom.ts";
import { cancelCalComTool } from "./cancel-calcom.ts";
import { rescheduleCalComTool } from "./reschedule-calcom.ts";
import { listCalComAppointmentsTool } from "./list-calcom-appointments.ts";
import { checkAvailabilityCalComTool } from "./check-availability-calcom.ts";
import { listEventTypesCalComTool } from "./list-event-types-calcom.ts";
import { registry } from "../registry.ts";
import type { ToolContext, ToolExecution } from "../core/tool";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

// ── HTTP-level fake: Supabase REST + Cal.com ────────────────────────────────

interface LocalRow {
  id: string;
  calcom_booking_uid: string | null;
  status: string;
  scheduled_at: string;
  conversation_id?: string | null;
}

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Applies scheduled_at=gte./lte., status=in.() and calcom_booking_uid=eq. to the rows. */
function filterRows(url: string, rows: LocalRow[]) {
  const search = new URL(url).searchParams;
  const bounds = search.getAll("scheduled_at");
  const statusIn = search.get("status")?.match(/^in\.\((.*)\)$/)?.[1].split(",");
  const uid = search.get("calcom_booking_uid")?.match(/^eq\.(.*)$/)?.[1];
  return rows.filter((row) => {
    if (statusIn && !statusIn.includes(row.status)) return false;
    if (uid !== undefined && row.calcom_booking_uid !== uid) return false;
    const at = Date.parse(row.scheduled_at);
    return bounds.every((b) => {
      const [op, ...rest] = b.split(".");
      const bound = Date.parse(decodeURIComponent(rest.join(".")).replace(/"/g, ""));
      return op === "gte" ? at >= bound : op === "lte" ? at <= bound : true;
    });
  });
}

/** A Cal.com booking object (v2). */
function booking(
  uid: string,
  startIso: string,
  extra: { status?: string; rescheduledToUid?: string; eventTypeId?: number } = {},
) {
  return {
    uid,
    start: startIso,
    end: new Date(Date.parse(startIso) + 30 * 60_000).toISOString(),
    status: extra.status ?? "accepted",
    eventType: { id: extra.eventTypeId ?? 7, slug: "consulta" },
    createdAt: "2030-01-01T00:00:00.000Z",
    ...(extra.rescheduledToUid ? { rescheduledToUid: extra.rescheduledToUid } : {}),
  };
}

type BookingAnswer = ReturnType<typeof booking> | null | { httpStatus: number } | { throws: true };

function calFetch(opts: {
  local?: LocalRow[];
  bookings?: Record<string, BookingAnswer>;
  eventTypes?: Array<Record<string, unknown>> | null;
  contactEmail?: string | null;
  timezone?: string;
  claim?: Record<string, unknown> | null;
  claimError?: boolean;
  create?: { status: number; body?: unknown } | { throws: true };
  cancel?: { status: number } | { throws: true };
  reschedule?: { status: number; body?: unknown } | { throws: true };
  slots?: { status: number; body: unknown };
  connected?: boolean;
}) {
  const calls: FetchCall[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    if (url.includes("/rest/v1/integrations")) {
      if (url.includes("provider=eq.caldotcom")) {
        return json(
          200,
          opts.connected === false
            ? []
            : [{ credentials: { calcom_api_key: "cal_live_secret" }, enabled: true }],
        );
      }
      return json(200, []);
    }
    if (url.includes("/rest/v1/business_info")) {
      return json(200, [{ structured: { timezone: opts.timezone ?? "America/Mexico_City" }, free_text: null }]);
    }
    if (url.includes("/rest/v1/rpc/claim_calcom_slot")) {
      if (opts.claimError) return json(500, { message: "db down" });
      return json(200, [
        opts.claim ?? {
          claim_id: "claim_1",
          holder_id: null,
          holder_uid: null,
          holder_event_type_id: null,
          holder_claim: null,
        },
      ]);
    }
    if (url.includes("/rest/v1/appointments")) {
      if (method === "GET") return json(200, filterRows(url, opts.local ?? []));
      if (method === "PATCH" && url.includes("id=eq.claim_1")) return json(200, [{ id: "claim_1" }]);
      return new Response(null, { status: 201 });
    }
    if (url.includes("/rest/v1/contacts")) {
      return json(200, opts.contactEmail ? [{ email: opts.contactEmail }] : [{ email: null }]);
    }
    if (url.includes("/rest/v1/messages")) {
      return method === "GET" ? json(200, []) : new Response(null, { status: 201 });
    }
    if (url.includes("/rest/v1/events")) {
      return method === "POST" ? json(201, [{ id: "trace_1" }]) : new Response(null, { status: 204 });
    }
    if (url.includes("api.cal.com/v2/event-types")) {
      if (opts.eventTypes === null) return json(500, {});
      return json(200, {
        status: "success",
        data: opts.eventTypes ?? [{ id: 7, title: "Consulta", lengthInMinutes: 30 }],
      });
    }
    if (url.includes("api.cal.com/v2/slots")) {
      const s = opts.slots ?? { status: 200, body: { status: "success", data: {} } };
      return json(s.status, s.body);
    }
    if (url.includes("api.cal.com/v2/bookings")) {
      const path = new URL(url).pathname;
      if (method === "POST" && path === "/v2/bookings") {
        const c = opts.create ?? { status: 201, body: { status: "success", data: booking("new_1", "2030-06-12T16:00:00.000Z") } };
        if ("throws" in c) throw new Error("socket hang up");
        return json(c.status, c.body ?? { message: "error" });
      }
      if (method === "POST" && path.endsWith("/cancel")) {
        const c = opts.cancel ?? { status: 200 };
        if ("throws" in c) throw new Error("socket hang up");
        return json(c.status, { status: "success" });
      }
      if (method === "POST" && path.endsWith("/reschedule")) {
        const r = opts.reschedule ?? {
          status: 201,
          body: { status: "success", data: booking("moved_1", "2030-06-15T18:00:00.000Z") },
        };
        if ("throws" in r) throw new Error("socket hang up");
        return json(r.status, r.body ?? { message: "error" });
      }
      const uid = decodeURIComponent(path.split("/").pop()!);
      let answer: BookingAnswer;
      if (opts.bookings && uid in opts.bookings) {
        answer = opts.bookings[uid];
      } else {
        const row = (opts.local ?? []).find((r) => r.calcom_booking_uid === uid);
        answer = row
          ? booking(uid, row.scheduled_at, { status: row.status === "cancelled" ? "cancelled" : "accepted" })
          : null;
      }
      if (answer === null) return json(404, {});
      if ("throws" in answer) throw new Error("socket hang up");
      if ("httpStatus" in answer) return json(answer.httpStatus, {});
      return json(200, { status: "success", data: answer });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
  return { fn, calls };
}

async function withFetch<T>(fake: { fn: typeof fetch }, body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fake.fn as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

const calPosts = (calls: FetchCall[]) =>
  calls.filter((c) => c.method === "POST" && c.url.includes("api.cal.com/v2/bookings"));
const notesIn = (calls: FetchCall[]) =>
  calls.filter((c) => c.method === "POST" && c.url.includes("/rest/v1/messages"));
const localWrites = (calls: FetchCall[]) =>
  calls.filter((c) => c.url.includes("/rest/v1/appointments") && c.method !== "GET");

const ctx: ToolContext = {
  workspaceId: "ws_1",
  conversationId: "conv_1",
  contactId: "contact_1",
  batchId: "batch_1",
};

// Mexico City is -06:00 all year: 10:00 local = 16:00Z.
const CONFIRMED = "2030-06-12T10:00:00-06:00";
const CONFIRMED_UTC = "2030-06-12T16:00:00.000Z";
const NEW_TIME = "2030-06-15T12:00:00-06:00";
const NEW_TIME_UTC = "2030-06-15T18:00:00.000Z";
const cached = (uid: string, at: string, status = "booked"): LocalRow => ({
  id: `row_${uid}`,
  calcom_booking_uid: uid,
  status,
  scheduled_at: at,
  conversation_id: "conv_1",
});

const schedule = (fake: ReturnType<typeof calFetch>, args: Partial<Record<string, unknown>> = {}, c = ctx) =>
  withFetch(fake, () =>
    scheduleCalComTool.run(
      {
        event_type_id: 7,
        datetime_iso: CONFIRMED,
        attendee_name: "Ana",
        attendee_email: "ana@example.com",
        ...args,
      } as Parameters<typeof scheduleCalComTool.run>[0],
      c,
    ),
  );

// ── schedule_calcom ──────────────────────────────────────────────────────────

test("schedule: claims, books at the confirmed instant in the business zone, and links the booking", async () => {
  const fake = calFetch({});
  const result = await schedule(fake);
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { booking_uid: "new_1", datetime: "2030-06-12T10:00:00-06:00" });

  const claim = fake.calls.find((c) => c.url.includes("rpc/claim_calcom_slot"))!;
  assert.deepEqual(claim.body, {
    p_workspace_id: "ws_1",
    p_contact_id: "contact_1",
    p_conversation_id: "conv_1",
    p_scheduled_at: CONFIRMED_UTC,
    p_event_type_id: 7,
    p_ttl_seconds: 120,
  });
  const [post] = calPosts(fake.calls);
  assert.deepEqual(post.body, {
    start: CONFIRMED_UTC,
    eventTypeId: 7,
    attendee: { name: "Ana", email: "ana@example.com", timeZone: "America/Mexico_City" },
  });
  assert.equal(post.headers["cal-api-version"], "2026-02-25");
  // The claim becomes the booking's row.
  const link = localWrites(fake.calls).find((c) => c.method === "PATCH")!;
  assert.ok(link.url.includes("id=eq.claim_1"));
  assert.deepEqual(link.body, {
    calcom_booking_uid: "new_1",
    scheduled_at: CONFIRMED_UTC,
    status: "booked",
    meta: {},
  });
});

test("schedule: a time copied from another zone is refused before anything is claimed", async () => {
  const fake = calFetch({});
  const result = await schedule(fake, { datetime_iso: "2030-06-12T10:00:00-05:00" });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /America\/Mexico_City/);
  assert.equal(fake.calls.filter((c) => c.url.includes("claim_calcom_slot")).length, 0);
  assert.equal(calPosts(fake.calls).length, 0);
});

test("schedule: another account's event type, or an unreadable list, books nothing", async () => {
  const foreign = calFetch({ eventTypes: [{ id: 99, title: "Otro" }] });
  const a = await schedule(foreign);
  assert.equal(a.ok, false);
  assert.match(a.error ?? "", /list_event_types_calcom/);
  assert.equal(calPosts(foreign.calls).length, 0);

  const down = calFetch({ eventTypes: null });
  const b = await schedule(down);
  assert.equal(b.ok, false);
  assert.match(b.error ?? "", /NO se agendó/);
  assert.equal(calPosts(down.calls).length, 0);

  const recurring = calFetch({ eventTypes: [{ id: 7, title: "Serie", recurrence: { frequency: "weekly" } }] });
  const c = await schedule(recurring);
  assert.equal(c.ok, false);
  assert.match(c.error ?? "", /recurrente/);
});

test("schedule: without an email given or saved, it asks for one", async () => {
  const fake = calFetch({ contactEmail: null });
  const result = await schedule(fake, { attendee_email: undefined });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /email/);
  assert.equal(calPosts(fake.calls).length, 0);

  const saved = calFetch({ contactEmail: "guardado@example.com" });
  const ok = await schedule(saved, { attendee_email: undefined });
  assert.equal(ok.ok, true);
  assert.equal((calPosts(saved.calls)[0].body as { attendee: { email: string } }).attendee.email, "guardado@example.com");
});

test("schedule: a retry finds its own booking live in Cal.com and books nothing new", async () => {
  const fake = calFetch({
    claim: { claim_id: null, holder_id: "row_b1", holder_uid: "b1", holder_event_type_id: 7, holder_claim: null },
    bookings: { b1: booking("b1", CONFIRMED_UTC) },
  });
  const result = await schedule(fake);
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { booking_uid: "b1", datetime: CONFIRMED, already_booked: true });
  assert.equal(calPosts(fake.calls).length, 0);
});

test("schedule: the same slot held for another service is not reported as booked", async () => {
  const fake = calFetch({
    claim: { claim_id: null, holder_id: "row_b1", holder_uid: "b1", holder_event_type_id: 8, holder_claim: null },
    bookings: { b1: booking("b1", CONFIRMED_UTC, { eventTypeId: 8 }) },
  });
  const result = await schedule(fake);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /otro servicio/);
  assert.equal(calPosts(fake.calls).length, 0);
});

test("schedule: a claim in flight answers 'processing'; one whose outcome is unknown goes to a person", async () => {
  const inFlight = calFetch({
    claim: { claim_id: null, holder_id: "row_x", holder_uid: null, holder_event_type_id: 7, holder_claim: "pending" },
  });
  const a = await schedule(inFlight);
  assert.equal(a.ok, false);
  assert.match(a.error ?? "", /procesando/);
  assert.equal(calPosts(inFlight.calls).length, 0);

  const unknown = calFetch({
    claim: { claim_id: null, holder_id: "row_x", holder_uid: null, holder_event_type_id: 7, holder_claim: "unknown" },
  });
  const b = await schedule(unknown);
  assert.equal(b.ok, false);
  assert.deepEqual(b.output, { needs_human: true });
  assert.equal(calPosts(unknown.calls).length, 0);
});

test("schedule: no answer from Cal.com keeps the claim as 'unknown', notes the team and reports neither outcome", async () => {
  const fake = calFetch({ create: { throws: true } });
  await assert.rejects(
    () => schedule(fake),
    (err: Error) => err.name === "UnknownOutcomeError" && /No pude confirmar/.test(err.message),
  );
  const mark = localWrites(fake.calls).find((c) => c.method === "PATCH")!;
  assert.deepEqual(mark.body, { meta: { calcom_claim: "unknown" } });
  assert.equal(localWrites(fake.calls).filter((c) => c.method === "DELETE").length, 0);
  assert.equal(notesIn(fake.calls).length, 1);

  // Through the registry the write counts as "may have happened".
  const executions: ToolExecution[] = [];
  const again = calFetch({ create: { status: 503 } });
  const result = await withFetch(again, () =>
    registry.runTool(
      scheduleCalComTool,
      { event_type_id: 7, datetime_iso: CONFIRMED, attendee_name: "Ana", attendee_email: "ana@example.com" },
      ctx,
      { onExecuted: (e) => void executions.push(e) },
    ),
  );
  assert.equal(result.ok, false);
  assert.equal(executions[0].ok, null);
  assert.equal(calPosts(again.calls).length, 1, "a write is never retried");
});

test("schedule: Cal.com refusing the slot releases the claim and says it wasn't booked", async () => {
  const fake = calFetch({ create: { status: 400, body: { message: "User either already has booking at this time or is not available" } } });
  const result = await schedule(fake);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /ya no está disponible/);
  const release = localWrites(fake.calls).find((c) => c.method === "DELETE")!;
  assert.ok(release.url.includes("id=eq.claim_1"));
  assert.ok(release.url.includes("calcom_booking_uid=is.null"));

  const other = calFetch({ create: { status: 401, body: { message: "invalid api key cal_live_secret" } } });
  const refused = await schedule(other);
  assert.deepEqual(refused.output, { needs_human: true });
  assert.doesNotMatch(refused.error ?? "", /cal_live_secret/);
  assert.equal(notesIn(other.calls).length, 1);
});

test("schedule: a booking without a uid is still a success, marked so it never expires", async () => {
  const fake = calFetch({ create: { status: 201, body: { status: "success", data: { start: CONFIRMED_UTC } } } });
  const result = await schedule(fake);
  assert.equal(result.ok, true);
  assert.equal((result.output as { booking_uid: unknown }).booking_uid, null);
  const mark = localWrites(fake.calls).find((c) => c.method === "PATCH")!;
  assert.deepEqual(mark.body, { meta: { calcom_claim: "booked_without_uid" } });
  assert.equal(notesIn(fake.calls).length, 1);
});

test("schedule: the playground books only on an email the tester typed, and leaves a trace", async () => {
  const playground: ToolContext = {
    workspaceId: "ws_1",
    conversationId: "",
    contactId: "",
    playground: { userId: "user_1", userMessages: ["quiero una cita, mi correo es prueba@example.com"] },
  };
  const invented = calFetch({});
  const refused = await schedule(invented, { attendee_email: "otra@example.com" }, playground);
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? "", /email de prueba/);
  assert.equal(calPosts(invented.calls).length, 0);

  const typed = calFetch({});
  const booked = await schedule(typed, { attendee_email: "Prueba@example.com" }, playground);
  assert.equal(booked.ok, true);
  const trace = typed.calls.find((c) => c.method === "POST" && c.url.includes("/rest/v1/events"))!;
  assert.equal((trace.body as { type: string }).type, "playground_write");
  const claim = typed.calls.find((c) => c.url.includes("claim_calcom_slot"))!;
  assert.equal((claim.body as { p_contact_id: unknown }).p_contact_id, null);
  assert.match((calPosts(typed.calls)[0].body as { attendee: { name: string } }).attendee.name, /^\[Prueba\]/);
});

// ── cancel_calcom ────────────────────────────────────────────────────────────

const cancelAt = (fake: ReturnType<typeof calFetch>, iso = CONFIRMED) =>
  withFetch(fake, () => cancelCalComTool.run({ appointment_datetime_iso: iso }, ctx));

test("cancel: cancels the booking Cal.com has at the confirmed time", async () => {
  const fake = calFetch({ local: [cached("b1", CONFIRMED_UTC), cached("b2", "2030-06-12T18:00:00.000Z")] });
  const result = await cancelAt(fake);
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { cancelled: true });
  const [post] = calPosts(fake.calls);
  assert.ok(post.url.endsWith("/v2/bookings/b1/cancel"));
  assert.equal(post.headers["cal-api-version"], "2026-02-25");
  const patch = localWrites(fake.calls).filter((c) => c.method === "PATCH").pop()!;
  assert.ok(decodeURIComponent(patch.url).includes("calcom_booking_uid=eq.b1"));
  assert.equal((patch.body as { status: string }).status, "cancelled");
});

test("cancel: a retry after it went through answers 'already cancelled' and cancels nothing else", async () => {
  const fake = calFetch({
    local: [cached("b1", CONFIRMED_UTC), cached("b2", "2030-06-12T18:00:00.000Z")],
    bookings: { b1: booking("b1", CONFIRMED_UTC, { status: "cancelled" }) },
  });
  const result = await cancelAt(fake);
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { cancelled: true, already_cancelled: true });
  assert.equal(calPosts(fake.calls).length, 0);
});

test("cancel: a booking moved in Cal.com is found at its new time, not at the cached one", async () => {
  const fake = calFetch({
    local: [cached("b1", CONFIRMED_UTC)],
    bookings: {
      b1: booking("b1", CONFIRMED_UTC, { status: "cancelled", rescheduledToUid: "b9" }),
      b9: booking("b9", "2030-06-12T20:00:00.000Z"),
    },
  });
  const atOld = await cancelAt(fake);
  assert.equal(atOld.ok, false);
  assert.match(atOld.error ?? "", /No encontré/);
  assert.equal(calPosts(fake.calls).length, 0);
  // The move is written back: old row cancelled, new one cached.
  const upsert = localWrites(fake.calls).find(
    (c) => c.method === "POST" && decodeURIComponent(c.url).includes("on_conflict=workspace_id,calcom_booking_uid"),
  )!;
  assert.equal((upsert.body as { calcom_booking_uid: string }).calcom_booking_uid, "b9");
  assert.equal((upsert.body as { conversation_id: string }).conversation_id, "conv_1");

  const atNew = await cancelAt(fake, "2030-06-12T14:00:00-06:00");
  assert.equal(atNew.ok, true);
  assert.ok(calPosts(fake.calls)[0].url.endsWith("/v2/bookings/b9/cancel"));
});

test("cancel: an unreadable booking near that time is 'unconfirmed', never 'not found'", async () => {
  const fake = calFetch({
    local: [cached("b1", CONFIRMED_UTC)],
    bookings: { b1: { httpStatus: 502 } },
  });
  const result = await cancelAt(fake);
  assert.equal(result.ok, false);
  assert.deepEqual(result.output, { needs_human: true });
  assert.equal(calPosts(fake.calls).length, 0);
  assert.equal(notesIn(fake.calls).length, 1);
});

test("cancel: no answer to the cancel reports neither outcome", async () => {
  const fake = calFetch({ local: [cached("b1", CONFIRMED_UTC)], cancel: { throws: true } });
  await assert.rejects(() => cancelAt(fake), (err: Error) => err.name === "UnknownOutcomeError");
  assert.equal(notesIn(fake.calls).length, 1);
});

test("cancel: the playground has no appointment to cancel", async () => {
  const fake = calFetch({ local: [cached("b1", CONFIRMED_UTC)] });
  const result = await withFetch(fake, () =>
    cancelCalComTool.run({ appointment_datetime_iso: CONFIRMED }, { ...ctx, contactId: "" }),
  );
  assert.equal(result.ok, false);
  assert.equal(calPosts(fake.calls).length, 0);
});

// ── reschedule_calcom ────────────────────────────────────────────────────────

const moveTo = (fake: ReturnType<typeof calFetch>, to = NEW_TIME, from = CONFIRMED) =>
  withFetch(fake, () =>
    rescheduleCalComTool.run({ appointment_datetime_iso: from, new_datetime_iso: to }, ctx),
  );

test("reschedule: moves the booking at the confirmed time and caches the new one", async () => {
  const fake = calFetch({ local: [cached("b1", CONFIRMED_UTC)] });
  const result = await moveTo(fake);
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { rescheduled: true, new_datetime: NEW_TIME });
  const [post] = calPosts(fake.calls);
  assert.ok(post.url.endsWith("/v2/bookings/b1/reschedule"));
  assert.equal((post.body as { start: string }).start, NEW_TIME_UTC);
  const upsert = localWrites(fake.calls).find(
    (c) =>
      c.method === "POST" &&
      decodeURIComponent(c.url).includes("on_conflict=workspace_id,calcom_booking_uid") &&
      (c.body as { calcom_booking_uid: string }).calcom_booking_uid === "moved_1",
  )!;
  assert.ok(upsert, "the new booking is cached");
  assert.equal((upsert.body as { scheduled_at: string }).scheduled_at, NEW_TIME_UTC);
  assert.deepEqual((upsert.body as { meta: unknown }).meta, { rescheduled_from: CONFIRMED_UTC });
  const cancelOld = localWrites(fake.calls).find(
    (c) => c.method === "PATCH" && decodeURIComponent(c.url).includes("calcom_booking_uid=eq.b1"),
  )!;
  assert.deepEqual(cancelOld.body, { status: "cancelled", meta: { rescheduled_to: "moved_1" } });
  assert.equal((upsert.body as { conversation_id: string }).conversation_id, "conv_1");
});

test("reschedule: a retry after it went through answers 'already rescheduled' and moves nothing", async () => {
  const fake = calFetch({
    local: [cached("b1", CONFIRMED_UTC)],
    bookings: {
      b1: booking("b1", CONFIRMED_UTC, { status: "cancelled", rescheduledToUid: "b2" }),
      b2: booking("b2", NEW_TIME_UTC),
    },
  });
  const result = await moveTo(fake);
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { rescheduled: true, already_rescheduled: true, new_datetime: NEW_TIME });
  assert.equal(calPosts(fake.calls).length, 0);
});

test("reschedule: moved without the new booking in the answer is still a success", async () => {
  const fake = calFetch({
    local: [cached("b1", CONFIRMED_UTC)],
    reschedule: { status: 201, body: { status: "success", data: {} } },
  });
  const result = await moveTo(fake);
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { rescheduled: true, new_datetime: NEW_TIME });
  // The old row is left for the next read to follow in Cal.com.
  assert.equal(localWrites(fake.calls).filter((c) => c.method === "PATCH").length, 0);
});

test("reschedule: a taken slot is not a success and needs no person", async () => {
  const fake = calFetch({
    local: [cached("b1", CONFIRMED_UTC)],
    reschedule: { status: 400, body: { message: "no available users found" } },
  });
  const result = await moveTo(fake);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /ya no está disponible/);
  assert.equal(result.output, null);
});

test("reschedule: no answer reports neither outcome", async () => {
  const fake = calFetch({ local: [cached("b1", CONFIRMED_UTC)], reschedule: { throws: true } });
  await assert.rejects(() => moveTo(fake), (err: Error) => err.name === "UnknownOutcomeError");
});

// ── list_calcom_appointments ────────────────────────────────────────────────

test("list: the contact's upcoming live bookings as Cal.com has them, in the business zone", async () => {
  const fake = calFetch({
    local: [cached("b1", CONFIRMED_UTC), cached("b2", NEW_TIME_UTC), cached("b3", "2030-06-20T16:00:00.000Z")],
    bookings: {
      b2: booking("b2", NEW_TIME_UTC, { status: "cancelled" }),
      b3: booking("b3", "2030-06-20T16:00:00.000Z", { status: "cancelled", rescheduledToUid: "b4" }),
      b4: booking("b4", "2030-06-21T16:00:00.000Z"),
    },
  });
  const result = await withFetch(fake, () => listCalComAppointmentsTool.run({}, ctx));
  assert.equal(result.ok, true);
  const out = result.output as { appointments: Array<{ datetime_iso: string }>; note: string };
  assert.deepEqual(
    out.appointments.map((a) => a.datetime_iso),
    ["2030-06-12T10:00:00-06:00", "2030-06-21T10:00:00-06:00"],
  );
  assert.match(out.note, /por fuera de WhatsApp/);
});

test("list: a read that fails is not 'no appointments'", async () => {
  const fake = calFetch({ local: [cached("b1", CONFIRMED_UTC)], bookings: { b1: { throws: true } } });
  const result = await withFetch(fake, () => listCalComAppointmentsTool.run({}, ctx));
  const out = result.output as { appointments: unknown[]; note: string };
  assert.equal(out.appointments.length, 0);
  assert.match(out.note, /No pude leer una de sus citas/);
  assert.doesNotMatch(out.note, /no tiene citas/);
});

// ── check_availability_calcom / list_event_types_calcom ─────────────────────

test("availability: asks for the local days in the business zone and writes slots with its offset", async () => {
  const fake = calFetch({
    slots: {
      status: 200,
      body: {
        status: "success",
        data: {
          "2030-06-12": [{ start: "2030-06-12T10:00:00.000-06:00" }, { start: "2030-06-12T16:30:00.000Z" }],
        },
      },
    },
  });
  const result = await withFetch(fake, () =>
    checkAvailabilityCalComTool.run({ event_type_id: 7, date_from: "2030-06-12", date_to: "2030-06-12" }, ctx),
  );
  assert.equal(result.ok, true);
  const out = result.output as { days: Record<string, string[]>; timezone: string };
  assert.deepEqual(out.days, {
    "2030-06-12": ["2030-06-12T10:00:00-06:00", "2030-06-12T10:30:00-06:00"],
  });
  assert.equal(out.timezone, "America/Mexico_City");
  const call = fake.calls.find((c) => c.url.includes("/v2/slots"))!;
  const params = new URL(call.url).searchParams;
  assert.equal(params.get("start"), "2030-06-12T06:00:00.000Z");
  assert.equal(params.get("end"), "2030-06-13T05:59:59.999Z");
  assert.equal(params.get("timeZone"), "America/Mexico_City");
});

test("availability: a body it doesn't recognize is not 'no slots'", async () => {
  const fake = calFetch({ slots: { status: 200, body: { status: "success", data: { slots: [] } } } });
  const result = await withFetch(fake, () =>
    checkAvailabilityCalComTool.run({ event_type_id: 7, date_from: "2030-06-12", date_to: "2030-06-12" }, ctx),
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /no se sabe si hay horarios/);
});

test("event types: listed with their length, recurring ones flagged; a failure is an error", async () => {
  const fake = calFetch({
    eventTypes: [
      { id: 7, title: "Consulta", lengthInMinutes: 30 },
      { id: 8, title: "Serie", lengthInMinutes: 60, recurrence: { frequency: "weekly" } },
    ],
  });
  const result = await withFetch(fake, () => listEventTypesCalComTool.run({}, ctx));
  assert.deepEqual(result.output, {
    event_types: [
      { id: 7, title: "Consulta", duration_minutes: 30, recurring: false },
      { id: 8, title: "Serie", duration_minutes: 60, recurring: true },
    ],
    count: 2,
  });
  const down = calFetch({ eventTypes: null });
  const failed = await withFetch(down, () => listEventTypesCalComTool.run({}, ctx));
  assert.equal(failed.ok, false);

  const off = calFetch({ connected: false });
  const notConnected = await withFetch(off, () => listEventTypesCalComTool.run({}, ctx));
  assert.match(notConnected.error ?? "", /no está conectado/);
});
