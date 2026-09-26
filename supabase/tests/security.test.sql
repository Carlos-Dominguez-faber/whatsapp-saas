-- Security regression tests — run with `supabase test db` against a local stack.
--
-- Each assertion pins a hole that was open in a published version: if a future
-- migration re-grants a privilege or drops a constraint, this fails instead of
-- the next install silently shipping the hole again.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(51);

-- ── public.users: read-only for sessions ────────────────────────────────────
SELECT ok(NOT has_table_privilege('authenticated', 'public.users', 'UPDATE'),
  'authenticated cannot UPDATE public.users (is_super_admin self-promotion)');
SELECT ok(NOT has_column_privilege('authenticated', 'public.users', 'is_super_admin', 'UPDATE'),
  'authenticated cannot UPDATE users.is_super_admin');
SELECT ok(NOT has_column_privilege('authenticated', 'public.users', 'full_name', 'UPDATE'),
  'authenticated cannot UPDATE users.full_name (sender impersonation)');
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

-- ── WhatsApp provider switch: service role only ─────────────────────────────
SELECT ok(NOT has_function_privilege('anon',
  'public.save_whatsapp_integration(uuid, public.integration_provider, boolean, jsonb, jsonb, text[])', 'EXECUTE'),
  'anon cannot execute save_whatsapp_integration()');
SELECT ok(NOT has_function_privilege('authenticated',
  'public.save_whatsapp_integration(uuid, public.integration_provider, boolean, jsonb, jsonb, text[])', 'EXECUTE'),
  'authenticated cannot execute save_whatsapp_integration()');
SELECT ok(has_function_privilege('service_role',
  'public.save_whatsapp_integration(uuid, public.integration_provider, boolean, jsonb, jsonb, text[])', 'EXECUTE'),
  'service_role can execute save_whatsapp_integration()');

-- ── message_batches: written by the service-role pipeline only ──────────────
SELECT ok(NOT has_table_privilege('authenticated', 'public.message_batches', 'INSERT'),
  'authenticated cannot INSERT message_batches');
SELECT ok(NOT has_table_privilege('authenticated', 'public.message_batches', 'UPDATE'),
  'authenticated cannot UPDATE message_batches (repoint a batch)');
SELECT ok(NOT has_table_privilege('authenticated', 'public.message_batches', 'DELETE'),
  'authenticated cannot DELETE message_batches');

-- ── every tenant reference is a (workspace_id, ref) composite FK ────────────
SELECT fk_ok('public', 'message_batches', ARRAY['workspace_id', 'conversation_id'], 'public', 'conversations', ARRAY['workspace_id', 'id']);
SELECT fk_ok('public', 'messages', ARRAY['workspace_id', 'conversation_id'], 'public', 'conversations', ARRAY['workspace_id', 'id']);
SELECT fk_ok('public', 'messages', ARRAY['workspace_id', 'batch_id'], 'public', 'message_batches', ARRAY['workspace_id', 'id']);
SELECT fk_ok('public', 'messages', ARRAY['workspace_id', 'template_id'], 'public', 'templates', ARRAY['workspace_id', 'id']);
SELECT fk_ok('public', 'events', ARRAY['workspace_id', 'conversation_id'], 'public', 'conversations', ARRAY['workspace_id', 'id']);
SELECT fk_ok('public', 'conversations', ARRAY['workspace_id', 'contact_id'], 'public', 'contacts', ARRAY['workspace_id', 'id']);
SELECT fk_ok('public', 'appointments', ARRAY['workspace_id', 'contact_id'], 'public', 'contacts', ARRAY['workspace_id', 'id']);
SELECT fk_ok('public', 'appointments', ARRAY['workspace_id', 'conversation_id'], 'public', 'conversations', ARRAY['workspace_id', 'id']);
SELECT fk_ok('public', 'appointments', ARRAY['workspace_id', 'schedule_id'], 'public', 'schedules', ARRAY['workspace_id', 'id']);
SELECT fk_ok('public', 'kb_chunks', ARRAY['workspace_id', 'document_id'], 'public', 'kb_documents', ARRAY['workspace_id', 'id']);

-- ── fixtures: two workspaces ────────────────────────────────────────────────
INSERT INTO public.workspaces (id, name, slug) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'A', 'sec-test-a'),
  ('b0000000-0000-4000-8000-000000000001', 'B', 'sec-test-b');
INSERT INTO public.contacts (id, workspace_id, phone) VALUES
  ('b0000000-0000-4000-8000-0000000000c1', 'b0000000-0000-4000-8000-000000000001', '+15550001111');
INSERT INTO public.conversations (id, workspace_id, contact_id) VALUES
  ('b0000000-0000-4000-8000-0000000000d1', 'b0000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-0000000000c1');
INSERT INTO public.prompts (id, workspace_id, name, scope) VALUES
  ('a0000000-0000-4000-8000-0000000000f1', 'a0000000-0000-4000-8000-000000000001', 'A prompt', 'global'),
  ('b0000000-0000-4000-8000-0000000000f1', 'b0000000-0000-4000-8000-000000000001', 'B prompt', 'global');
INSERT INTO public.prompt_versions (id, workspace_id, prompt_id, version, body) VALUES
  ('b0000000-0000-4000-8000-0000000000f2', 'b0000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-0000000000f1', 1, 'B secret prompt');

-- ── cross-workspace references are rejected ─────────────────────────────────
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
SELECT throws_ok(
  $$UPDATE public.prompts SET active_version_id = 'b0000000-0000-4000-8000-0000000000f2'
    WHERE id = 'a0000000-0000-4000-8000-0000000000f1'$$,
  '23503', NULL,
  'a prompt of A cannot activate a version of B (bot would serve B''s prompt)');
SELECT throws_ok(
  $$INSERT INTO public.prompt_versions (workspace_id, prompt_id, version, body)
    VALUES ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000f1', 99, 'x')$$,
  '23503', NULL,
  'a version "in A" cannot hang off a prompt of B');
SELECT throws_ok(
  $$INSERT INTO public.agents (workspace_id, name, type, prompt_id)
    VALUES ('a0000000-0000-4000-8000-000000000001', 'x', 'setter', 'b0000000-0000-4000-8000-0000000000f1')$$,
  '23503', NULL,
  'an agent of A cannot use a prompt of B');
SELECT throws_ok(
  $$UPDATE public.prompts SET workspace_id = 'a0000000-0000-4000-8000-000000000001'
    WHERE id = 'b0000000-0000-4000-8000-0000000000f1'$$,
  '23503', NULL,
  'a prompt cannot be moved to another workspace');
SELECT lives_ok(
  $$INSERT INTO public.prompt_versions (id, workspace_id, prompt_id, version, body)
    VALUES ('a0000000-0000-4000-8000-0000000000f2', 'a0000000-0000-4000-8000-000000000001',
            'a0000000-0000-4000-8000-0000000000f1', 1, 'A prompt body');
    UPDATE public.prompts SET active_version_id = 'a0000000-0000-4000-8000-0000000000f2'
     WHERE id = 'a0000000-0000-4000-8000-0000000000f1'$$,
  'same-workspace prompt versions still work');

-- ── one active WhatsApp provider per workspace ──────────────────────────────
INSERT INTO public.integrations (workspace_id, provider, enabled, credentials, config) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'ycloud', true, '{}', '{}');
SELECT throws_ok(
  $$INSERT INTO public.integrations (workspace_id, provider, enabled, credentials, config)
    VALUES ('a0000000-0000-4000-8000-000000000001', 'kapso', true, '{}', '{}')$$,
  '23505', NULL,
  'a workspace cannot have YCloud and Kapso enabled at the same time');
SELECT lives_ok(
  $$INSERT INTO public.integrations (workspace_id, provider, enabled, credentials, config)
    VALUES ('a0000000-0000-4000-8000-000000000001', 'kapso', false, '{}', '{}')$$,
  'a disabled second provider can be kept (switching back needs no re-entry)');

-- Switching in one transaction (workspace B): the replaced provider is kept
-- disabled, workspace settings travel, stale ones do not come back.
INSERT INTO public.integrations (workspace_id, provider, enabled, credentials, config) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'ycloud', true, '{"ycloud_api_key": "yk"}',
   '{"phone_number": "+5215550000000", "buffer_silence_seconds": 12, "message_history_window": 20, "jev_enabled": true}'),
  ('b0000000-0000-4000-8000-000000000001', 'kapso', false, '{}',
   '{"phone_number_id": "pn_old", "message_history_window": 99, "jev_stage": "stale"}');
SELECT is(
  public.save_whatsapp_integration('b0000000-0000-4000-8000-000000000001', 'kapso', true,
    '{"kapso_api_key": "kp"}', '{"phone_number_id": "pn_1", "buffer_silence_seconds": 15}',
    ARRAY['buffer_silence_seconds', 'message_history_window', 'jev_enabled', 'jev_stage']),
  'ycloud',
  'switching returns the provider it replaced');
SELECT is(
  (SELECT enabled FROM public.integrations
    WHERE workspace_id = 'b0000000-0000-4000-8000-000000000001' AND provider = 'ycloud'),
  false,
  'the replaced provider is disabled, not deleted');
SELECT is(
  (SELECT config FROM public.integrations
    WHERE workspace_id = 'b0000000-0000-4000-8000-000000000001' AND provider = 'kapso'),
  '{"phone_number_id": "pn_1", "buffer_silence_seconds": 15, "message_history_window": 20, "jev_enabled": true}'::jsonb,
  'workspace settings travel, stale ones do not come back, the caller wins');
SELECT is(
  (SELECT credentials ->> 'ycloud_api_key' FROM public.integrations
    WHERE workspace_id = 'b0000000-0000-4000-8000-000000000001' AND provider = 'ycloud'),
  'yk',
  'the replaced provider keeps its credentials');
SELECT is(
  public.save_whatsapp_integration('b0000000-0000-4000-8000-000000000001', 'kapso', true,
    '{"kapso_api_key": "kp"}', '{"message_history_window": 30}',
    ARRAY['buffer_silence_seconds', 'message_history_window', 'jev_enabled', 'jev_stage']),
  NULL,
  'saving the active provider again is not a switch');
SELECT is(
  (SELECT config ->> 'phone_number_id' FROM public.integrations
    WHERE workspace_id = 'b0000000-0000-4000-8000-000000000001' AND provider = 'kapso'),
  'pn_1',
  'a plain save merges into the stored config');
SELECT throws_ok(
  $$SELECT public.save_whatsapp_integration('b0000000-0000-4000-8000-000000000001',
      'openrouter', true, '{}', '{}', '{}')$$,
  '22023', NULL,
  'only WhatsApp providers go through save_whatsapp_integration()');

-- ── 24h guard: records that are not sends pass with the window closed ───────
UPDATE public.conversations SET window_expires_at = now() - interval '1 day'
 WHERE id = 'b0000000-0000-4000-8000-0000000000d1';
SELECT lives_ok(
  $$INSERT INTO public.messages (workspace_id, conversation_id, direction, type, body, meta)
    VALUES ('b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000d1',
            'out', 'system', 'nota', '{"internal": true}')$$,
  'an internal note is saved after the 24h window closed');
SELECT lives_ok(
  $$INSERT INTO public.messages (workspace_id, conversation_id, direction, type, body, meta)
    VALUES ('b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000d1',
            'out', 'text', 'respondido desde el celular', '{"origin": "business_app"}')$$,
  'a WhatsApp Business App echo is recorded after the 24h window closed');
SELECT throws_like(
  $$INSERT INTO public.messages (workspace_id, conversation_id, direction, type, body)
    VALUES ('b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000d1',
            'out', 'text', 'hola')$$,
  '%WINDOW_EXPIRED%',
  'free text is still blocked after the 24h window closed');

-- ── users are visible exactly to the people they work with ──────────────────
INSERT INTO auth.users (id, email, instance_id, aud, role) VALUES
  ('a0000000-0000-4000-8000-0000000000e1', 'sec-a@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('a0000000-0000-4000-8000-0000000000e2', 'sec-a2@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('b0000000-0000-4000-8000-0000000000e1', 'sec-b@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
INSERT INTO public.users (id, full_name, email) VALUES
  ('a0000000-0000-4000-8000-0000000000e1', 'A user', 'sec-a@test.local'),
  ('a0000000-0000-4000-8000-0000000000e2', 'A colleague', 'sec-a2@test.local'),
  ('b0000000-0000-4000-8000-0000000000e1', 'B user', 'sec-b@test.local');
INSERT INTO public.memberships (workspace_id, user_id, role, is_active) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000e1', 'viewer', true),
  ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000e2', 'agent', false),
  ('b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000e1', 'admin', true);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
SELECT isnt_empty(
  $$SELECT 1 FROM public.users WHERE email = 'sec-a@test.local'$$,
  'a user sees their own row');
SELECT isnt_empty(
  $$SELECT 1 FROM public.users WHERE email = 'sec-a2@test.local'$$,
  'a user sees (past) colleagues of their workspace, so message senders resolve');
SELECT is_empty(
  $$SELECT 1 FROM public.users WHERE email = 'sec-b@test.local'$$,
  'a user cannot read the users of a workspace they do not belong to');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
