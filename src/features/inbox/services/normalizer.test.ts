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

test("STOP is left to the database: the app writes no opt-out of its own", async () => {
  reset();
  await processInbound("ws_1", textInbound("STOP"));
  assert.equal(updates.filter((u) => u.table === "contacts").length, 0);
  assert.ok(upserts.some((u) => u.table === "messages"), "the STOP message is stored, and its trigger applies it");
});
