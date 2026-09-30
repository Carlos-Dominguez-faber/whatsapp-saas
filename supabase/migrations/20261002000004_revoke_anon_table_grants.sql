-- ============================================================
-- Migration: 20261002000004_revoke_anon_table_grants
-- Agente WhatsApp — the anon key reads and writes no table
--
-- Supabase's default privileges give anon (the public API key, shipped to
-- every browser) ALL on each new table in public, and most migrations here
-- only revoked write verbs, if anything. Nothing leaked, because RLS returns
-- no rows to anon (auth.uid() is NULL in every policy), but the only thing
-- between the internet and the data was each table's policies. No page of
-- the app reads a table without a session, so anon keeps nothing:
--
-- 1. every privilege on every table, view and sequence in public, revoked;
-- 2. the default privileges of `postgres` (the role migrations run as)
--    stop granting anon anything on the tables and sequences created from
--    now on, so a future migration can't bring it back by omission.
--
-- supabase/tests/anon.test.sql fails if anon holds any privilege on a public
-- table again. Signed-in sessions (authenticated) are untouched: their access
-- is still what each table's grants and RLS say.
-- ============================================================

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;

-- ============================================================
-- End of migration: 20261002000004_revoke_anon_table_grants
-- ============================================================
