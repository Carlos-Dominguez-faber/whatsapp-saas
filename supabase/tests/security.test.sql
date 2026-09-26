-- Security regression tests — run with `supabase test db` against a local stack.
--
-- Each assertion pins a hole that was open in a published version: if a future
-- migration re-grants a privilege or drops a constraint, this fails instead of
-- the next install silently shipping the hole again.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(16);

-- ── public.users: nobody but the service role writes it ─────────────────────
SELECT ok(NOT has_table_privilege('authenticated', 'public.users', 'UPDATE'),
  'authenticated cannot UPDATE public.users (is_super_admin self-promotion)');
SELECT ok(NOT has_column_privilege('authenticated', 'public.users', 'is_super_admin', 'UPDATE'),
  'authenticated cannot UPDATE users.is_super_admin');
SELECT ok(NOT has_table_privilege('authenticated', 'public.users', 'INSERT'),
  'authenticated cannot INSERT public.users');
SELECT ok(NOT has_table_privilege('anon', 'public.users', 'SELECT'),
  'anon cannot SELECT public.users');

-- ── buffer worker RPCs: service role only ───────────────────────────────────
SELECT ok(NOT has_function_privilege('anon', 'public.claim_next_batch()', 'EXECUTE'),
  'anon cannot execute claim_next_batch()');
SELECT ok(NOT has_function_privilege('authenticated', 'public.claim_next_batch()', 'EXECUTE'),
  'authenticated cannot execute claim_next_batch()');
SELECT ok(NOT has_function_privilege('anon', 'public.cancel_batch(uuid)', 'EXECUTE'),
  'anon cannot execute cancel_batch(uuid)');
SELECT ok(NOT has_function_privilege('authenticated', 'public.cancel_batch(uuid)', 'EXECUTE'),
  'authenticated cannot execute cancel_batch(uuid)');
SELECT ok(NOT has_function_privilege('authenticated', 'public.check_outbound_24h_window()', 'EXECUTE'),
  'authenticated cannot execute check_outbound_24h_window()');
SELECT ok(has_function_privilege('service_role', 'public.claim_next_batch()', 'EXECUTE'),
  'service_role can still execute claim_next_batch()');

-- ── message_batches: written by the service-role pipeline only ──────────────
SELECT ok(NOT has_table_privilege('authenticated', 'public.message_batches', 'UPDATE'),
  'authenticated cannot UPDATE message_batches (repoint a batch)');

-- ── cross-workspace references are rejected by the schema ───────────────────
INSERT INTO public.workspaces (id, name, slug) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'A', 'sec-test-a'),
  ('b0000000-0000-4000-8000-000000000001', 'B', 'sec-test-b');
INSERT INTO public.contacts (id, workspace_id, phone) VALUES
  ('b0000000-0000-4000-8000-0000000000c1', 'b0000000-0000-4000-8000-000000000001', '+15550001111');
INSERT INTO public.conversations (id, workspace_id, contact_id) VALUES
  ('b0000000-0000-4000-8000-0000000000d1', 'b0000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-0000000000c1');

SELECT throws_ok(
  $$INSERT INTO public.messages (workspace_id, conversation_id, direction, type, body)
    VALUES ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000d1', 'out', 'text', 'x')$$,
  '23503', NULL,
  'a message "in A" cannot point at a conversation of B');
SELECT throws_ok(
  $$INSERT INTO public.message_batches (workspace_id, conversation_id, flush_at)
    VALUES ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000d1', now())$$,
  '23503', NULL,
  'a batch "in A" cannot point at a conversation of B');
SELECT throws_ok(
  $$INSERT INTO public.conversations (workspace_id, contact_id)
    VALUES ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000c1')$$,
  '23503', NULL,
  'a conversation "in A" cannot use a contact of B');
SELECT throws_ok(
  $$UPDATE public.conversations SET workspace_id = 'a0000000-0000-4000-8000-000000000001'
    WHERE id = 'b0000000-0000-4000-8000-0000000000d1'$$,
  '23503', NULL,
  'a conversation cannot be moved to another workspace');

-- ── users are only visible to people who share a workspace ──────────────────
INSERT INTO auth.users (id, email, instance_id, aud, role) VALUES
  ('a0000000-0000-4000-8000-0000000000e1', 'sec-a@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('b0000000-0000-4000-8000-0000000000e1', 'sec-b@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
INSERT INTO public.users (id, full_name, email) VALUES
  ('a0000000-0000-4000-8000-0000000000e1', 'A user', 'sec-a@test.local'),
  ('b0000000-0000-4000-8000-0000000000e1', 'B user', 'sec-b@test.local');
INSERT INTO public.memberships (workspace_id, user_id, role) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000e1', 'viewer'),
  ('b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000e1', 'admin');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
SELECT is_empty(
  $$SELECT 1 FROM public.users WHERE email = 'sec-b@test.local'$$,
  'a user cannot read the users of a workspace they do not belong to');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
