import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";

import { isPhoneOptedOut, manualOptInFields, phoneKey } from "./opt-out.ts";

test("a phone's key is its digits, however it was written", () => {
  assert.equal(phoneKey("+52 1 (998) 123-4567"), "5219981234567");
  assert.equal(phoneKey("5219981234567"), "5219981234567");
  assert.equal(phoneKey(""), null);
  assert.equal(phoneKey(null), null);
});

function suppressions(rows: Array<{ workspace_id: string; phone_key: string }>, error?: { code?: string; message: string }) {
  return {
    from: () => ({
      select: () => {
        const filters: Array<[string, unknown]> = [];
        const q: any = {
          eq: (c: string, v: unknown) => (filters.push([c, v]), q),
          limit: async () =>
            error
              ? { data: null, error }
              : { data: rows.filter((r) => filters.every(([c, v]) => (r as Record<string, unknown>)[c] === v)), error: null },
        };
        return q;
      },
    }),
  } as unknown as SupabaseClient;
}

test("a suppressed phone is opted out in its workspace only, whatever its format", async () => {
  const db = suppressions([{ workspace_id: "ws_1", phone_key: "5215550001111" }]);
  assert.equal(await isPhoneOptedOut(db, "ws_1", "+52 1 555 000 1111"), true);
  assert.equal(await isPhoneOptedOut(db, "ws_2", "+5215550001111"), false);
  assert.equal(await isPhoneOptedOut(db, "ws_1", "+5215550002222"), false);
});

test("a failed lookup throws (callers fail closed); a missing table reads as not suppressed", async () => {
  await assert.rejects(() => isPhoneOptedOut(suppressions([], { message: "connection refused" }), "ws_1", "+1555"));
  const errorMock = (await import("node:test")).mock.method(console, "error", () => {});
  try {
    assert.equal(
      await isPhoneOptedOut(suppressions([], { code: "42P01", message: "missing" }), "ws_1", "+1555"),
      false,
    );
  } finally {
    errorMock.mock.restore();
  }
});

test("a manual opt-out is explicit; a manual opt-in clears it; no change writes nothing", () => {
  const out = manualOptInFields(false);
  assert.equal(out.opt_in, false);
  assert.equal(typeof out.opted_out_at, "string");

  const back = manualOptInFields(true);
  assert.equal(back.opt_in, true);
  assert.equal(back.opted_out_at, null);
  assert.equal(typeof back.opt_in_at, "string");

  assert.deepEqual(manualOptInFields(undefined), {});
});
