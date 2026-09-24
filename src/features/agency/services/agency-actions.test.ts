import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "fake-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";

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

function fakeCreateWorkspaceService(opts: {
  existingAuthUsers?: Array<{ id: string; email: string }>;
  existingUserFullName?: string | null;
  createUserId?: string;
  listUsersError?: { message: string };
  /** Simulates createUser() failing (e.g. "email exists") — set this to force the fallback path. */
  createUserError?: string;
  /**
   * A user that only becomes visible to listUsers() AFTER createUser() has been
   * attempted — models a concurrent request creating the account in the window
   * between our precheck and our own createUser call.
   */
  raceUser?: { id: string; email: string };
}) {
  const inserts: Array<{ table: string; row: unknown }> = [];
  let promptCounter = 0;
  let createUserAttempted = false;

  function chain(terminalResult: { data: unknown; error: unknown }, table: string) {
    const c: any = {
      select: () => c,
      eq: () => c,
      insert: (row: unknown) => {
        inserts.push({ table, row });
        return c;
      },
      update: (row: unknown) => {
        inserts.push({ table: `${table}:update`, row });
        return c;
      },
      upsert: (row: unknown) => {
        inserts.push({ table: `${table}:upsert`, row });
        return Promise.resolve({ error: null });
      },
      delete: () => {
        inserts.push({ table: `${table}:delete`, row: null });
        return c;
      },
      single: async () => terminalResult,
      then: (resolve: (v: unknown) => void) => resolve(terminalResult),
    };
    return c;
  }

  const client = {
    auth: {
      admin: {
        listUsers: async () => {
          if (opts.listUsersError) return { data: null, error: opts.listUsersError };
          const users = [...(opts.existingAuthUsers ?? [])];
          if (opts.raceUser && createUserAttempted) users.push(opts.raceUser);
          return { data: { users }, error: null };
        },
        createUser: async () => {
          createUserAttempted = true;
          if (opts.createUserError) {
            return { data: { user: null }, error: { message: opts.createUserError } };
          }
          return {
            data: opts.createUserId ? { user: { id: opts.createUserId } } : { user: null },
            error: opts.createUserId ? null : { message: "email exists" },
          };
        },
      },
    },
    from(table: string) {
      if (table === "workspaces") {
        return chain({ data: { id: "ws_new" }, error: null }, table);
      }
      if (table === "memberships") {
        return chain({ data: null, error: null }, table);
      }
      if (table === "users") {
        return chain(
          {
            data:
              opts.existingUserFullName !== undefined
                ? { full_name: opts.existingUserFullName }
                : null,
            error: null,
          },
          table,
        );
      }
      if (table === "prompts") {
        promptCounter++;
        return chain({ data: { id: `prompt_${promptCounter}` }, error: null }, table);
      }
      if (table === "prompt_versions") {
        return chain({ data: { id: "version_1" }, error: null }, table);
      }
      if (table === "business_info" || table === "agents") {
        return chain({ data: null, error: null }, table);
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };

  return { client, inserts };
}

const { getWorkspaceMembers, resetMemberPassword, createWorkspaceForClient } = await import(
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

test("createWorkspaceForClient creates workspace + user + membership when the email is new", async () => {
  currentAuthClient = fakeAuthClient({ user: { id: "admin1" }, isSuperAdmin: true });
  const service = fakeCreateWorkspaceService({
    existingAuthUsers: [],
    createUserId: "user_new",
  });
  currentServiceClient = service.client;

  const result = await createWorkspaceForClient({
    name: "Clínica Test",
    useCase: "general",
    clientEmail: "nuevo@cliente.com",
    clientPassword: "",
  });

  assert.equal(result.error, undefined);
  assert.equal(result.needsConfirmation, undefined);
  assert.equal(
    result.webhookUrl,
    "https://app.example.com/api/webhooks/kapso?wsid=ws_new",
  );
  assert.ok(result.clientCredentials);
  assert.equal(result.clientCredentials?.email, "nuevo@cliente.com");
  assert.ok(
    service.inserts.some((i) => i.table === "workspaces"),
    "must insert into workspaces",
  );
});

test("createWorkspaceForClient returns needsConfirmation without creating anything when the email already belongs to another account", async () => {
  currentAuthClient = fakeAuthClient({ user: { id: "admin1" }, isSuperAdmin: true });
  const service = fakeCreateWorkspaceService({
    existingAuthUsers: [{ id: "user_existing", email: "duplicado@cliente.com" }],
    existingUserFullName: "Cliente Existente",
  });
  currentServiceClient = service.client;

  const result = await createWorkspaceForClient({
    name: "Clínica Test",
    useCase: "general",
    clientEmail: "duplicado@cliente.com",
    clientPassword: "",
  });

  assert.deepEqual(result, {
    needsConfirmation: true,
    existingUser: { email: "duplicado@cliente.com", fullName: "Cliente Existente" },
  });
  assert.equal(
    service.inserts.some((i) => i.table === "workspaces"),
    false,
    "must not insert a workspace before the confirmation is resolved",
  );
  assert.equal(
    service.inserts.some((i) => i.table === "memberships"),
    false,
    "must not insert a membership before the confirmation is resolved",
  );
});

test("createWorkspaceForClient proceeds and reuses the existing account when confirmReuseExistingEmail is true", async () => {
  currentAuthClient = fakeAuthClient({ user: { id: "admin1" }, isSuperAdmin: true });
  const service = fakeCreateWorkspaceService({
    existingAuthUsers: [{ id: "user_existing", email: "duplicado@cliente.com" }],
    existingUserFullName: "Cliente Existente",
  });
  currentServiceClient = service.client;

  const result = await createWorkspaceForClient({
    name: "Clínica Test",
    useCase: "general",
    clientEmail: "duplicado@cliente.com",
    clientPassword: "",
    confirmReuseExistingEmail: true,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.needsConfirmation, undefined);
  assert.equal(
    result.webhookUrl,
    "https://app.example.com/api/webhooks/kapso?wsid=ws_new",
  );
  assert.equal(
    result.clientCredentials,
    null,
    "no new password is generated when reusing an existing account",
  );
  const membershipInsert = service.inserts.find(
    (i) =>
      i.table === "memberships" &&
      (i.row as { user_id?: string }).user_id === "user_existing",
  );
  assert.ok(membershipInsert, "must add the existing user as a member of the new workspace");
});

test("createWorkspaceForClient returns a controlled error (not a throw, not a created workspace) when the email precheck fails", async () => {
  currentAuthClient = fakeAuthClient({ user: { id: "admin1" }, isSuperAdmin: true });
  const service = fakeCreateWorkspaceService({
    listUsersError: { message: "service unavailable" },
  });
  currentServiceClient = service.client;

  const result = await createWorkspaceForClient({
    name: "Clínica Test",
    useCase: "general",
    clientEmail: "cliente@empresa.com",
    clientPassword: "",
  });

  assert.deepEqual(result, { error: "No se pudo verificar el email, intenta de nuevo" });
  assert.equal(
    service.inserts.some((i) => i.table === "workspaces"),
    false,
    "must not create a workspace when the precheck itself fails",
  );
});

test("createWorkspaceForClient creates nothing and asks for confirmation when a concurrent request creates the account between the precheck and provisioning (race)", async () => {
  currentAuthClient = fakeAuthClient({ user: { id: "admin1" }, isSuperAdmin: true });
  const service = fakeCreateWorkspaceService({
    existingAuthUsers: [],
    createUserError: "email exists",
    raceUser: { id: "user_raced_in", email: "race@cliente.com" },
    existingUserFullName: "Cliente De La Carrera",
  });
  currentServiceClient = service.client;

  const result = await createWorkspaceForClient({
    name: "Clínica Test",
    useCase: "general",
    clientEmail: "race@cliente.com",
    clientPassword: "",
  });

  assert.deepEqual(result, {
    needsConfirmation: true,
    existingUser: { email: "race@cliente.com", fullName: "Cliente De La Carrera" },
  });
  assert.equal(
    service.inserts.some((i) => i.table === "workspaces"),
    false,
    "must not create a workspace at all — the race is caught before anything is created",
  );
  assert.equal(
    service.inserts.some(
      (i) => i.table === "memberships" && (i.row as { user_id?: string })?.user_id === "user_raced_in",
    ),
    false,
    "must not add the raced-in account as a member without confirmation",
  );
});

test("createWorkspaceForClient creates nothing and returns a controlled error when a confirmed reuse can't actually be resolved", async () => {
  currentAuthClient = fakeAuthClient({ user: { id: "admin1" }, isSuperAdmin: true });
  const service = fakeCreateWorkspaceService({
    createUserError: "email exists",
    listUsersError: { message: "service unavailable" },
  });
  currentServiceClient = service.client;

  const result = await createWorkspaceForClient({
    name: "Clínica Test",
    useCase: "general",
    clientEmail: "duplicado@cliente.com",
    clientPassword: "",
    confirmReuseExistingEmail: true,
  });

  assert.deepEqual(result, { error: "No se pudo verificar el email, intenta de nuevo" });
  assert.equal(
    service.inserts.some((i) => i.table === "workspaces"),
    false,
    "must not create a workspace at all — resolved before anything is created",
  );
});
