import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { applyMessageStatus } from "./message-status.ts";
import { parseWhatsAppError } from "./whatsapp-errors.ts";

type Row = {
  id: string;
  workspace_id: string;
  direction?: string;
  wamid: string | null;
  status: string | null;
  meta?: Record<string, unknown>;
  error_message?: string | null;
};

function field(row: Row, col: string): unknown {
  if (col.startsWith("meta->>")) return row.meta?.[col.slice("meta->>".length)];
  return (row as Record<string, unknown>)[col];
}

// In-memory messages table honouring every filter, like PostgREST, including
// the terminal-status guard in the UPDATE's WHERE.
function fakeDb(rows: Row[], opts: { lookupError?: string } = {}) {
  const updates: Array<{ id: unknown; patch: Record<string, unknown> }> = [];
  const errorRows: unknown[] = [];
  const client = {
    from: (table: string) => ({
      select: () => {
        const filters: Array<[string, unknown]> = [];
        const q: any = {
          eq: (col: string, val: unknown) => {
            filters.push([col, val]);
            return q;
          },
          filter: (col: string, _op: string, val: unknown) => {
            filters.push([col, val]);
            return q;
          },
          maybeSingle: async () => {
            if (opts.lookupError) return { data: null, error: { message: opts.lookupError } };
            const hits = rows.filter((r) => filters.every(([c, v]) => field(r, c) === v));
            return hits.length > 1
              ? { data: null, error: { message: "multiple rows" } }
              : { data: hits[0] ?? null, error: null };
          },
        };
        return q;
      },
      update: (patch: Record<string, unknown>) => {
        const filters: Array<[string, unknown]> = [];
        const q: any = {
          eq: (col: string, val: unknown) => {
            filters.push([col, val]);
            return q;
          },
          or: async () => {
            const hit = rows.find(
              (r) =>
                filters.every(([c, v]) => field(r, c) === v) &&
                r.status !== "failed",
            );
            if (hit) {
              updates.push({ id: hit.id, patch });
              Object.assign(hit, patch);
            }
            return { error: null };
          },
        };
        return q;
      },
      upsert: async (row: unknown) => {
        if (table === "message_errors") errorRows.push(row);
        return { error: null };
      },
    }),
  };
  return { client: client as unknown as SupabaseClient, updates, errorRows };
}

test("a status signed by workspace A never touches B's message with the same wamid", async () => {
  const { client, updates } = fakeDb([
    { id: "msg_b", workspace_id: "ws_b", wamid: "wamid.1", status: "sent" },
  ]);
  await applyMessageStatus(client, "ws_a", { wamid: "wamid.1", status: "failed" });
  assert.deepEqual(updates, []);
});

test("the verified workspace's own message advances", async () => {
  const { client, updates } = fakeDb([
    { id: "msg_a", workspace_id: "ws_a", wamid: "wamid.1", status: "sent" },
    { id: "msg_b", workspace_id: "ws_b", wamid: "wamid.1", status: "sent" },
  ]);
  await applyMessageStatus(client, "ws_a", { wamid: "wamid.1", status: "delivered" });
  assert.deepEqual(updates, [{ id: "msg_a", patch: { status: "delivered" } }]);
});

test("statuses never go backwards", async () => {
  const { client, updates } = fakeDb([
    { id: "msg_a", workspace_id: "ws_a", wamid: "wamid.1", status: "read" },
  ]);
  await applyMessageStatus(client, "ws_a", { wamid: "wamid.1", status: "delivered" });
  assert.deepEqual(updates, []);
});

test("'failed' is terminal: a late 'sent' does not resurrect it", async () => {
  const { client, updates } = fakeDb([
    { id: "msg_a", workspace_id: "ws_a", wamid: "wamid.1", status: "failed" },
  ]);
  await applyMessageStatus(client, "ws_a", { wamid: "wamid.1", status: "sent" });
  assert.deepEqual(updates, []);
});

test("'failed' applies over any other status, with the reason for the team", async () => {
  const { client, updates, errorRows } = fakeDb([
    { id: "msg_a", workspace_id: "ws_a", wamid: "wamid.1", status: "delivered" },
  ]);
  const error = parseWhatsAppError({ code: 131049, title: "ecosystem" });
  await applyMessageStatus(client, "ws_a", { wamid: "wamid.1", status: "failed", error });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].patch.status, "failed");
  assert.match(String(updates[0].patch.error_message), /24 horas/);
  assert.equal(errorRows.length, 1);
});

test("a YCloud row with no wamid yet is found by YCloud's id and gets its wamid", async () => {
  const rows: Row[] = [
    {
      id: "msg_yc",
      workspace_id: "ws_a",
      direction: "out",
      wamid: null,
      status: "sent",
      meta: { ycloud_id: "yc_123" },
    },
  ];
  const { client, updates } = fakeDb(rows);
  await applyMessageStatus(client, "ws_a", {
    wamid: "wamid.new",
    providerMessageId: "yc_123",
    status: "delivered",
  });
  assert.deepEqual(updates, [
    { id: "msg_yc", patch: { wamid: "wamid.new", status: "delivered" } },
  ]);

  // The next event matches by the backfilled wamid.
  await applyMessageStatus(client, "ws_a", {
    wamid: "wamid.new",
    providerMessageId: "yc_123",
    status: "read",
  });
  assert.equal(rows[0].status, "read");
});

test("YCloud's id is matched only inside the verified workspace", async () => {
  const { client, updates } = fakeDb([
    {
      id: "msg_b",
      workspace_id: "ws_b",
      direction: "out",
      wamid: null,
      status: "sent",
      meta: { ycloud_id: "yc_123" },
    },
  ]);
  await applyMessageStatus(client, "ws_a", {
    providerMessageId: "yc_123",
    status: "delivered",
  });
  assert.deepEqual(updates, []);
});

test("a database error throws, so the webhook answers 500 and the provider retries", async () => {
  const { client } = fakeDb([], { lookupError: "connection reset" });
  await assert.rejects(
    applyMessageStatus(client, "ws_a", { wamid: "wamid.1", status: "read" }),
    /lookup failed/,
  );
});
