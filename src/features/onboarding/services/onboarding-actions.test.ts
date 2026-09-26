import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

mock.module("@/lib/supabase/server.ts", {
  exports: {
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: { id: "user_1" } }, error: null }) },
    }),
  },
});

mock.module("@/shared/lib/integration-secrets.ts", {
  exports: { encryptCredentials: async (c: unknown) => c },
});

// Service-role client: answers the gate's profile read from the fixtures below
// (recording its filters) and records every write.
let profile: { is_super_admin: boolean } | null = null;
let profileError: { message: string } | null = null;
let profileFilters: unknown[][] = [];
let inserts: string[] = [];

function writeChain(): any {
  const c: any = {
    select: () => c,
    eq: () => c,
    single: async () => ({ data: { id: "new_id" }, error: null }),
    then: (resolve: (v: unknown) => void) => resolve({ error: null }),
  };
  return c;
}

mock.module("@supabase/supabase-js", {
  exports: {
    createClient: () => ({
      from: (table: string) => ({
        select: () => {
          const c: any = {
            eq: (col: string, val: unknown) => {
              if (table === "users") profileFilters.push([col, val]);
              return c;
            },
            maybeSingle: async () => ({ data: profile, error: profileError }),
          };
          return c;
        },
        insert: () => {
          inserts.push(table);
          return writeChain();
        },
        update: () => writeChain(),
        delete: () => writeChain(),
      }),
    }),
  },
});

const { completeOnboarding } = await import("./onboarding-actions.ts");

const input = { useCase: "general", businessName: "Acme" };

function reset(p: typeof profile, err: typeof profileError = null) {
  profile = p;
  profileError = err;
  profileFilters = [];
  inserts = [];
}

test("a non-super-admin cannot mint a workspace, whatever their memberships", async () => {
  // Covers the viewer, the deactivated ex-member and the client whose
  // workspace was deleted (zero memberships left).
  reset({ is_super_admin: false });
  const result = await completeOnboarding(input);
  assert.ok("error" in result && result.error);
  assert.equal(inserts.length, 0, "nothing may be created");
});

test("an account without a profile row is refused", async () => {
  reset(null);
  const result = await completeOnboarding(input);
  assert.ok("error" in result && result.error);
  assert.equal(inserts.length, 0);
});

test("a failed profile read is a denial, not a pass", async () => {
  reset({ is_super_admin: true }, { message: "db down" });
  const result = await completeOnboarding(input);
  assert.ok("error" in result && result.error);
  assert.equal(inserts.length, 0);
});

test("a super admin onboards, checked against their own profile row", async () => {
  reset({ is_super_admin: true });
  const result = await completeOnboarding(input);
  assert.equal(result.error, undefined);
  assert.deepEqual(profileFilters, [["id", "user_1"]]);
  assert.equal(inserts[0], "workspaces");
  assert.ok(inserts.includes("memberships"));
});
