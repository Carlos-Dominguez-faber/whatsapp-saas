import assert from "node:assert/strict";
import { test, mock, beforeEach } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";

const calls: Array<{ workspaceId: string; meta: unknown; code: number | null }> = [];
const order: string[] = [];
mock.module("@/features/automations/services/send-failure.ts", {
  exports: {
    recordAutomationSendFailure: async (
      _db: unknown,
      workspaceId: string,
      meta: unknown,
      code: number | null,
    ) => {
      order.push("automation");
      calls.push({ workspaceId, meta, code });
    },
  },
});

const { applyMessageStatus } = await import("./message-status.ts");
const { parseWhatsAppError } = await import("./whatsapp-errors.ts");

let row: Record<string, unknown>;

function client(): SupabaseClient {
  return {
    from: () => ({
      select: () => {
        const q: any = {
          eq: () => q,
          limit: () => q,
          then: (resolve: (v: unknown) => void) => resolve({ data: [{ ...row }], error: null }),
        };
        return q;
      },
      update: (patch: Record<string, unknown>) => {
        const q: any = {
          eq: () => q,
          or: () => q,
          is: () => q,
          then: (resolve: (v: unknown) => void) => {
            order.push("message");
            Object.assign(row, patch);
            resolve({ error: null });
          },
        };
        return q;
      },
      upsert: async () => ({ error: null }),
    }),
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  calls.length = 0;
  order.length = 0;
  row = {
    id: "msg_1",
    workspace_id: "ws_1",
    wamid: "wamid.1",
    status: "sent",
    meta: { automation_run_id: "run_1", automation_rule_id: "rule_1" },
  };
});

test("a late failure of an automation's template reaches the automation, before the message update", async () => {
  const error = parseWhatsAppError({ code: 132015, title: "paused" });
  await applyMessageStatus(client(), "ws_1", { wamid: "wamid.1", status: "failed", error });
  assert.deepEqual(calls, [
    { workspaceId: "ws_1", meta: { automation_run_id: "run_1", automation_rule_id: "rule_1" }, code: 132015 },
  ]);
  assert.deepEqual(order, ["automation", "message"]);
});

test("a delivered status, or a message already failed, does not", async () => {
  await applyMessageStatus(client(), "ws_1", { wamid: "wamid.1", status: "delivered" });
  row.status = "failed";
  await applyMessageStatus(client(), "ws_1", { wamid: "wamid.1", status: "failed" });
  assert.equal(calls.length, 0);
});
