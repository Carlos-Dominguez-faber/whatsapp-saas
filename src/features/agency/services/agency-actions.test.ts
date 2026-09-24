import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "fake-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

mock.module("next/headers", {
  exports: { cookies: async () => ({ getAll: () => [], set: () => {} }) },
});

let currentAuthClient: any;
mock.module("@supabase/ssr", {
  exports: { createServerClient: () => currentAuthClient },
});

function fakeAuthClient(opts: {
  user: { id: string } | null;
  isSuperAdmin?: boolean;
}) {
  return {
    auth: { getUser: async () => ({ data: { user: opts.user } }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: opts.isSuperAdmin
              ? { is_super_admin: true }
              : { is_super_admin: false },
          }),
        }),
      }),
    }),
  };
}

let currentServiceClient: any;
mock.module("@supabase/supabase-js", {
  exports: { createClient: () => currentServiceClient },
});

function fakeService(opts: {
  membersRows?: Array<{
    user_id: string;
    role: string;
    is_active: boolean;
    users: { email: string; full_name: string | null } | null;
  }>;
  membersError?: { message: string } | null;
  membershipExists?: boolean;
  membershipError?: { message: string } | null;
  userEmail?: string | null;
  updateError?: { message: string } | null;
}) {
  const updateCalls: Array<{ userId: string; password: string }> = [];
  const client = {
    auth: {
      admin: {
        updateUserById: async (
          userId: string,
          attrs: { password: string },
        ) => {
          updateCalls.push({ userId, password: attrs.password });
          return { data: {}, error: opts.updateError ?? null };
        },
      },
    },
    from(table: string) {
      if (table === "memberships") {
        return {
          select() {
            const chain: any = {
              eq() {
                return chain;
              },
              maybeSingle: async () => ({
                data: opts.membershipExists ? { user_id: "target1" } : null,
                error: opts.membershipError ?? null,
              }),
              then(resolve: (v: unknown) => void) {
                resolve({
                  data: opts.membersRows ?? [],
                  error: opts.membersError ?? null,
                });
              },
            };
            return chain;
          },
        };
      }
      if (table === "users") {
        return {
          select() {
            return {
              eq() {
                return {
                  single: async () =>
                    opts.userEmail
                      ? { data: { email: opts.userEmail }, error: null }
                      : { data: null, error: { message: "not found" } },
                };
              },
            };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
  return { client, updateCalls };
}

const { getWorkspaceMembers, resetMemberPassword } = await import(
  "./agency-actions.ts"
);

test("getWorkspaceMembers returns 'No autorizado' when the caller isn't super admin", async () => {
  currentAuthClient = fakeAuthClient({ user: { id: "u1" }, isSuperAdmin: false });
  currentServiceClient = fakeService({}).client;
  const result = await getWorkspaceMembers("ws_1");
  assert.deepEqual(result, { error: "No autorizado" });
});

test("getWorkspaceMembers maps membership + user rows for a super admin", async () => {
  currentAuthClient = fakeAuthClient({ user: { id: "admin1" }, isSuperAdmin: true });
  currentServiceClient = fakeService({
    membersRows: [
      {
        user_id: "u1",
        role: "admin",
        is_active: true,
        users: { email: "cliente@empresa.com", full_name: "Cliente Uno" },
      },
      {
        user_id: "admin1",
        role: "admin",
        is_active: true,
        users: { email: "agencia@example.com", full_name: null },
      },
    ],
  }).client;

  const result = await getWorkspaceMembers("ws_1");
  assert.deepEqual(result, {
    members: [
      {
        userId: "u1",
        email: "cliente@empresa.com",
        fullName: "Cliente Uno",
        role: "admin",
        isActive: true,
      },
      {
        userId: "admin1",
        email: "agencia@example.com",
        fullName: null,
        role: "admin",
        isActive: true,
      },
    ],
  });
});

test("getWorkspaceMembers returns a generic error when the query fails", async () => {
  currentAuthClient = fakeAuthClient({ user: { id: "admin1" }, isSuperAdmin: true });
  currentServiceClient = fakeService({
    membersError: { message: "db down" },
  }).client;
  const result = await getWorkspaceMembers("ws_1");
  assert.deepEqual(result, { error: "No se pudieron cargar los miembros" });
});

test("resetMemberPassword returns 'No autorizado' when the caller isn't super admin", async () => {
  currentAuthClient = fakeAuthClient({ user: { id: "u1" }, isSuperAdmin: false });
  currentServiceClient = fakeService({}).client;
  const result = await resetMemberPassword("ws_1", "target1");
  assert.deepEqual(result, { error: "No autorizado" });
});

test("resetMemberPassword generates a new password and returns it with the email", async () => {
  currentAuthClient = fakeAuthClient({ user: { id: "admin1" }, isSuperAdmin: true });
  const service = fakeService({
    membershipExists: true,
    userEmail: "cliente@empresa.com",
  });
  currentServiceClient = service.client;

  const result = await resetMemberPassword("ws_1", "target1");
  assert.equal(result.error, undefined);
  assert.equal(result.email, "cliente@empresa.com");
  assert.ok(result.password && result.password.length > 0);
  assert.equal(service.updateCalls.length, 1);
  assert.equal(service.updateCalls[0].userId, "target1");
  assert.equal(service.updateCalls[0].password, result.password);
});

test("resetMemberPassword returns a controlled error when the userId is not an active member of the given workspace", async () => {
  currentAuthClient = fakeAuthClient({ user: { id: "admin1" }, isSuperAdmin: true });
  const service = fakeService({
    membershipExists: false,
    userEmail: "cliente@empresa.com",
  });
  currentServiceClient = service.client;

  const result = await resetMemberPassword("ws_1", "target1");
  assert.deepEqual(result, { error: "No se pudo resetear la clave" });
  assert.equal(
    service.updateCalls.length,
    0,
    "must never call updateUserById when the membership check fails",
  );
});

test("resetMemberPassword returns a controlled error for a non-existent userId", async () => {
  currentAuthClient = fakeAuthClient({ user: { id: "admin1" }, isSuperAdmin: true });
  currentServiceClient = fakeService({
    membershipExists: true,
    userEmail: null,
  }).client;
  const result = await resetMemberPassword("ws_1", "ghost");
  assert.deepEqual(result, { error: "No se pudo resetear la clave" });
});

test("resetMemberPassword returns a generic error when updateUserById fails", async () => {
  currentAuthClient = fakeAuthClient({ user: { id: "admin1" }, isSuperAdmin: true });
  currentServiceClient = fakeService({
    membershipExists: true,
    userEmail: "cliente@empresa.com",
    updateError: { message: "boom" },
  }).client;
  const result = await resetMemberPassword("ws_1", "target1");
  assert.deepEqual(result, { error: "No se pudo resetear la clave" });
});
