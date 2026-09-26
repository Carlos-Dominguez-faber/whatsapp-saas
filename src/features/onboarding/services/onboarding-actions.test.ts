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

// Service-role client: answers the gate's two reads from the fixtures below
// and records every write, returning a fresh id for insert(...).select().single().
let isSuperAdmin = false;
let membershipCount = 0;
let inserts: string[] = [];

function chain(result: unknown): any {
  const c: any = {
    select: () => c,
    eq: () => c,
    maybeSingle: async () => result,
    single: async () => ({ data: { id: "new_id" }, error: null }),
    then: (resolve: (v: unknown) => void) => resolve(result),
  };
  return c;
}

mock.module("@supabase/supabase-js", {
  exports: {
    createClient: () => ({
      from: (table: string) => ({
        select: (_cols: string, opts?: { head?: boolean }) =>
          table === "memberships" && opts?.head
            ? chain({ count: membershipCount, error: null })
            : chain({ data: { is_super_admin: isSuperAdmin }, error: null }),
        insert: () => {
          inserts.push(table);
          return chain({ error: null });
        },
        update: () => chain({ error: null }),
        delete: () => chain({ error: null }),
      }),
    }),
  },
});

const { completeOnboarding } = await import("./onboarding-actions.ts");

const input = { useCase: "general", businessName: "Acme" };

test("an account invited to any workspace cannot mint itself a new admin workspace", async () => {
  isSuperAdmin = false;
  membershipCount = 1; // e.g. a viewer, or a deactivated ex-member
  inserts = [];
  const result = await completeOnboarding(input);
  assert.ok("error" in result && result.error);
  assert.equal(inserts.length, 0, "nothing may be created");
});

test("a super admin can onboard even with existing memberships", async () => {
  isSuperAdmin = true;
  membershipCount = 3;
  inserts = [];
  const result = await completeOnboarding(input);
  assert.equal(result.error, undefined);
  assert.equal(inserts[0], "workspaces");
});

test("an account that never belonged to a workspace can onboard", async () => {
  isSuperAdmin = false;
  membershipCount = 0;
  inserts = [];
  const result = await completeOnboarding(input);
  assert.equal(result.error, undefined);
  assert.ok(inserts.includes("memberships"));
});
