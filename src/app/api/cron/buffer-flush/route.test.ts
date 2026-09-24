import assert from "node:assert/strict";
import { test, mock } from "node:test";

const processCalls: number[] = [];
mock.module("@/features/inbox/services/buffer.ts", {
  exports: {
    processNextBatch: async () => {
      processCalls.push(1);
      return { processed: false };
    },
    reconcileOrphanedMessages: async () => 0,
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
  assert.deepEqual(await res.json(), { ok: true, processed: 0, recovered: 0 });
  assert.equal(processCalls.length, 1);
});

test("declares a maxDuration long enough for 10 LLM turns", () => {
  assert.equal(maxDuration, 300);
});
