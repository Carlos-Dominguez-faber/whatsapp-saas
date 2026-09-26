import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

type Row = Record<string, unknown>;
const upserts: Array<{ table: string; row: Row }> = [];

const fakeSvc = {
  from: (table: string) => ({
    select: () => {
      const q: any = { eq: () => q, maybeSingle: async () => ({ data: null, error: null }) };
      return q;
    },
    upsert: (row: Row) => {
      upserts.push({ table, row });
      return {
        select: () => ({
          single: async () => ({ data: { id: `${table}_1`, ...row }, error: null }),
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
