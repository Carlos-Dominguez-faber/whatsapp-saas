import assert from "node:assert/strict";
import { test, mock, beforeEach } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";

let role: "admin" | "manager" | "agent" = "agent";
const roleChecks: Array<{ workspaceId: string; minRole?: string }> = [];
mock.module("@/lib/auth/workspace-access.ts", {
  exports: {
    checkWorkspaceMember: async (workspaceId: string, opts?: { minRole?: string }) => {
      roleChecks.push({ workspaceId, minRole: opts?.minRole });
      const rank = { agent: 1, manager: 2, admin: 3 };
      const need = opts?.minRole ? rank[opts.minRole as keyof typeof rank] : 0;
      return rank[role] >= need
        ? { ok: true, userId: "user_1", role }
        : { ok: false, status: 403, reason: "insufficient_role" };
    },
  },
});

const { applyContactUpdate, OPT_IN_OVERRIDE_DENIED, CONTACT_CHANGED } = await import(
  "./contact-update.ts"
);

let stored: Record<string, unknown>;
/** Written by someone else between our read and our UPDATE. */
let landedMeanwhile: Record<string, unknown>;
let writes: Array<Record<string, unknown>>;

function client(): SupabaseClient {
  return {
    from: () => ({
      select: () => {
        const q: any = { eq: () => q, maybeSingle: async () => ({ data: stored, error: null }) };
        return q;
      },
      update: (row: Record<string, unknown>) => {
        const filters: Array<[string, unknown]> = [];
        const q: any = {
          eq: (c: string, v: unknown) => (filters.push([c, v]), q),
          is: (c: string, v: unknown) => (filters.push([c, v]), q),
          select: () => q,
          single: async () => {
            // What the database holds when the UPDATE runs (a STOP may have landed).
            const now = { ...stored, ...landedMeanwhile };
            if (!filters.every(([c, v]) => (now[c] ?? null) === v)) {
              return { data: null, error: { code: "PGRST116", message: "0 rows" } };
            }
            writes.push(row);
            return { data: { ...now, ...row }, error: null };
          },
        };
        return q;
      },
    }),
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  role = "agent";
  roleChecks.length = 0;
  writes = [];
  landedMeanwhile = {};
  stored = { id: "ct_1", workspace_id: "ws_1", opt_in: true, opted_out_at: null };
});

test("a save that doesn't touch opt_in leaves it alone", async () => {
  const res = await applyContactUpdate(client(), "ct_1", { name: "Ana" });
  assert.equal(res.ok, true);
  assert.equal("opt_in" in writes[0], false);
  assert.equal("opted_out_at" in writes[0], false);
});

test("a stale opt_in equal to the stored value writes nothing about it", async () => {
  stored = { ...stored, opt_in: false, opted_out_at: "2026-10-01T10:00:00Z" };
  const res = await applyContactUpdate(client(), "ct_1", { name: "Ana", opt_in: false });
  assert.equal(res.ok, true);
  assert.equal("opted_out_at" in writes[0], false, "the STOP's timestamp is kept");
});

test("an agent cannot undo a STOP, even with a stale form that sends opt_in true", async () => {
  stored = { ...stored, opt_in: false, opted_out_at: "2026-10-01T10:00:00Z" };
  const res = await applyContactUpdate(client(), "ct_1", { name: "Ana", opt_in: true });
  assert.deepEqual(res, { ok: false, status: 403, error: OPT_IN_OVERRIDE_DENIED });
  assert.equal(writes.length, 0);
  assert.deepEqual(roleChecks, [{ workspaceId: "ws_1", minRole: "manager" }]);
});

test("a manager can opt the contact back in, which clears the opt-out", async () => {
  role = "manager";
  stored = { ...stored, opt_in: false, opted_out_at: "2026-10-01T10:00:00Z" };
  const res = await applyContactUpdate(client(), "ct_1", { opt_in: true });
  assert.equal(res.ok, true);
  assert.equal(writes[0].opt_in, true);
  assert.equal(writes[0].opted_out_at, null);
});

test("any member can opt a contact out by hand, which counts as explicit", async () => {
  const res = await applyContactUpdate(client(), "ct_1", { opt_in: false });
  assert.equal(res.ok, true);
  assert.equal(writes[0].opt_in, false);
  assert.equal(typeof writes[0].opted_out_at, "string");
  assert.equal(roleChecks.length, 0);
});

test("opting in a contact who never opted out needs no manager", async () => {
  stored = { ...stored, opt_in: false, opted_out_at: null };
  const res = await applyContactUpdate(client(), "ct_1", { opt_in: true });
  assert.equal(res.ok, true);
  assert.equal(roleChecks.length, 0);
});

test("a STOP that lands while a manager's opt-in is in flight is not cleared by it", async () => {
  role = "manager";
  stored = { ...stored, opt_in: false, opted_out_at: null }; // never opted in
  landedMeanwhile = { opted_out_at: "2026-10-01T10:00:00Z" }; // the contact writes STOP
  const res = await applyContactUpdate(client(), "ct_1", { opt_in: true });
  assert.deepEqual(res, { ok: false, status: 409, error: CONTACT_CHANGED });
  assert.equal(writes.length, 0);
});
