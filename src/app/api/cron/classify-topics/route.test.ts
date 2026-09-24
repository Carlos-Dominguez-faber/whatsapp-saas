import assert from "node:assert/strict";
import { mock, test } from "node:test";

let phase1: () => Promise<unknown> = async () => ({ classified: 2, failed: 1, skipped_workspaces: 0 });
let phase2: () => Promise<unknown> = async () => ({ processed: 3, failed: 0, topics_done: 1 });
let order: string[] = [];

mock.module("@/features/analytics/services/classify-topics.ts", {
  exports: {
    runClassificationPhase: () => {
      order.push("classification");
      return phase1();
    },
    runBackfillPhase: () => {
      order.push("backfill");
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
  phase1 = async () => ({ classified: 2, failed: 1, skipped_workspaces: 0 });
  phase2 = async () => ({ processed: 3, failed: 0, topics_done: 1 });
}

test("presupuesto de tiempo menor que maxDuration", () => {
  assert.equal(maxDuration, 60);
  assert.ok(RUN_BUDGET_MS < maxDuration * 1000);
});

test("sin bearer o con bearer incorrecto → 401 sin correr fases", async () => {
  reset();
  assert.equal((await GET(req())).status, 401);
  assert.equal((await GET(req("Bearer otro"))).status, 401);
  assert.deepEqual(order, []);
});

test("éxito: fase 1 antes que la 2; failed > 0 sigue siendo 200", async () => {
  reset();
  const res = await GET(req("Bearer s3cret"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    ok: true,
    classified: { classified: 2, failed: 1, skipped_workspaces: 0 },
    backfill: { processed: 3, failed: 0, topics_done: 1 },
  });
  assert.deepEqual(order, ["classification", "backfill"]);
});

test("fase 1 con error sin halt (select_failed) → 500 ok:false, y la fase 2 igual corre", async () => {
  reset();
  phase1 = async () => ({ classified: 0, failed: 0, skipped_workspaces: 0, halt: false, error: "select_failed" });
  const res = await GET(req("Bearer s3cret"));
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.classified.error, "select_failed");
  assert.deepEqual(order, ["classification", "backfill"]);
  assert.equal(body.backfill.processed, 3);
});

test("fase 1 con halt (contabilidad rota) → 500 y la fase 2 NO corre", async () => {
  reset();
  // El código de error es irrelevante para la ruta: decide por `halt`.
  phase1 = async () => ({ classified: 0, failed: 1, skipped_workspaces: 0, halt: true, error: "cualquier_codigo" });
  const res = await GET(req("Bearer s3cret"));
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.deepEqual(order, ["classification"], "la fase 2 corrió (y pagó) después de un halt");
  assert.equal(body.backfill.error, "skipped_after_halt");
  assert.equal(body.backfill.processed, 0);
});

test("fase 1 que lanza → estado desconocido, la fase 2 NO corre", async () => {
  reset();
  phase1 = async () => {
    throw new Error("boom");
  };
  const res = await GET(req("Bearer s3cret"));
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.classified.error, "threw");
  assert.equal(body.classified.halt, true);
  assert.deepEqual(order, ["classification"]);
  assert.equal(body.backfill.error, "skipped_after_halt");
});

test("presupuesto no consultable → 500, no 200 con skipped_workspaces", async () => {
  reset();
  phase1 = async () => ({ classified: 0, failed: 0, skipped_workspaces: 0, halt: true, error: "budget_reserve_failed" });
  const res = await GET(req("Bearer s3cret"));
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.classified.error, "budget_reserve_failed");
});

test("fase que lanza → 500 ok:false con código, sin el mensaje crudo", async () => {
  reset();
  phase2 = async () => {
    throw new Error("connection string postgres://secret");
  };
  const res = await GET(req("Bearer s3cret"));
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.doesNotMatch(text, /secret/);
  assert.equal(JSON.parse(text).backfill.error, "threw");
});
