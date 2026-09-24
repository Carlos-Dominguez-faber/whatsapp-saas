import { createClient as createSbClient } from "@supabase/supabase-js";

// ──────────────────────────────────────────────────────────────────────────────
// Signup gate — one-click-install bootstrap.
//
// Public self-registration is closed. The ONLY account that can self-register
// is the very first one (the agency super admin). Once any user exists, signup
// is closed and new people must be invited from the agency panel.
// ──────────────────────────────────────────────────────────────────────────────

function admin() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

/**
 * Signup is open only while there are zero users (fresh install).
 * Fails closed: any read error reports signup as closed.
 */
export async function isSignupOpen(): Promise<boolean> {
  const { count, error } = await admin()
    .from("users")
    .select("id", { count: "exact", head: true });

  // Fails closed: an error OR a missing count (e.g. no content-range header
  // in the response) both report signup as closed. `count` only means "zero
  // users" when we can positively confirm it — never by defaulting a null.
  if (error || count === null || count === undefined) return false;
  return count === 0;
}

/** Promotes the bootstrap user (first registration) to agency super admin. */
export async function markAsSuperAdmin(userId: string): Promise<void> {
  await admin().from("users").update({ is_super_admin: true }).eq("id", userId);
}
