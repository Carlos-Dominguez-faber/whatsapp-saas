import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

const { resolveWorkspaceTimezone } = await import("./workspace-timezone.ts");
const { DEFAULT_TIMEZONE } = await import("@/shared/lib/timezone.ts");

type Res = { data: unknown; error: unknown };

/** A client whose two reads (business_info, integrations) return what's given. */
function db(business: Res, highlevel: Res) {
  return {
    from(table: string) {
      const res = table === "business_info" ? business : highlevel;
      const q = {
        select: () => q,
        eq: () => q,
        limit: () => q,
        maybeSingle: async () => res,
      };
      return q;
    },
  } as never;
}

const none: Res = { data: null, error: null };
const business = (timezone: string): Res => ({
  data: { structured: { timezone }, free_text: null },
  error: null,
});
const hl = (config: Record<string, unknown>): Res => ({ data: { config }, error: null });

test("the business's zone wins over HighLevel's", async () => {
  const tz = await resolveWorkspaceTimezone(
    db(business("America/Cancun"), hl({ timezone: "America/Santiago", timezone_source: "location" })),
    "ws_1",
  );
  assert.equal(tz, "America/Cancun");
});

test("without a business zone, HighLevel's location zone is used", async () => {
  const tz = await resolveWorkspaceTimezone(
    db(none, hl({ timezone: "America/Santiago", timezone_source: "location" })),
    "ws_1",
  );
  assert.equal(tz, "America/Santiago");
});

test("with neither, it's the default zone — never UTC by accident", async () => {
  const tz = await resolveWorkspaceTimezone(db(none, none), "ws_1");
  assert.equal(tz, DEFAULT_TIMEZONE);
  assert.notEqual(tz, "UTC");
});

test("a stored UTC not written by the location lookup doesn't count", async () => {
  const tz = await resolveWorkspaceTimezone(db(none, hl({ timezone: "UTC" })), "ws_1");
  assert.equal(tz, DEFAULT_TIMEZONE);
});

test("an invalid business zone falls through to the next one", async () => {
  const tz = await resolveWorkspaceTimezone(
    db(business("Santiago"), hl({ timezone: "America/Santiago", timezone_source: "location" })),
    "ws_1",
  );
  assert.equal(tz, "America/Santiago");
});

test("when the settings can't be read it returns null instead of guessing", async () => {
  const tz = await resolveWorkspaceTimezone(
    db({ data: null, error: { message: "db down" } }, none),
    "ws_1",
  );
  assert.equal(tz, null);
});
