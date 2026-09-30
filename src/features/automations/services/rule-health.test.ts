import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadAutomationHealth } from "./rule-health.ts";

function fake(opts: {
  perRule?: unknown[];
  capCount?: number;
  unknownCount?: number;
  rpcError?: string;
}) {
  const rpcCalls: unknown[] = [];
  const countFilters: Array<Array<[string, unknown]>> = [];
  const db = {
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      return opts.rpcError
        ? { data: null, error: { message: opts.rpcError } }
        : { data: opts.perRule ?? [], error: null };
    },
    from: () => ({
      select: () => {
        const filters: Array<[string, unknown]> = [];
        const q: any = {
          eq: (c: string, v: unknown) => (filters.push([c, v]), q),
          gt: (c: string, v: unknown) => (filters.push([`>${c}`, v]), q),
          then: (resolve: (v: unknown) => void) => {
            countFilters.push(filters);
            const isCap = filters.some(([c, v]) => c === "error" && v === "daily_cap");
            resolve({ count: isCap ? (opts.capCount ?? 0) : (opts.unknownCount ?? 0), error: null });
          },
        };
        return q;
      },
    }),
  } as unknown as SupabaseClient;
  return { db, rpcCalls, countFilters };
}

test("per-rule health comes from the workspace's own rules, with both warnings", async () => {
  const { db, rpcCalls, countFilters } = fake({
    perRule: [
      { rule_id: "r1", last_status: "failed", last_error: "send_rejected", last_finished_at: "2026-10-01T10:00:00Z", failures_24h: 2 },
    ],
    capCount: 3,
    unknownCount: 1,
  });
  const health = await loadAutomationHealth(db, "ws_1");
  assert.deepEqual(rpcCalls, [{ fn: "automation_rule_health", args: { p_workspace_id: "ws_1" } }]);
  assert.ok(countFilters.every((f) => f.some(([c, v]) => c === "workspace_id" && v === "ws_1")));
  assert.deepEqual(health, {
    rules: {
      r1: { lastStatus: "failed", lastError: "send_rejected", lastFinishedAt: "2026-10-01T10:00:00Z", failures24h: 2 },
    },
    dailyCapHit: true,
    outcomeUnknown24h: 1,
  });
});

test("a failed read gives null, so the tab still loads its rules", async () => {
  const { db } = fake({ rpcError: "function does not exist" });
  const errorMock = (await import("node:test")).mock.method(console, "error", () => {});
  try {
    assert.equal(await loadAutomationHealth(db, "ws_1"), null);
  } finally {
    errorMock.mock.restore();
  }
});
