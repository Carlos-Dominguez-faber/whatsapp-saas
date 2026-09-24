import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { createHmac } from "node:crypto";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.BUFFER_PROCESS_SECRET = "buf-secret";

const filterCalls: Array<[string, string, unknown]> = [];
const updates: unknown[] = [];
let lookupRow: Record<string, unknown> | null = null;
let processCalls = 0;

const fakeSvc = {
  from: () => ({
    select: () => {
      const chain: any = {
        eq(col: string, val: unknown) {
          filterCalls.push(["eq", col, val]);
          return chain;
        },
        in(col: string, val: unknown) {
          filterCalls.push(["in", col, val]);
          return chain;
        },
        maybeSingle: async () => ({ data: lookupRow, error: null }),
      };
      return chain;
    },
    update: (patch: unknown) => {
      updates.push(patch);
      const chain: any = { eq: () => chain, then: (r: any) => r({ error: null }) };
      return chain;
    },
  }),
};
mock.module("@supabase/supabase-js", {
  exports: { createClient: () => fakeSvc },
});
mock.module("@/features/inbox/services/buffer.ts", {
  exports: {
    processNextBatch: async () => {
      processCalls++;
      return { processed: true };
    },
  },
});

const { POST, maxDuration } = await import("./route.ts");

function signed(body: string, secret = "buf-secret") {
  const sig = createHmac("sha256", secret).update(body).digest("hex");
  return new Request("http://localhost/api/internal/buffer/process", {
    method: "POST",
    body,
    headers: { Authorization: `Bearer ${sig}` },
  });
}

function reset() {
  filterCalls.length = 0;
  updates.length = 0;
  lookupRow = null;
  processCalls = 0;
}

test("a targeted batchId only revives batches still in 'buffering', never one in flight", async () => {
  reset();
  const res = await POST(signed(JSON.stringify({ batchId: "batch_1" })));
  assert.equal(res.status, 404);
  assert.ok(
    filterCalls.some(([op, col, val]) => op === "eq" && col === "status" && val === "buffering"),
    `expected .eq("status","buffering"), got ${JSON.stringify(filterCalls)}`,
  );
  assert.ok(!filterCalls.some(([op]) => op === "in"), "must not use .in('status', [...processing])");
  assert.equal(updates.length, 0, "a batch that is not buffering must not be re-armed");
  assert.equal(processCalls, 0);
});

test("a buffering batch is re-armed and processed", async () => {
  reset();
  lookupRow = { id: "batch_1", workspace_id: "ws_1", status: "buffering" };
  const res = await POST(signed(JSON.stringify({ batchId: "batch_1" })));
  assert.equal(res.status, 200);
  assert.equal(updates.length, 1);
  assert.equal(processCalls, 1);
});

test("rejects a body signed with the wrong secret", async () => {
  reset();
  const res = await POST(signed(JSON.stringify({ batchId: "batch_1" }), "wrong"));
  assert.equal(res.status, 401);
  assert.equal(processCalls, 0);
});

test("declares maxDuration", () => {
  assert.equal(maxDuration, 300);
});
