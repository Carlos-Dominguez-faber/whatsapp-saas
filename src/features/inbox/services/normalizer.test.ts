import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

type Row = Record<string, unknown>;
const upserts: Array<{ table: string; row: Row }> = [];
const updates: Array<{ table: string; row: Row; filters: Array<[string, unknown]> }> = [];
let updateError: string | null = null;
/** The message insert hits the wamid dedupe: a redelivery. */
let duplicateMessage = false;

const fakeSvc = {
  from: (table: string) => ({
    select: () => {
      const q: any = { eq: () => q, maybeSingle: async () => ({ data: null, error: null }) };
      return q;
    },
    update: (row: Row) => {
      const call = { table, row, filters: [] as Array<[string, unknown]> };
      updates.push(call);
      const q: any = {
        eq: (c: string, v: unknown) => {
          call.filters.push([c, v]);
          return q;
        },
        select: () => q,
        maybeSingle: async () =>
          updateError
            ? { data: null, error: { message: updateError } }
            : { data: { id: `${table}_1`, ...row }, error: null },
      };
      return q;
    },
    upsert: (row: Row) => {
      upserts.push({ table, row });
      return {
        select: () => ({
          single: async () =>
            table === "messages" && duplicateMessage
              ? { data: null, error: { code: "PGRST116", message: "no rows" } }
              : { data: { id: `${table}_1`, ...row }, error: null },
        }),
      };
    },
  }),
};
mock.module("@supabase/supabase-js", { exports: { createClient: () => fakeSvc } });

const { processInbound } = await import("./normalizer.ts");

const inbound = (rawType: string) => ({
  from: "+5215512345678",
  type: rawType === "reaction" ? "text" : rawType,
  text: rawType === "reaction" ? "[Reacción: 👍]" : "hola",
  wamid: `wamid.${rawType}`,
  customerName: "Ana",
  rawType,
});

test("a reaction is stored marked no_reply, so nothing ever answers it", async () => {
  upserts.length = 0;
  await processInbound("ws_1", inbound("reaction"));
  const message = upserts.find((u) => u.table === "messages")!.row;
  assert.deepEqual(message.meta, { from_name: "Ana", no_reply: true });
});

test("any other message is stored for answering", async () => {
  upserts.length = 0;
  await processInbound("ws_1", inbound("text"));
  const message = upserts.find((u) => u.table === "messages")!.row;
  assert.deepEqual(message.meta, { from_name: "Ana" });
});

const textInbound = (text: string) => ({
  from: "+5215512345678",
  type: "text",
  text,
  wamid: `wamid.${text}`,
  customerName: "Ana",
  rawType: "text",
});

function reset() {
  upserts.length = 0;
  updates.length = 0;
  updateError = null;
  duplicateMessage = false;
}

test("STOP opts the contact out, scoped to its workspace, before the message is stored", async () => {
  reset();
  await processInbound("ws_1", textInbound("STOP"));
  const optOut = updates.find((u) => u.table === "contacts")!;
  assert.equal(optOut.row.opt_in, false);
  assert.equal(typeof optOut.row.opted_out_at, "string");
  assert.deepEqual(optOut.filters, [
    ["id", "contacts_1"],
    ["workspace_id", "ws_1"],
  ]);
  assert.ok(upserts.some((u) => u.table === "messages"), "the STOP message itself is kept");
});

test("START opts the contact back in and clears the opt-out", async () => {
  reset();
  await processInbound("ws_1", textInbound("Start"));
  const optIn = updates.find((u) => u.table === "contacts")!;
  assert.equal(optIn.row.opt_in, true);
  assert.equal(optIn.row.opted_out_at, null);
});

test("a normal message touches no opt-in field beyond the upsert", async () => {
  reset();
  await processInbound("ws_1", textInbound("quiero darme de baja del plan, ¿cómo le hago?"));
  assert.equal(updates.filter((u) => u.table === "contacts").length, 0);
});

test("a failed opt-out write is logged and the message is still stored", async () => {
  reset();
  updateError = "column contacts.opted_out_at does not exist";
  const errorMock = mock.method(console, "error", () => {});
  try {
    await processInbound("ws_1", textInbound("stop"));
  } finally {
    errorMock.mock.restore();
  }
  assert.ok(upserts.some((u) => u.table === "messages"));
});

test("a bare 'baja' or 'alta' (a one-word answer) changes nothing", async () => {
  reset();
  await processInbound("ws_1", textInbound("baja"));
  await processInbound("ws_1", textInbound("alta"));
  assert.equal(updates.filter((u) => u.table === "contacts").length, 0);
});

test("a redelivered STOP (same wamid, deduped) does not opt the contact out again", async () => {
  reset();
  duplicateMessage = true;
  await processInbound("ws_1", textInbound("STOP"));
  assert.equal(updates.filter((u) => u.table === "contacts").length, 0);
});
