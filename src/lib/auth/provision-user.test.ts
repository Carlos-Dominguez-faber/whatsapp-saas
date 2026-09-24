import assert from "node:assert/strict";
import { test } from "node:test";
import { provisionWorkspaceUser, generatePassword, findAuthUserByEmail } from "./provision-user.ts";

function fakeService(opts: {
  createUserId?: string;
  createUserError?: string;
  existingUsers?: Array<{ id: string; email: string }>;
  listUsersError?: { message: string };
}) {
  const upsertCalls: unknown[] = [];
  return {
    upsertCalls,
    client: {
      auth: {
        admin: {
          createUser: async () => ({
            data: opts.createUserId ? { user: { id: opts.createUserId } } : { user: null },
            error: opts.createUserError ? { message: opts.createUserError } : null,
          }),
          listUsers: async (params?: { page?: number; perPage?: number }) => {
            if (opts.listUsersError) return { data: null, error: opts.listUsersError };
            const perPage = params?.perPage ?? 50;
            const page = params?.page ?? 1;
            const start = (page - 1) * perPage;
            const users = (opts.existingUsers ?? []).slice(start, start + perPage);
            return { data: { users }, error: null };
          },
        },
      },
      from: () => ({
        upsert: async (row: unknown) => {
          upsertCalls.push(row);
          return { error: null };
        },
      }),
    } as any,
  };
}

test("generatePassword returns a 22-char URL-safe string (16 random bytes, base64url)", () => {
  const pw = generatePassword();
  assert.equal(pw.length, 22);
  assert.doesNotMatch(pw, /[+/=]/);
});

test("creates a new user and returns the generated password", async () => {
  const { client, upsertCalls } = fakeService({ createUserId: "user_new" });
  const result = await provisionWorkspaceUser(client, "new@example.com");
  assert.equal(result.userId, "user_new");
  assert.equal(result.created, true);
  assert.ok(result.password && result.password.length > 0);
  assert.equal(upsertCalls.length, 1);
  assert.deepEqual(upsertCalls[0], {
    id: "user_new",
    email: "new@example.com",
    full_name: "new",
    is_active: true,
  });
});

test("uses the explicit password when provided instead of generating one", async () => {
  const { client } = fakeService({ createUserId: "user_new" });
  const explicit = "fixture-value";
  const result = await provisionWorkspaceUser(client, "new@example.com", {
    password: explicit,
    fullName: "Juan Pérez",
  });
  assert.equal(result.password, explicit);
});

test("resolves the existing user and returns password:null when the email already exists", async () => {
  const { client } = fakeService({
    existingUsers: [{ id: "user_existing", email: "taken@example.com" }],
  });
  const result = await provisionWorkspaceUser(client, "taken@example.com");
  assert.equal(result.userId, "user_existing");
  assert.equal(result.created, false);
  assert.equal(result.password, null);
});

test("throws when creation fails and the email isn't found among existing users either", async () => {
  const { client } = fakeService({ createUserError: "boom", existingUsers: [] });
  await assert.rejects(
    () => provisionWorkspaceUser(client, "ghost@example.com"),
    /boom/,
  );
});

test("findAuthUserByEmail resolves an existing user by email", async () => {
  const { client } = fakeService({
    existingUsers: [
      { id: "user_a", email: "a@example.com" },
      { id: "user_b", email: "b@example.com" },
    ],
  });
  const result = await findAuthUserByEmail(client, "b@example.com");
  assert.deepEqual(result, { id: "user_b", email: "b@example.com" });
});

test("findAuthUserByEmail returns null when no user matches the email", async () => {
  const { client } = fakeService({ existingUsers: [] });
  const result = await findAuthUserByEmail(client, "ghost@example.com");
  assert.equal(result, null);
});

test("findAuthUserByEmail matches regardless of letter case", async () => {
  const { client } = fakeService({
    existingUsers: [{ id: "user_b", email: "b@example.com" }],
  });
  const result = await findAuthUserByEmail(client, "B@Example.com");
  assert.deepEqual(result, { id: "user_b", email: "b@example.com" });
});

test("findAuthUserByEmail throws (fails closed) when listUsers() returns an error", async () => {
  const { client } = fakeService({ listUsersError: { message: "boom" } });
  await assert.rejects(() => findAuthUserByEmail(client, "anyone@example.com"));
});

test("findAuthUserByEmail paginates past the first page (perPage: 200) to find a match", async () => {
  const existingUsers = Array.from({ length: 250 }, (_, i) => ({
    id: `user_${i}`,
    email: `user${i}@example.com`,
  }));
  const { client } = fakeService({ existingUsers });
  const result = await findAuthUserByEmail(client, "user225@example.com");
  assert.deepEqual(result, { id: "user_225", email: "user225@example.com" });
});
