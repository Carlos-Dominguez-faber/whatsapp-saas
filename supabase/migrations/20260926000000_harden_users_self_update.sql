-- ============================================================
-- Migration: 20260926000000_harden_users_self_update
-- Agente WhatsApp — stop users from editing their own public.users row
--
-- users_update_own (foundation) lets a signed-in user UPDATE their own row
-- with no column restriction, and Supabase grants every table privilege on
-- public tables to anon/authenticated by default. is_super_admin lives in that
-- row, so anyone with a session could PATCH /rest/v1/users?id=eq.<self>
-- {"is_super_admin": true} with the public anon key and their JWT — and from
-- there read every workspace, add themselves as admin anywhere and pass
-- assertSuperAdmin.
--
-- No app code writes public.users with a user session: signup-gate.ts,
-- provision-user.ts and seed-admin.mjs use the service role. So users keep
-- only SELECT (still filtered by RLS); there is no profile editor, and a
-- writable full_name would only let someone rename themselves as another
-- sender in the inbox. Grant UPDATE (full_name, avatar_url) back if a profile
-- screen is ever added.
-- ============================================================

REVOKE ALL ON public.users FROM anon, authenticated;
GRANT SELECT ON public.users TO authenticated;

-- Detection (run once after applying, compare against who SHOULD be super
-- admin; the full audit lives in INSTALAR.md → "Actualizar"):
--   SELECT id, email, full_name, created_at FROM public.users WHERE is_super_admin;
-- Revoke an illegitimate one with the service role / SQL editor:
--   UPDATE public.users SET is_super_admin = false WHERE id = '<uuid>';

-- ============================================================
-- End of migration: 20260926000000_harden_users_self_update
-- ============================================================
