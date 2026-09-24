// Agency-managed user provisioning — NO email / NO SMTP required.
//
// Instead of inviteUserByEmail (which sends a magic-link email and needs SMTP +
// Site URL configured), the agency creates the account with a known password and
// shares the credentials with the client, who logs in directly. This is the
// distribution model for the one-click/giveaway install: zero email setup.

import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Strong, URL-safe password (~22 chars). Avoids ambiguous email-delivery issues. */
export function generatePassword(): string {
  return randomBytes(16).toString("base64url");
}

export interface ExistingUserLookup {
  id: string;
  email: string;
}

/**
 * Resolves an existing auth user by email via the admin API, or null if none exists.
 * Paginates through the full user list (listUsers defaults to page 1 / 50 per page —
 * an existing match past the first page would otherwise go undetected) and compares
 * case-insensitively (GoTrue stores emails lowercased, but the caller may not send
 * one already lowercased). Fails closed: a listUsers() error throws instead of
 * silently reporting "no existing user".
 */
export async function findAuthUserByEmail(
  service: SupabaseClient,
  email: string,
): Promise<ExistingUserLookup | null> {
  const target = email.trim().toLowerCase();
  for (let page = 1; ; page++) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error("No se pudo verificar el email");
    const users = data?.users ?? [];
    const hit = users.find((u) => u.email?.toLowerCase() === target);
    if (hit) return { id: hit.id, email: hit.email ?? email };
    if (users.length < 200) return null;
  }
}

export interface ProvisionResult {
  userId: string;
  /** Password to share with the user — only set when a NEW account was created. */
  password: string | null;
  /** false when the email already existed (we don't reset an existing password). */
  created: boolean;
}

/**
 * Creates a confirmed Supabase auth user with a known password (no email sent),
 * or resolves the existing user by email. Ensures a `users` profile row exists.
 *
 * @param service  A service-role Supabase client (admin API access).
 * @param email    The user's email (also their login).
 * @param opts.password  Optional explicit password; a strong one is generated if omitted.
 */
export async function provisionWorkspaceUser(
  service: SupabaseClient,
  email: string,
  opts?: { password?: string; fullName?: string },
): Promise<ProvisionResult> {
  const password = opts?.password?.trim() || generatePassword();

  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // mark confirmed → no verification email
  });

  let userId = data?.user?.id ?? null;
  let created = Boolean(userId);

  if (!userId) {
    // Most likely the email is already registered — resolve the existing user.
    const existing = await findAuthUserByEmail(service, email);
    userId = existing?.id ?? null;
    created = false;
    if (!userId) {
      throw new Error(error?.message ?? "No se pudo crear el usuario");
    }
  }

  // Ensure the public.users profile row exists (the auth trigger may lag).
  await service.from("users").upsert(
    {
      id: userId,
      email,
      full_name: opts?.fullName ?? email.split("@")[0],
      is_active: true,
    },
    { onConflict: "id", ignoreDuplicates: true },
  );

  return { userId, password: created ? password : null, created };
}
