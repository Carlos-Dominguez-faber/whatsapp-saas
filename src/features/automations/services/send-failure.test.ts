import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordAutomationSendFailure } from "./send-failure.ts";

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
let inserts: Array<{ table: string; row: Row }>;
let failTable: string | null;

function client(): SupabaseClient {
  return {
    from: (table: string) => ({
      update: (patch: Row) => {
        const filters: Array<(r: Row) => boolean> = [];
        const apply = () => {
          if (failTable === table) return { data: null, error: { message: "connection refused" } };
          const hit = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
          hit.forEach((r) => Object.assign(r, patch));
          return { data: hit.map((r) => ({ ...r })), error: null };
        };
        const q: any = {
          eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
          in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), q),
          select: async () => apply(),
          then: (resolve: (v: unknown) => void) => resolve(apply()),
        };
        return q;
      },
      insert: async (row: Row) => {
        inserts.push({ table, row });
        return { error: null };
      },
    }),
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  failTable = null;
  inserts = [];
  tables = {
    automation_runs: [
      { id: "run_1", workspace_id: "ws_1", rule_id: "rule_1", conversation_id: "conv_1", status: "done", error: null },
    ],
    automation_rules: [
      { id: "rule_1", workspace_id: "ws_1", enabled: true, paused_reason: null },
    ],
  };
});

const META = { automation_run_id: "run_1", automation_rule_id: "rule_1" };

test("a paused template reported later fails the run and switches the rule off", async () => {
  await recordAutomationSendFailure(client(), "ws_1", META, 132015);
  assert.equal(tables.automation_runs[0].status, "failed");
  assert.equal(tables.automation_runs[0].error, "template_paused");
  assert.deepEqual(
    { enabled: tables.automation_rules[0].enabled, reason: tables.automation_rules[0].paused_reason },
    { enabled: false, reason: "template_paused" },
  );
  assert.equal(inserts[0].row.type, "automation_failed");
});

test("any other late failure (131026) fails the run as send_rejected and keeps the rule on", async () => {
  await recordAutomationSendFailure(client(), "ws_1", META, 131026);
  assert.equal(tables.automation_runs[0].error, "send_rejected");
  assert.equal(tables.automation_rules[0].enabled, true);
});

test("another workspace's status never touches this run or rule", async () => {
  await recordAutomationSendFailure(client(), "ws_other", META, 132015);
  assert.equal(tables.automation_runs[0].status, "done");
  assert.equal(tables.automation_rules[0].enabled, true);
});

test("a message no automation sent is ignored", async () => {
  await recordAutomationSendFailure(client(), "ws_1", { template_name: "x" }, 132015);
  assert.equal(tables.automation_runs[0].status, "done");
  assert.equal(inserts.length, 0);
});

test("a run already waiting for a retry is left alone", async () => {
  tables.automation_runs[0].status = "pending";
  await recordAutomationSendFailure(client(), "ws_1", META, 131026);
  assert.equal(tables.automation_runs[0].status, "pending");
});

test("a database error throws, so the webhook answers 500 and the status comes again", async () => {
  failTable = "automation_runs";
  await assert.rejects(() => recordAutomationSendFailure(client(), "ws_1", META, 131026));
});
