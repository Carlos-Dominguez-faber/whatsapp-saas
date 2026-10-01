import assert from "node:assert/strict";
import { test, mock } from "node:test";

const processCalls: number[] = [];
let reconcileCalls = 0;
// Results processNextBatch returns in order; empty → nothing left to claim.
let queue: Array<{ processed: boolean; error?: string; phaseError?: string }> = [];
let timeLeft = true;
let reconcileResult: { recovered: number; error?: string } | "throw" = { recovered: 2 };
mock.module("@/features/inbox/services/buffer.ts", {
  exports: {
    processNextBatch: async () => {
      processCalls.push(1);
      return queue.shift() ?? { processed: false };
    },
    reconcileOrphanedMessages: async () => {
      reconcileCalls++;
      if (reconcileResult === "throw") throw new Error("boom");
      return reconcileResult;
    },
    hasTimeToClaim: () => timeLeft,
  },
});

const { GET, maxDuration } = await import("./route.ts");

function req(auth?: string) {
  return new Request("http://localhost/api/cron/buffer-flush", {
    headers: auth ? { Authorization: auth } : {},
  });
}

test("fails closed when CRON_SECRET is not configured", async () => {
  delete process.env.CRON_SECRET;
  processCalls.length = 0;
  const res = await GET(req("Bearer undefined"));
  assert.equal(res.status, 401);
  assert.equal(processCalls.length, 0);
});

test("401 on a wrong or missing bearer", async () => {
  process.env.CRON_SECRET = "s3cret";
  processCalls.length = 0;
  assert.equal((await GET(req("Bearer nope"))).status, 401);
  assert.equal((await GET(req())).status, 401);
  assert.equal(processCalls.length, 0);
});

test("runs the drain with the right bearer", async () => {
  process.env.CRON_SECRET = "s3cret";
  processCalls.length = 0;
  const res = await GET(req("Bearer s3cret"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, processed: 0, recovered: 2, failed: 0 });
  assert.equal(processCalls.length, 1);
});

test("orphans are reconciled only for an authorized tick", async () => {
  delete process.env.CRON_SECRET;
  reconcileCalls = 0;
  await GET(req("Bearer undefined"));
  assert.equal(reconcileCalls, 0);
  process.env.CRON_SECRET = "s3cret";
  await GET(req("Bearer s3cret"));
  assert.equal(reconcileCalls, 1);
});

test("declares maxDuration below claim_next_batch's 7-minute lease", () => {
  assert.equal(maxDuration, 300);
});

test("a failed batch doesn't stop the drain; nothing left does", async () => {
  process.env.CRON_SECRET = "s3cret";
  processCalls.length = 0;
  timeLeft = true;
  queue = [{ processed: true }, { processed: false, error: "boom" }, { processed: true }];
  const res = await GET(req("Bearer s3cret"));
  assert.equal(processCalls.length, 4, "3 results, then an empty claim ends it");
  assert.equal(res.status, 200, "a failed batch is per-item work, not a failed tick");
  const body = await res.json();
  assert.equal(body.processed, 2);
  assert.equal(body.failed, 1);
});

test("no batch is claimed without time left to finish it", async () => {
  process.env.CRON_SECRET = "s3cret";
  processCalls.length = 0;
  timeLeft = false;
  queue = [{ processed: true }];
  await GET(req("Bearer s3cret"));
  assert.equal(processCalls.length, 0);
  timeLeft = true;
});

test("a claim that fails is a failed phase: 500 with its code, after what the tick did", async () => {
  process.env.CRON_SECRET = "s3cret";
  processCalls.length = 0;
  reconcileResult = { recovered: 2 };
  queue = [{ processed: true }, { processed: false, error: "rpc down", phaseError: "claim_failed" }, { processed: true }];
  const res = await GET(req("Bearer s3cret"));
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), {
    ok: false,
    processed: 1,
    recovered: 2,
    failed: 0,
    errors: ["claim_failed"],
  });
  assert.equal(processCalls.length, 2, "a failed claim stops the drain");
  queue = [];
});

test("a failed orphan lookup is a failed phase, and the drain still runs", async () => {
  process.env.CRON_SECRET = "s3cret";
  processCalls.length = 0;
  reconcileResult = { recovered: 0, error: "reconcile_failed" };
  queue = [{ processed: true }];
  const res = await GET(req("Bearer s3cret"));
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.deepEqual(body.errors, ["reconcile_failed"]);
  assert.equal(body.processed, 1);

  processCalls.length = 0;
  reconcileResult = "throw";
  queue = [{ processed: true }];
  const threw = await GET(req("Bearer s3cret"));
  assert.equal(threw.status, 500);
  const threwBody = await threw.json();
  assert.deepEqual(threwBody.errors, ["reconcile_threw"]);
  assert.equal(threwBody.processed, 1);
  assert.doesNotMatch(JSON.stringify(threwBody), /boom/, "codes only");
  reconcileResult = { recovered: 2 };
  queue = [];
});
