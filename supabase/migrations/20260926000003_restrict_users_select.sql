-- ============================================================
-- Migration: 20260926000003_restrict_users_select
-- Agente WhatsApp — users can only see the people they work with
--
-- users_select_authenticated (foundation) was USING (auth.uid() IS NOT NULL):
-- any session — a viewer of one client, or anyone who self-registered while
-- Supabase Auth signup was open — could list the email, name and
-- is_super_admin flag of every user of every workspace (e.g. to find and
-- phish the agency owner).
--
-- A user now sees their own row, everyone who has (or had) a membership in a
-- workspace they belong to — so names on old messages still resolve — and
-- super admins see everyone. The team list and agency panel read with the
-- service role and are unaffected.
-- ============================================================

DROP POLICY IF EXISTS "users_select_authenticated" ON public.users;
DROP POLICY IF EXISTS "users_select_visible" ON public.users;

CREATE POLICY "users_select_visible" ON public.users
  FOR SELECT TO authenticated
  USING (
    id = (SELECT auth.uid())
    OR (SELECT public.is_super_admin())
    OR id IN (
      SELECT m.user_id
        FROM public.memberships m
       WHERE m.workspace_id IN (SELECT public.auth_workspace_ids())
    )
  );

-- ============================================================
-- End of migration: 20260926000003_restrict_users_select
-- ============================================================
