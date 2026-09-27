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

/**
 * PostgREST's `or=(…)` for the forms the app uses: `col.is.null`,
 * `col.eq.v`, `col.neq.v`, `col.in.(a,b)`. Honoring it is the point: a wrong
 * guard in the code has to make the fake miss, as the real database would.
 */
function orFilter(expr: string): (r: Record<string, unknown>) => boolean {
  const conds: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of expr) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      conds.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  conds.push(current);
  const tests = conds.map((cond) => {
    const [col, op, ...rest] = cond.split(".");
    const value = rest.join(".");
    switch (op) {
      case "is":
        assert.equal(value, "null", `unsupported is.${value}`);
        return (r: Record<string, unknown>) => r[col] == null;
      case "eq":
        return (r: Record<string, unknown>) => String(r[col]) === value;
      case "neq":
        return (r: Record<string, unknown>) => r[col] != null && String(r[col]) !== value;
      case "in": {
        const set = value.replace(/^\(|\)$/g, "").split(",");
        return (r: Record<string, unknown>) => r[col] != null && set.includes(String(r[col]));
      }
      default:
        throw new Error(`unsupported or() operator: ${op}`);
    }
  });
  return (r) => tests.some((t) => t(r));
}

function field(row: Row, col: string): unknown {
  return (row as Record<string, unknown>)[col];
}

// In-memory messages table honouring every filter, like PostgREST.
function fakeDb(
  rows: Row[],
  opts: { lookupError?: string; afterSelect?: () => void } = {},
) {
  const updates: Array<{ id: unknown; patch: Record<string, unknown> }> = [];
  const errorRows: unknown[] = [];
  const client = {
    from: (table: string) => ({
      select: () => {
        const filters: Array<(r: Row) => boolean> = [];
        let limit = Infinity;
        const q: any = {
          eq: (col: string, val: unknown) => (filters.push((r) => field(r, col) === val), q),
          contains: (col: string, val: Record<string, unknown>) => (
            filters.push((r) =>
              Object.entries(val).every(
                ([k, v]) => ((field(r, col) ?? {}) as Record<string, unknown>)[k] === v,
              ),
            ),
            q
          ),
          limit: (n: number) => ((limit = n), q),
          then: (resolve: (v: unknown) => void) => {
            // Rows come back as copies: what the caller read, not live rows.
            const result = opts.lookupError
              ? { data: null, error: { message: opts.lookupError } }
              : {
                  data: rows
                    .filter((r) => filters.every((f) => f(r)))
                    .slice(0, limit)
                    .map((r) => structuredClone(r)),
                  error: null,
                };
            opts.afterSelect?.();
            resolve(result);
          },
        };
        return q;
      },
      update: (patch: Record<string, unknown>) => {
        const filters: Array<(r: Row) => boolean> = [];
        const q: any = {
          eq: (col: string, val: unknown) => (filters.push((r) => field(r, col) === val), q),
          is: (col: string, val: null) => (filters.push((r) => field(r, col) == val), q),
          or: (expr: string) => (filters.push(orFilter(expr) as (r: Row) => boolean), q),
          then: (resolve: (v: unknown) => void) => {
            const hit = rows.find((r) => filters.every((f) => f(r)));
            if (hit) {
              updates.push({ id: hit.id, patch });
              Object.assign(hit, patch);
            }
            resolve({ error: null });
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

test("racing webhooks can't move 'read' back to 'delivered' (the guard is in the WHERE)", async () => {
  const row: Row = { id: "msg_a", workspace_id: "ws_a", wamid: "wamid.1", status: "sent" };
  // 'delivered' reads the row as 'sent'; before its UPDATE, 'read' commits.
  const { client, updates } = fakeDb([row], {
    afterSelect: () => {
      row.status = "read";
    },
  });
  await applyMessageStatus(client, "ws_a", { wamid: "wamid.1", status: "delivered" });
  assert.equal(row.status, "read");
  assert.deepEqual(updates, [], "the guarded UPDATE matched nothing");
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
    { id: "msg_yc", patch: { wamid: "wamid.new" } },
    { id: "msg_yc", patch: { status: "delivered" } },
  ]);

  // The next event matches by the backfilled wamid.
  await applyMessageStatus(client, "ws_a", {
    wamid: "wamid.new",
    providerMessageId: "yc_123",
    status: "read",
  });
  assert.equal(rows[0].status, "read");
});

test("a status that doesn't move still backfills the wamid", async () => {
  const rows: Row[] = [
    { id: "msg_yc", workspace_id: "ws_a", direction: "out", wamid: null, status: "read", meta: { ycloud_id: "yc_1" } },
  ];
  const { client } = fakeDb(rows);
  await applyMessageStatus(client, "ws_a", { wamid: "wamid.x", providerMessageId: "yc_1", status: "sent" });
  assert.equal(rows[0].wamid, "wamid.x");
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
