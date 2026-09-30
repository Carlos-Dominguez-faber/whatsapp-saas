import assert from "node:assert/strict";
import { mock, test } from "node:test";

let phase1: () => Promise<unknown> = async () => ({ classified: 2, failed: 1, skipped_workspaces: 0 });
let phase2: () => Promise<unknown> = async () => ({ processed: 3, failed: 0, topics_done: 1 });
let order: string[] = [];
const deadlines: Record<string, number[]> = { backfill: [], classification: [] };
const guardsSeen: unknown[] = [];

mock.module("@/features/analytics/services/classify-topics.ts", {
  exports: {
    BACKFILL_SHARE_MS: 55_000,
    LEASE_SECONDS: 180,
    newRunGuards: () => ({ marker: Math.random() }),
    runClassificationPhase: (deadline: number, _db: unknown, guards: unknown) => {
      order.push("classification");
      deadlines.classification.push(deadline);
      guardsSeen.push(guards);
      return phase1();
    },
    runBackfillPhase: (deadline: number, _db: unknown, guards: unknown) => {
      order.push("backfill");
      deadlines.backfill.push(deadline);
      guardsSeen.push(guards);
      return phase2();
    },
  },
});

const { GET, RUN_BUDGET_MS, maxDuration } = await import("./route.ts");

const req = (auth?: string) =>
  new Request("http://localhost:3000/api/cron/classify-topics", {
    headers: auth ? { Authorization: auth } : {},
  });

function reset() {
  process.env.CRON_SECRET = "s3cret";
  order = [];
  deadlines.backfill = [];
  deadlines.classification = [];
  guardsSeen.length = 0;
  phase1 = async () => ({ classified: 2, failed: 1, skipped_workspaces: 0 });
  phase2 = async () => ({ processed: 3, failed: 0, topics_done: 1 });
}

test("presupuesto de tiempo menor que maxDuration, y este menor que el lease", () => {
  assert.equal(maxDuration, 120);
  assert.ok(RUN_BUDGET_MS < maxDuration * 1000);
  assert.ok(maxDuration < 180, "a run could outlive its own lease");
});

test("TURNS: the backfill runs first with its own cut; phase 1 gets the rest; both share the guards", async () => {
  reset();
  const t0 = Date.now();
  await GET(req("Bearer s3cret"));
  assert.deepEqual(order, ["backfill", "classification"]);
  assert.ok(Math.abs(deadlines.backfill[0] - t0 - 55_000) < 1_000);
  assert.ok(Math.abs(deadlines.classification[0] - t0 - RUN_BUDGET_MS) < 1_000);
  assert.equal(guardsSeen[0], guardsSeen[1], "the phases got different guards");
});

test("sin bearer o con bearer incorrecto → 401 sin correr fases", async () => {
  reset();
  assert.equal((await GET(req())).status, 401);
  assert.equal((await GET(req("Bearer otro"))).status, 401);
  assert.deepEqual(order, []);
});

test("éxito: failed > 0 sigue siendo 200", async () => {
  reset();
  const res = await GET(req("Bearer s3cret"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    ok: true,
    classified: { classified: 2, failed: 1, skipped_workspaces: 0 },
    backfill: { processed: 3, failed: 0, topics_done: 1 },
  });
});

test("error sin halt → 500 ok:false, y la otra fase igual corre", async () => {
  reset();
  phase1 = async () => ({ classified: 0, failed: 0, skipped_workspaces: 0, halt: false, error: "select_failed" });
  const res = await GET(req("Bearer s3cret"));
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.classified.error, "select_failed");
  assert.deepEqual(order, ["backfill", "classification"]);
});

test("backfill con halt (breaker, base caída) → 500 y la fase 1 NO corre", async () => {
  reset();
  // El código de error es irrelevante para la ruta: decide por `halt`.
  phase2 = async () => ({ processed: 0, failed: 0, topics_done: 0, halt: true, error: "cualquier_codigo" });
  const res = await GET(req("Bearer s3cret"));
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.deepEqual(order, ["backfill"], "phase 1 ran (and paid) after a halt");
  assert.equal(body.classified.error, "skipped_after_halt");
  assert.equal(body.classified.classified, 0);
});

test("fase que lanza → estado desconocido, 500 ok:false con código, sin el mensaje crudo", async () => {
  reset();
  phase2 = async () => {
    throw new Error("connection string postgres://secret");
  };
  const res = await GET(req("Bearer s3cret"));
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.doesNotMatch(text, /secret/);
  const body = JSON.parse(text);
  assert.equal(body.backfill.error, "threw");
  assert.equal(body.backfill.halt, true);
  assert.deepEqual(order, ["backfill"]);
  assert.equal(body.classified.error, "skipped_after_halt");

  reset();
  phase1 = async () => {
    throw new Error("boom");
  };
  const res2 = await GET(req("Bearer s3cret"));
  assert.equal(res2.status, 500);
  assert.equal((await res2.json()).classified.error, "threw");
});
