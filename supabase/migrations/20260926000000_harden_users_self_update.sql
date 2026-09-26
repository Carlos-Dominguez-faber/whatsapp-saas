-- ============================================================
-- Migration: 20260926000000_harden_users_self_update
-- Agente WhatsApp — stop users from editing privileged columns of their row
--
-- users_update_own (foundation) lets a signed-in user UPDATE their own row
-- with no column restriction, and Supabase grants UPDATE on public tables to
-- `authenticated` by default. is_super_admin lives in that row, so anyone with
-- a session could PATCH /rest/v1/users?id=eq.<self> {"is_super_admin": true}
-- with the public anon key and their JWT — and from there read every
-- workspace, add themselves as admin anywhere and pass assertSuperAdmin.
--
-- No app code writes public.users with a user session: signup-gate.ts and
-- provision-user.ts use the service role. So table-level write privileges go
-- away for anon/authenticated, and only the harmless profile columns remain
-- updatable (RLS still limits that to the caller's own row).
-- ============================================================

REVOKE INSERT, UPDATE, DELETE ON public.users FROM anon, authenticated;
GRANT UPDATE (full_name, avatar_url) ON public.users TO authenticated;

-- Detection (run once after applying, compare against who SHOULD be super admin):
--   SELECT id, email, full_name, created_at FROM public.users WHERE is_super_admin;
-- Revoke an illegitimate one with the service role / SQL editor:
--   UPDATE public.users SET is_super_admin = false WHERE id = '<uuid>';

-- ============================================================
-- End of migration: 20260926000000_harden_users_self_update
-- ============================================================
