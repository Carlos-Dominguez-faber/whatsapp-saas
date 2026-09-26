-- Security regression tests — run with `supabase test db` against a local stack.
--
-- Each assertion pins a hole that was open in a published version: if a future
-- migration re-grants a privilege or drops a constraint, this fails instead of
-- the next install silently shipping the hole again.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(92);

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
SELECT ok(NOT has_function_privilege('anon',
  'public.upsert_batch_and_link_message(uuid,uuid,uuid,integer,boolean)', 'EXECUTE'),
  'anon cannot execute upsert_batch_and_link_message()');
SELECT ok(NOT has_function_privilege('authenticated',
  'public.upsert_batch_and_link_message(uuid,uuid,uuid,integer,boolean)', 'EXECUTE'),
  'authenticated cannot execute upsert_batch_and_link_message()');
SELECT ok(NOT has_table_privilege('authenticated', 'public.message_errors', 'SELECT'),
  'sessions cannot read message_errors (technical send detail stays on the server)');

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

-- ── LLM budget functions: service role only ─────────────────────────────────
SELECT ok(NOT has_function_privilege('anon', 'public.reserve_llm_turn(uuid, text, integer)', 'EXECUTE'),
  'anon cannot execute reserve_llm_turn()');
SELECT ok(NOT has_function_privilege('authenticated', 'public.reserve_llm_turn(uuid, text, integer)', 'EXECUTE'),
  'authenticated cannot execute reserve_llm_turn()');
SELECT ok(has_function_privilege('service_role', 'public.reserve_llm_turn(uuid, text, integer)', 'EXECUTE'),
  'service_role can execute reserve_llm_turn()');
SELECT ok(NOT has_function_privilege('anon', 'public.sum_daily_llm_tokens(uuid, timestamptz)', 'EXECUTE'),
  'anon cannot execute sum_daily_llm_tokens()');
SELECT ok(NOT has_function_privilege('authenticated', 'public.sum_daily_llm_tokens(uuid, timestamptz)', 'EXECUTE'),
  'authenticated cannot execute sum_daily_llm_tokens()');
SELECT ok(has_function_privilege('service_role', 'public.sum_daily_llm_tokens(uuid, timestamptz)', 'EXECUTE'),
  'service_role can execute sum_daily_llm_tokens()');
SELECT ok(NOT has_function_privilege('anon', 'public.reserve_workspace_llm_call(uuid, text, integer)', 'EXECUTE'),
  'anon cannot execute reserve_workspace_llm_call()');
SELECT ok(NOT has_function_privilege('authenticated', 'public.reserve_workspace_llm_call(uuid, text, integer)', 'EXECUTE'),
  'authenticated cannot execute reserve_workspace_llm_call()');
SELECT ok(has_function_privilege('service_role', 'public.reserve_workspace_llm_call(uuid, text, integer)', 'EXECUTE'),
  'service_role can execute reserve_workspace_llm_call()');

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
SELECT fk_ok('public', 'message_errors', ARRAY['workspace_id', 'message_id'], 'public', 'messages', ARRAY['workspace_id', 'id']);
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

-- ── LLM budget functions: behavior ───────────────────────────────────────────
SELECT is((SELECT allowed FROM public.reserve_llm_turn('a0000000-0000-4000-8000-000000000001', 'contact-x', 2)),
  true, 'reserve_llm_turn allows the first turn under the hourly limit');
SELECT is((SELECT allowed FROM public.reserve_llm_turn('a0000000-0000-4000-8000-000000000001', 'contact-x', 2)),
  true, 'reserve_llm_turn allows the turn that reaches the limit');
SELECT is((SELECT allowed FROM public.reserve_llm_turn('a0000000-0000-4000-8000-000000000001', 'contact-x', 2)),
  false, 'reserve_llm_turn denies once the contact is at the hourly limit');
SELECT throws_ok(
  $$SELECT * FROM public.reserve_workspace_llm_call('a0000000-0000-4000-8000-000000000001', 'llm_usage', 5)$$,
  '22023', NULL,
  'reserve_workspace_llm_call refuses a type other than the manager tools');
SELECT is((SELECT allowed FROM public.reserve_workspace_llm_call('a0000000-0000-4000-8000-000000000001', 'template_generate', 1)),
  true, 'reserve_workspace_llm_call allows a draft under the hourly limit');
SELECT is((SELECT allowed FROM public.reserve_workspace_llm_call('a0000000-0000-4000-8000-000000000001', 'template_generate', 1)),
  false, 'reserve_workspace_llm_call denies once the workspace is at the hourly limit');
INSERT INTO public.events (workspace_id, type, payload) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'llm_usage', '{"total_tokens": 100}'),
  ('b0000000-0000-4000-8000-000000000001', 'template_generate', '{"total_tokens": 20}'),
  ('b0000000-0000-4000-8000-000000000001', 'agent_test_chat', '{"total_tokens": 3}'),
  ('b0000000-0000-4000-8000-000000000001', 'cost_alert', '{"total_tokens": 1000}'),
  ('a0000000-0000-4000-8000-000000000001', 'llm_usage', '{"total_tokens": 5000}');
SELECT is(public.sum_daily_llm_tokens('b0000000-0000-4000-8000-000000000001', now() - interval '1 day'),
  123::bigint, 'sum_daily_llm_tokens adds agent turns, template drafts and playground calls of one workspace');
INSERT INTO public.events (workspace_id, type, payload) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'llm_usage', '{"total_tokens": "99999999999999999999999"}'),
  ('b0000000-0000-4000-8000-000000000001', 'llm_usage', '{"total_tokens": "-5"}');
SELECT is(public.sum_daily_llm_tokens('b0000000-0000-4000-8000-000000000001', now() - interval '1 day'),
  123::bigint, 'sum_daily_llm_tokens ignores a total_tokens that would overflow bigint instead of failing');

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

-- ── sessions cannot write the events the budget reads ───────────────────────
-- Even an admin of the workspace: the type check does not depend on the role,
-- so what an admin cannot insert, an agent cannot either.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"b0000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
SELECT throws_ok(
  $$INSERT INTO public.events (workspace_id, type, payload)
    VALUES ('b0000000-0000-4000-8000-000000000001', 'llm_usage', '{"total_tokens": 999999}')$$,
  '42501', NULL, 'a session cannot insert llm_usage (fake spend that cuts the agent off)');
SELECT throws_ok(
  $$INSERT INTO public.events (workspace_id, type, payload)
    VALUES ('b0000000-0000-4000-8000-000000000001', 'template_generate', '{}')$$,
  '42501', NULL, 'a session cannot insert template_generate');
SELECT throws_ok(
  $$INSERT INTO public.events (workspace_id, type, payload)
    VALUES ('b0000000-0000-4000-8000-000000000001', 'agent_test_chat', '{}')$$,
  '42501', NULL, 'a session cannot insert agent_test_chat');
SELECT throws_ok(
  $$INSERT INTO public.events (workspace_id, type, payload)
    VALUES ('b0000000-0000-4000-8000-000000000001', 'cost_cut', '{}')$$,
  '42501', NULL, 'a session cannot pre-empt the daily cost_cut event');
SELECT throws_ok(
  $$INSERT INTO public.events (workspace_id, type, payload)
    VALUES ('b0000000-0000-4000-8000-000000000001', 'cost_alert', '{}')$$,
  '42501', NULL, 'a session cannot pre-empt the daily cost_alert event');
SELECT throws_ok(
  $$INSERT INTO public.events (workspace_id, type, payload)
    VALUES ('b0000000-0000-4000-8000-000000000001', 'model_outside_catalog', '{}')$$,
  '42501', NULL, 'a session cannot pre-empt the daily model_outside_catalog event');
SELECT lives_ok(
  $$INSERT INTO public.events (workspace_id, type, payload)
    VALUES ('b0000000-0000-4000-8000-000000000001', 'note_viewed', '{}')$$,
  'a session still inserts other event types in its workspace');
RESET ROLE;

-- ── the buffer: one batch per conversation, stale leases counted ───────────
-- Dates far in the past put these batches first in claim_next_batch()'s order,
-- whatever else the database holds. updated_at is set on INSERT: an UPDATE
-- would have trg_batches_updated_at reset it to now().
INSERT INTO public.contacts (id, workspace_id, phone) VALUES
  ('b0000000-0000-4000-8000-0000000000c2', 'b0000000-0000-4000-8000-000000000001', '+15550002222');
INSERT INTO public.conversations (id, workspace_id, contact_id) VALUES
  ('b0000000-0000-4000-8000-0000000000d2', 'b0000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-0000000000c2');
INSERT INTO public.message_batches (id, workspace_id, conversation_id, status, silence_ms, flush_at, message_count, meta, updated_at) VALUES
  ('b0000000-0000-4000-8000-0000000000b1', 'b0000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-0000000000d1', 'processing', 0, '2000-01-01', 1, '{}', now()),
  ('b0000000-0000-4000-8000-0000000000b2', 'b0000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-0000000000d1', 'buffering', 0, '2000-01-02', 1, '{}', now());
SELECT ok(NOT EXISTS (
    SELECT 1 FROM public.claim_next_batch() c WHERE c.id = 'b0000000-0000-4000-8000-0000000000b2'),
  'a due batch waits while another batch of its conversation is being processed');

INSERT INTO public.message_batches (id, workspace_id, conversation_id, status, silence_ms, flush_at, message_count, meta, updated_at) VALUES
  ('b0000000-0000-4000-8000-0000000000b3', 'b0000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-0000000000d2', 'processing', 0, '1999-12-31', 1,
   '{"retry_count": 1}', now() - interval '8 minutes'),
  ('b0000000-0000-4000-8000-0000000000b4', 'b0000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-0000000000d2', 'processing', 0, '1999-12-30', 1,
   '{"retry_count": 3}', now() - interval '8 minutes');
SELECT is(
  (SELECT (c.meta->>'retry_count')::int FROM public.claim_next_batch() c
    WHERE c.id = 'b0000000-0000-4000-8000-0000000000b3'),
  2, 'a stale batch is reclaimed (7-minute lease) and the retry is counted');
SELECT is(
  (SELECT status::text FROM public.message_batches WHERE id = 'b0000000-0000-4000-8000-0000000000b4'),
  'cancelled', 'a stale batch that burned its retries is dead-lettered');
SELECT ok(EXISTS (
    SELECT 1 FROM public.events
     WHERE type = 'batch_dead_letter'
       AND payload->>'batch_id' = 'b0000000-0000-4000-8000-0000000000b4'),
  'the dead-letter leaves an event');
SELECT is(
  (SELECT state::text FROM public.conversations WHERE id = 'b0000000-0000-4000-8000-0000000000d2'),
  'handoff_pending', 'a dead-lettered batch hands its conversation to a person');
SELECT ok(EXISTS (
    SELECT 1 FROM public.messages
     WHERE conversation_id = 'b0000000-0000-4000-8000-0000000000d2'
       AND type = 'system' AND (meta->>'internal')::boolean
       AND meta->>'batch_id' = 'b0000000-0000-4000-8000-0000000000b4'),
  'and leaves an internal note in the thread saying why');

INSERT INTO public.messages (id, workspace_id, conversation_id, direction, type, body, wamid) VALUES
  ('b0000000-0000-4000-8000-0000000000a1', 'b0000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-0000000000d1', 'in', 'text', 'orphan', 'wamid.sec.orphan'),
  ('b0000000-0000-4000-8000-0000000000a2', 'b0000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-0000000000d1', 'in', 'text', 'new', 'wamid.sec.new');
SELECT public.upsert_batch_and_link_message(
  'b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000d1',
  'b0000000-0000-4000-8000-0000000000a1', 60000, true);
SELECT public.upsert_batch_and_link_message(
  'b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000d1',
  'b0000000-0000-4000-8000-0000000000a2', 60000, false);
SELECT is(
  (SELECT b.meta->>'isolated' FROM public.message_batches b
     JOIN public.messages m ON m.batch_id = b.id
    WHERE m.id = 'b0000000-0000-4000-8000-0000000000a1'),
  'true', 'a reconciled orphan gets an isolated batch');
SELECT isnt(
  (SELECT batch_id FROM public.messages WHERE id = 'b0000000-0000-4000-8000-0000000000a2'),
  (SELECT batch_id FROM public.messages WHERE id = 'b0000000-0000-4000-8000-0000000000a1'),
  'a new message never joins an isolated batch');

-- ── the claim: oldest first, one per conversation, no stall ─────────────────
INSERT INTO public.contacts (id, workspace_id, phone) VALUES
  ('b0000000-0000-4000-8000-0000000000c3', 'b0000000-0000-4000-8000-000000000001', '+15550003333'),
  ('b0000000-0000-4000-8000-0000000000c4', 'b0000000-0000-4000-8000-000000000001', '+15550004444'),
  ('b0000000-0000-4000-8000-0000000000c5', 'b0000000-0000-4000-8000-000000000001', '+15550005555'),
  ('b0000000-0000-4000-8000-0000000000c6', 'b0000000-0000-4000-8000-000000000001', '+15550006666');
INSERT INTO public.conversations (id, workspace_id, contact_id) VALUES
  ('b0000000-0000-4000-8000-0000000000d3', 'b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000c3'),
  ('b0000000-0000-4000-8000-0000000000d4', 'b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000c4'),
  ('b0000000-0000-4000-8000-0000000000d5', 'b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000c5'),
  ('b0000000-0000-4000-8000-0000000000d6', 'b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000c6');

-- d3: one batch in flight and 55 due ones behind it (the old claim looked at
-- the 50 oldest due batches only, all blocked, and returned nothing to anyone).
INSERT INTO public.message_batches (workspace_id, conversation_id, status, silence_ms, flush_at, message_count, meta, created_at, updated_at)
VALUES ('b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000d3',
        'processing', 0, '1990-01-01', 1, '{}', '2026-01-01', now());
INSERT INTO public.message_batches (workspace_id, conversation_id, status, silence_ms, flush_at, message_count, meta, created_at)
SELECT 'b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000d3',
       'buffering', 0, '1990-01-02'::timestamptz + g * interval '1 second', 1, '{}',
       '2026-01-02'::timestamptz + g * interval '1 second'
  FROM generate_series(1, 55) AS g;
INSERT INTO public.message_batches (id, workspace_id, conversation_id, status, silence_ms, flush_at, message_count, meta)
VALUES ('b0000000-0000-4000-8000-0000000000b5', 'b0000000-0000-4000-8000-000000000001',
        'b0000000-0000-4000-8000-0000000000d4', 'buffering', 0, '1995-01-01', 1, '{}');
SELECT is(
  (SELECT c.id FROM public.claim_next_batch() c),
  'b0000000-0000-4000-8000-0000000000b5'::uuid,
  'many blocked batches of one conversation do not stall everyone else');

-- d5: a retry waiting out its backoff is older than a due batch.
INSERT INTO public.message_batches (id, workspace_id, conversation_id, status, silence_ms, flush_at, message_count, meta, created_at) VALUES
  ('b0000000-0000-4000-8000-0000000000b6', 'b0000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-0000000000d5', 'buffering', 0, now() + interval '1 hour', 1,
   '{"isolated": true, "retry_count": 1, "pending_reply": "hola"}', '2026-01-01'),
  ('b0000000-0000-4000-8000-0000000000b7', 'b0000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-0000000000d5', 'buffering', 0, '1996-01-01', 1, '{}', '2026-01-02');
SELECT ok(NOT EXISTS (
    SELECT 1 FROM public.claim_next_batch() c WHERE c.id = 'b0000000-0000-4000-8000-0000000000b7'),
  'a newer batch never overtakes a retry of its conversation');

-- d6: a due batch nobody has claimed yet keeps absorbing messages.
INSERT INTO public.message_batches (id, workspace_id, conversation_id, status, silence_ms, flush_at, message_count, meta) VALUES
  ('b0000000-0000-4000-8000-0000000000b8', 'b0000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-0000000000d6', 'buffering', 30000, now() - interval '1 minute', 1, '{}');
INSERT INTO public.messages (id, workspace_id, conversation_id, direction, type, body, wamid) VALUES
  ('b0000000-0000-4000-8000-0000000000a3', 'b0000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-0000000000d6', 'in', 'text', 'y otra cosa', 'wamid.sec.absorb');
SELECT is(
  public.upsert_batch_and_link_message(
    'b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000d6',
    'b0000000-0000-4000-8000-0000000000a3', 30000, false),
  'b0000000-0000-4000-8000-0000000000b8'::uuid,
  'a due, unclaimed batch absorbs a new message: one reply, not one each');

-- ── one local contact per HighLevel contact, per workspace ──────────────────
UPDATE public.contacts SET hl_contact_id = 'hl-sec-1'
 WHERE id = 'b0000000-0000-4000-8000-0000000000c1';
SELECT throws_ok(
  $$UPDATE public.contacts SET hl_contact_id = 'hl-sec-1'
     WHERE id = 'b0000000-0000-4000-8000-0000000000c2'$$,
  '23505', NULL, 'two contacts of a workspace cannot share a HighLevel id');
INSERT INTO public.contacts (id, workspace_id, phone) VALUES
  ('a0000000-0000-4000-8000-0000000000c1', 'a0000000-0000-4000-8000-000000000001', '+15550009999');
SELECT lives_ok(
  $$UPDATE public.contacts SET hl_contact_id = 'hl-sec-1'
     WHERE id = 'a0000000-0000-4000-8000-0000000000c1'$$,
  'another workspace may link its own contact to the same HighLevel id');

SELECT * FROM finish();
ROLLBACK;
