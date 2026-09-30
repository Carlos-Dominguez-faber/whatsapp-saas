import assert from "node:assert/strict";
import { test } from "node:test";
import { listAutomationRuns, parseCursor, parseRunFilter, RUNS_PAGE_SIZE } from "./run-list.ts";

function fakeDb(rows: unknown[]) {
  const seen: Array<[string, ...unknown[]]> = [];
  const q: any = {
    select: (s: string) => (seen.push(["select", s]), q),
    eq: (c: string, v: unknown) => (seen.push(["eq", c, v]), q),
    in: (c: string, v: unknown) => (seen.push(["in", c, v]), q),
    or: (f: string) => (seen.push(["or", f]), q),
    order: (c: string) => (seen.push(["order", c]), q),
    limit: async (n: number) => (seen.push(["limit", n]), { data: rows, error: null }),
  };
  return { db: { from: (t: string) => (seen.push(["from", t]), q) } as never, seen };
}

test("reads the workspace's runs, newest first, a page at a time", async () => {
  const { db, seen } = fakeDb([]);
  await listAutomationRuns(db, "ws_1", { filter: "all", before: null });
  assert.deepEqual(seen.filter(([k]) => k === "eq"), [["eq", "workspace_id", "ws_1"]]);
  assert.deepEqual(seen.filter(([k]) => k === "order"), [["order", "created_at"], ["order", "id"]]);
  assert.deepEqual(seen.at(-1), ["limit", RUNS_PAGE_SIZE]);
});

test("filters by status; 'pending' includes runs in progress", async () => {
  const failed = fakeDb([]);
  const before = { at: "2026-10-01T00:00:00.123456+00:00", id: "0b6c1f0e-1111-4222-8333-444455556666" };
  await listAutomationRuns(failed.db, "ws_1", { filter: "failed", before });
  assert.ok(failed.seen.some(([k, c, v]) => k === "eq" && c === "status" && v === "failed"));
  // Runs sharing the last one's timestamp continue by id, not skipped.
  assert.ok(failed.seen.some(([k, f]) => k === "or" && f ===
    "created_at.lt.2026-10-01T00:00:00.123456+00:00,and(created_at.eq.2026-10-01T00:00:00.123456+00:00,id.lt.0b6c1f0e-1111-4222-8333-444455556666)"));
  const pending = fakeDb([]);
  await listAutomationRuns(pending.db, "ws_1", { filter: "pending", before: null });
  assert.ok(pending.seen.some(([k, c, v]) => k === "in" && c === "status" && JSON.stringify(v) === '["pending","processing"]'));
});

test("a full page hands back a cursor; a short one ends the list", async () => {
  const full = Array.from({ length: RUNS_PAGE_SIZE }, (_, i) => ({ id: `r${i}`, created_at: `2026-10-01T00:00:${String(59 - (i % 60)).padStart(2, "0")}Z` }));
  assert.deepEqual((await listAutomationRuns(fakeDb(full).db, "ws_1", { filter: "all", before: null })).nextBefore, {
    at: full.at(-1)!.created_at,
    id: full.at(-1)!.id,
  });
  assert.equal((await listAutomationRuns(fakeDb(full.slice(0, 3)).db, "ws_1", { filter: "all", before: null })).nextBefore, null);
});

test("query parameters are checked before they reach a filter", () => {
  assert.equal(parseRunFilter("failed"), "failed");
  assert.equal(parseRunFilter("status.eq.done"), "all");
  assert.equal(parseRunFilter(null), "all");
  const id = "0b6c1f0e-1111-4222-8333-444455556666";
  assert.deepEqual(parseCursor("2026-10-01T12:00:00.123456+00:00", id), { at: "2026-10-01T12:00:00.123456+00:00", id });
  assert.equal(parseCursor("not-a-date),id.gt.0", id), null);
  assert.equal(parseCursor("2026-10-01T12:00:00Z", "x),id.gt.(0"), null);
  assert.equal(parseCursor(null, id), null);
  assert.equal(parseCursor("2026-10-01T12:00:00Z", null), null);
});
