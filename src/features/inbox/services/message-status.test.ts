import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { applyMessageStatus } from "./message-status.ts";

type Row = { id: string; workspace_id: string; wamid: string; status: string | null };

// In-memory messages table honouring every .eq() filter, like PostgREST.
function fakeDb(rows: Row[]) {
  const updates: Array<{ id: unknown; status: unknown }> = [];
  const client = {
    from: () => ({
      select: () => {
        const filters: Array<[string, unknown]> = [];
        const q: any = {
          eq: (col: string, val: unknown) => {
            filters.push([col, val]);
            return q;
          },
          maybeSingle: async () => {
            const hits = rows.filter((r) =>
              filters.every(([c, v]) => (r as Record<string, unknown>)[c] === v),
            );
            return hits.length > 1
              ? { data: null, error: { message: "multiple rows" } }
              : { data: hits[0] ?? null, error: null };
          },
        };
        return q;
      },
      update: (row: { status: unknown }) => ({
        eq: async (_col: string, id: unknown) => {
          updates.push({ id, status: row.status });
          return { error: null };
        },
      }),
    }),
  };
  return { client: client as unknown as SupabaseClient, updates };
}

test("a status signed by workspace A never touches B's message with the same wamid", async () => {
  const { client, updates } = fakeDb([
    { id: "msg_b", workspace_id: "ws_b", wamid: "wamid.1", status: "sent" },
  ]);
  await applyMessageStatus(client, "ws_a", "wamid.1", "failed");
  assert.deepEqual(updates, []);
});

test("the verified workspace's own message advances", async () => {
  const { client, updates } = fakeDb([
    { id: "msg_a", workspace_id: "ws_a", wamid: "wamid.1", status: "sent" },
    { id: "msg_b", workspace_id: "ws_b", wamid: "wamid.1", status: "sent" },
  ]);
  await applyMessageStatus(client, "ws_a", "wamid.1", "delivered");
  assert.deepEqual(updates, [{ id: "msg_a", status: "delivered" }]);
});

test("statuses never go backwards", async () => {
  const { client, updates } = fakeDb([
    { id: "msg_a", workspace_id: "ws_a", wamid: "wamid.1", status: "read" },
  ]);
  await applyMessageStatus(client, "ws_a", "wamid.1", "delivered");
  assert.deepEqual(updates, []);
});

test("'failed' is terminal: a late 'sent' does not resurrect it", async () => {
  const { client, updates } = fakeDb([
    { id: "msg_a", workspace_id: "ws_a", wamid: "wamid.1", status: "failed" },
  ]);
  await applyMessageStatus(client, "ws_a", "wamid.1", "sent");
  assert.deepEqual(updates, []);
});

test("'failed' applies over any other status", async () => {
  const { client, updates } = fakeDb([
    { id: "msg_a", workspace_id: "ws_a", wamid: "wamid.1", status: "delivered" },
  ]);
  await applyMessageStatus(client, "ws_a", "wamid.1", "failed");
  assert.deepEqual(updates, [{ id: "msg_a", status: "failed" }]);
});
