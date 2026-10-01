-- The anon key — run with `supabase test db` against a local stack.
--
-- anon is the public API key every browser has. It must hold no privilege on
-- any table in public: RLS returning [] is the second line, not the first.
-- A table that legitimately needs anon goes in the allowlist below, with the
-- reason next to it. Today there is none.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(4);

SELECT is(
  (SELECT COALESCE(array_agg(c.relname::text ORDER BY c.relname), '{}')
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND c.relname <> ALL (ARRAY[]::text[])  -- allowlist
      AND (   has_table_privilege('anon', c.oid, 'SELECT')
           OR has_table_privilege('anon', c.oid, 'INSERT')
           OR has_table_privilege('anon', c.oid, 'UPDATE')
           OR has_table_privilege('anon', c.oid, 'DELETE')
           OR has_table_privilege('anon', c.oid, 'TRUNCATE')
           OR has_table_privilege('anon', c.oid, 'REFERENCES')
           OR has_table_privilege('anon', c.oid, 'TRIGGER'))),
  '{}'::text[],
  'anon holds no privilege on any public table or view');

SELECT is(
  (SELECT COALESCE(array_agg(c.relname::text ORDER BY c.relname), '{}')
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'S'
      AND (has_sequence_privilege('anon', c.oid, 'USAGE')
           OR has_sequence_privilege('anon', c.oid, 'UPDATE'))),
  '{}'::text[],
  'anon holds no privilege on any public sequence');

-- A table a future migration creates (as postgres) starts without anon.
CREATE TABLE public.anon_default_probe (id int);
SELECT ok(NOT has_table_privilege('anon', 'public.anon_default_probe', 'SELECT'),
  'a new table in public is not readable by anon by default');
SELECT ok(has_table_privilege('authenticated', 'public.anon_default_probe', 'SELECT'),
  'signed-in sessions keep Supabase''s default grants (RLS still decides the rows)');

SELECT * FROM finish();
ROLLBACK;
