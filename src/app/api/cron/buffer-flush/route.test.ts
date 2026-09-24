import assert from "node:assert/strict";
import { test, mock } from "node:test";

const processCalls: number[] = [];
/** Next return value of processNextBatch(), so the error path is reachable. */
let nextResult: { processed: boolean; error?: string; phaseError?: string } = {
  processed: false,
};
let reconcileShouldThrow = false;
/** Phase-failure code reconcileOrphanedMessages reports back. */
let reconcileResult: { recovered: number; error?: string } = { recovered: 0 };
mock.module("@/features/inbox/services/buffer.ts", {
  exports: {
    processNextBatch: async () => {
      processCalls.push(1);
      return nextResult;
    },
    reconcileOrphanedMessages: async () => {
      if (reconcileShouldThrow) throw new Error("connection refused to the database");
      return reconcileResult;
    },
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
  nextResult = { processed: false };
  reconcileShouldThrow = false;
  reconcileResult = { recovered: 0 };
  const res = await GET(req("Bearer s3cret"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, processed: 0, recovered: 0, failed: 0 });
  assert.equal(processCalls.length, 1);
});

test("a batch that came back with an error is counted, not swallowed", async () => {
  process.env.CRON_SECRET = "s3cret";
  processCalls.length = 0;
  reconcileShouldThrow = false;
  reconcileResult = { recovered: 0 };
  nextResult = { processed: false, error: "Batch cancelled after 3 retries: boom" };
  const res = await GET(req("Bearer s3cret"));
  // A failed batch is a per-item failure (twin of executed.failed in
  // cron/automations), so the tick itself is still 200 — but it must not look
  // identical to "there was nothing to do".
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.equal(body.failed, 1);
  assert.equal(body.processed, 0);
  assert.ok(
    !JSON.stringify(body).includes("boom"),
    "the raw error text belongs in the server log, not in the response",
  );
});

test("a claim RPC that ERRORS instead of throwing answers 500 with claim_failed, keeping the tally", async () => {
  process.env.CRON_SECRET = "s3cret";
  processCalls.length = 0;
  reconcileShouldThrow = false;
  reconcileResult = { recovered: 2 };
  nextResult = { processed: false, error: "db down", phaseError: "claim_failed" };
  const res = await GET(req("Bearer s3cret"));
  // Counting this as `failed: 1` on a 200 {ok:true} would let a tick that
  // could not get any work sign as healthy, so the queue would grow with the
  // monitor green.
  assert.equal(res.status, 500);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.ok, false);
  assert.equal(body.error, "claim_failed");
  assert.equal(body.failed, 0, "a dead claim is not a per-item failure");
  assert.equal(body.recovered, 2, "what the tick DID do is kept in the body");
  assert.ok(
    !JSON.stringify(body).includes("db down"),
    "the PostgREST text belongs in the server log, not in the response",
  );
});

test("a failing reconcile lookup answers 500 with reconcile_failed, and the drain still runs", async () => {
  process.env.CRON_SECRET = "s3cret";
  processCalls.length = 0;
  reconcileShouldThrow = false;
  reconcileResult = { recovered: 0, error: "reconcile_failed" };
  nextResult = { processed: true };
  const res = await GET(req("Bearer s3cret"));
  assert.equal(res.status, 500);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.ok, false);
  assert.equal(body.error, "reconcile_failed");
  // Reporting the failure as DATA instead of throwing is what keeps the drain
  // alive: the two phases are independent.
  assert.equal(processCalls.length, 10, "the drain phase still consumed its budget");
  assert.equal(body.processed, 10);
});

test("if a phase throws, the tick answers 500 with ok:false and a code", async () => {
  process.env.CRON_SECRET = "s3cret";
  processCalls.length = 0;
  nextResult = { processed: false };
  reconcileResult = { recovered: 0 };
  reconcileShouldThrow = true;
  const res = await GET(req("Bearer s3cret"));
  // Without the status flip this would be a 200 + ok:true on a tick that drained
  // nothing — the same false green cron/automations guards against.
  assert.equal(res.status, 500);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.ok, false);
  assert.equal(body.error, "tick_threw");
  assert.equal(processCalls.length, 0, "reconcile threw before the drain loop");
  assert.ok(
    !JSON.stringify(body).includes("connection refused"),
    "the response cannot expose the raw exception message",
  );
  reconcileShouldThrow = false;
});

test("declares a maxDuration long enough for 10 LLM turns", () => {
  assert.equal(maxDuration, 300);
});
