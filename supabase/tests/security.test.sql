-- Security regression tests — run with `supabase test db` against a local stack.
--
-- Each assertion pins a hole that was open in a published version: if a future
-- migration re-grants a privilege or drops a constraint, this fails instead of
-- the next install silently shipping the hole again.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(196);

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
SELECT throws_ok(
  $$INSERT INTO public.events (workspace_id, type, payload)
    VALUES ('b0000000-0000-4000-8000-000000000001', 'note_viewed', '{}')$$,
  '42501', NULL, 'a session inserts no event at all: only the server writes events');
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

INSERT INTO public.contacts (id, workspace_id, phone) VALUES
  ('b0000000-0000-4000-8000-0000000000c7', 'b0000000-0000-4000-8000-000000000001', '+15550007777');
INSERT INTO public.conversations (id, workspace_id, contact_id) VALUES
  ('b0000000-0000-4000-8000-0000000000d7', 'b0000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-0000000000c7');
INSERT INTO public.message_batches (id, workspace_id, conversation_id, status, silence_ms, flush_at, message_count, meta, updated_at) VALUES
  ('b0000000-0000-4000-8000-0000000000b3', 'b0000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-0000000000d2', 'processing', 0, '1999-12-31', 1,
   '{"retry_count": 1}', now() - interval '8 minutes'),
  ('b0000000-0000-4000-8000-0000000000b4', 'b0000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-0000000000d2', 'processing', 0, '1999-12-30', 1,
   '{"retry_count": 3}', now() - interval '8 minutes'),
  -- Reclaimed twice past the limit and still stale: the backstop.
  ('b0000000-0000-4000-8000-0000000000b9', 'b0000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-0000000000d7', 'processing', 0, '1999-12-29', 1,
   '{"retry_count": 5}', now() - interval '8 minutes'),
  ('b0000000-0000-4000-8000-0000000000ba', 'b0000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-0000000000d7', 'processing', 0, '1999-12-28', 1,
   '{"retry_count": 5}', now() - interval '8 minutes');
-- ba's reply went out; b9 has only a send WhatsApp didn't accept.
INSERT INTO public.messages (workspace_id, conversation_id, direction, type, body, status, meta) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000d7',
   'out', 'text', 'respuesta', 'sent', '{"batch_id": "b0000000-0000-4000-8000-0000000000ba"}'),
  ('b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000d7',
   'out', 'text', 'respuesta', 'failed',
   '{"batch_id": "b0000000-0000-4000-8000-0000000000b9", "not_accepted": true}');
SELECT is(
  (SELECT (c.meta->>'retry_count')::int FROM public.claim_next_batch() c
    WHERE c.id = 'b0000000-0000-4000-8000-0000000000b3'),
  2, 'a stale batch is reclaimed (7-minute lease) and the retry is counted');
SELECT is(
  (SELECT status::text FROM public.message_batches WHERE id = 'b0000000-0000-4000-8000-0000000000b4'),
  'processing', 'a stale batch just past its retries is left for buffer.ts to dead-letter');
SELECT is(
  (SELECT status::text FROM public.message_batches WHERE id = 'b0000000-0000-4000-8000-0000000000b9'),
  'cancelled', 'the backstop dead-letters a batch whose every reclaim died');
SELECT ok(EXISTS (
    SELECT 1 FROM public.events
     WHERE type = 'batch_dead_letter'
       AND payload->>'batch_id' = 'b0000000-0000-4000-8000-0000000000b9'),
  'the dead-letter leaves an event');
SELECT is(
  (SELECT state::text FROM public.conversations WHERE id = 'b0000000-0000-4000-8000-0000000000d7'),
  'handoff_pending', 'a dead-lettered batch hands its conversation to a person');
SELECT ok(EXISTS (
    SELECT 1 FROM public.messages
     WHERE conversation_id = 'b0000000-0000-4000-8000-0000000000d7'
       AND type = 'system' AND (meta->>'internal')::boolean
       AND meta->>'batch_id' = 'b0000000-0000-4000-8000-0000000000b9'),
  'and leaves an internal note in the thread saying why');
SELECT is(
  (SELECT status::text FROM public.message_batches WHERE id = 'b0000000-0000-4000-8000-0000000000ba'),
  'processed', 'the backstop closes a batch whose reply went out');
SELECT ok(NOT EXISTS (
    SELECT 1 FROM public.events
     WHERE type = 'batch_dead_letter'
       AND payload->>'batch_id' = 'b0000000-0000-4000-8000-0000000000ba'),
  'without a dead letter');

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

-- ── n8n tools: admins only, and never the auth header ──────────────────────
SELECT ok(NOT has_column_privilege('authenticated', 'public.n8n_tools', 'auth_header_value', 'SELECT'),
  'sessions cannot read an n8n tool''s auth header');
SELECT ok(has_column_privilege('authenticated', 'public.n8n_tools', 'webhook_url', 'SELECT'),
  'a session may read the rest of an n8n tool (RLS limits it to admins)');
SELECT ok(NOT has_table_privilege('authenticated', 'public.n8n_tools', 'INSERT'),
  'sessions cannot insert n8n tools (the admin-only API does)');
SELECT ok(NOT has_table_privilege('authenticated', 'public.n8n_tools', 'UPDATE'),
  'sessions cannot update n8n tools');
SELECT ok(NOT has_table_privilege('authenticated', 'public.n8n_tools', 'DELETE'),
  'sessions cannot delete n8n tools');
SELECT ok(NOT has_table_privilege('anon', 'public.n8n_tools', 'SELECT'),
  'anon cannot read n8n tools');
INSERT INTO public.n8n_tools (id, workspace_id, name, description, mode, webhook_url, auth_header_name, auth_header_value) VALUES
  ('a0000000-0000-4000-8000-0000000000a8', 'a0000000-0000-4000-8000-000000000001', 'n8n_a', 'A tool', 'sync',
   'https://hooks.example/a', 'Authorization', 'enc:v1:iv:ct'),
  ('b0000000-0000-4000-8000-0000000000a8', 'b0000000-0000-4000-8000-000000000001', 'n8n_b', 'B tool', 'sync',
   'https://hooks.example/b', NULL, NULL);
SELECT is((SELECT sensitivity FROM public.n8n_tools WHERE name = 'n8n_b'), 'write',
  'an n8n tool is a write tool unless marked read');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
SELECT is_empty($$SELECT id FROM public.n8n_tools$$,
  'a viewer does not see their workspace''s n8n tools');
SELECT set_config('request.jwt.claims',
  '{"sub":"b0000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
SELECT results_eq($$SELECT name FROM public.n8n_tools$$, $$VALUES ('n8n_b'::text)$$,
  'an admin sees only their own workspace''s n8n tools');
SELECT throws_ok($$SELECT auth_header_value FROM public.n8n_tools$$, '42501', NULL,
  'not even an admin session reads the auth header');

-- ── sessions cannot write the events the server audits, dedupes or caps on ──
SELECT throws_ok(
  $$INSERT INTO public.events (workspace_id, type, payload)
    VALUES ('b0000000-0000-4000-8000-000000000001', 'member_password_reset', '{}')$$,
  '42501', NULL, 'a session cannot fake a password-reset audit entry');
SELECT throws_ok(
  $$INSERT INTO public.events (workspace_id, type, payload)
    VALUES ('b0000000-0000-4000-8000-000000000001', 'Member_Password_Reset', '{}')$$,
  '42501', NULL, 'nor a variant spelling of it');
SELECT throws_ok(
  $$INSERT INTO public.events (workspace_id, type, payload)
    VALUES ('b0000000-0000-4000-8000-000000000001', 'handoff_ack_sent', '{}')$$,
  '42501', NULL, 'a session cannot silence the contact''s handoff acknowledgement');
SELECT throws_ok(
  $$INSERT INTO public.events (workspace_id, type, payload)
    VALUES ('b0000000-0000-4000-8000-000000000001', 'handoff_team_notified', '{}')$$,
  '42501', NULL, 'a session cannot use up the team email cap');
SELECT throws_ok(
  $$INSERT INTO public.events (workspace_id, type, payload)
    VALUES ('b0000000-0000-4000-8000-000000000001', 'jev_judgment', '{}')$$,
  '42501', NULL, 'a session cannot use up the daily JEV quota');
RESET ROLE;

-- ── Phase 3 tools are in the catalog ────────────────────────────────────────
SELECT is((SELECT sensitivity::text FROM public.tools WHERE key = 'handoff_human'), 'read',
  'handoff_human is read: running it changes nothing, the buffer hands off');
SELECT is((SELECT sensitivity::text FROM public.tools WHERE key = 'cancel_highlevel'), 'write',
  'cancel_highlevel is a write tool');
SELECT ok((SELECT schema::text FROM public.tools WHERE key = 'reschedule_highlevel') LIKE '%appointment_datetime_iso%',
  'reschedule_highlevel asks for the appointment''s confirmed date');
SELECT is((SELECT sensitivity::text FROM public.tools WHERE key = 'list_highlevel_appointments'), 'read',
  'list_highlevel_appointments is a read tool');
SELECT ok(NOT has_table_privilege('authenticated', 'public.events', 'INSERT'),
  'sessions have no INSERT on events');

-- ── one local appointment per HighLevel appointment ─────────────────────────
INSERT INTO public.appointments (workspace_id, scheduled_at, hl_appointment_id)
  VALUES ('b0000000-0000-4000-8000-000000000001', now() + interval '1 day', 'hl_dup_test');
SELECT throws_ok(
  $$INSERT INTO public.appointments (workspace_id, scheduled_at, hl_appointment_id)
    VALUES ('b0000000-0000-4000-8000-000000000001', now() + interval '2 days', 'hl_dup_test')$$,
  '23505', NULL, 'a second local row cannot hold the same HighLevel appointment');
SELECT lives_ok(
  $$INSERT INTO public.appointments (workspace_id, scheduled_at, hl_appointment_id)
    VALUES ('a0000000-0000-4000-8000-000000000001', now() + interval '2 days', 'hl_dup_test')$$,
  'another workspace keeps its own row for that id');
SELECT lives_ok(
  $$INSERT INTO public.appointments (workspace_id, scheduled_at) VALUES
    ('b0000000-0000-4000-8000-000000000001', now() + interval '3 days'),
    ('b0000000-0000-4000-8000-000000000001', now() + interval '3 days')$$,
  'rows booked without HighLevel carry no id and never collide');
SELECT lives_ok(
  $$INSERT INTO public.appointments (workspace_id, scheduled_at, hl_appointment_id, status)
    VALUES ('b0000000-0000-4000-8000-000000000001', now() + interval '4 days', 'hl_dup_test', 'cancelled')
    ON CONFLICT (workspace_id, hl_appointment_id)
    DO UPDATE SET scheduled_at = EXCLUDED.scheduled_at, status = EXCLUDED.status$$,
  'the index backs the write-back''s upsert on (workspace_id, hl_appointment_id)');
SELECT is(
  (SELECT indexdef ILIKE '% WHERE %' FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'uq_appointments_workspace_hl_appointment_id'),
  false,
  'the appointments HighLevel index is total, not partial');
SELECT ok(
  (SELECT schema #> '{properties,timezone}' IS NULL FROM public.tools WHERE key = 'check_availability'),
  'check_availability no longer takes a time zone from the model');

-- ── custom_webhook retired: its config becomes a disabled n8n tool ───────────
SELECT is((SELECT count(*)::int FROM public.tools WHERE key = 'custom_webhook'), 0,
  'custom_webhook is no longer in the catalog');
-- An install that still has it: the migration's function moves the config.
INSERT INTO public.tools (key, name, description, schema, sensitivity)
  VALUES ('custom_webhook', 'Webhook personalizado', 'x', '{}', 'sensitive');
INSERT INTO public.tool_configs (workspace_id, tool_id, enabled, config)
  SELECT 'b0000000-0000-4000-8000-000000000001', id, true,
         '{"webhook_url": "https://hooks.example/legacy",
           "payload_fields": [{"key": "nombre", "value": "{{contact.name}}"},
                              {"key": "token", "value": "sk_live_secret123"}],
           "auth_header_name": "X-Token", "auth_header_value": "plain-secret"}'
    FROM public.tools WHERE key = 'custom_webhook';
-- Turned off, with a header the API would refuse: migrated, disabled, no header.
INSERT INTO public.tool_configs (workspace_id, tool_id, enabled, config)
  SELECT 'a0000000-0000-4000-8000-000000000001', id, false,
         '{"webhook_url": "https://hooks.example/off",
           "auth_header_name": "Bad Header!", "auth_header_value": "x"}'
    FROM public.tools WHERE key = 'custom_webhook';
-- Never given a URL: nothing to carry.
INSERT INTO public.workspaces (id, name, slug)
  VALUES ('d0000000-0000-4000-8000-000000000001', 'D', 'sec-test-d');
INSERT INTO public.tool_configs (workspace_id, tool_id, enabled, config)
  SELECT 'd0000000-0000-4000-8000-000000000001', id, true, '{"payload_fields": []}'
    FROM public.tools WHERE key = 'custom_webhook';
-- The workspace already has an n8n tool by the name the migration would pick.
INSERT INTO public.n8n_tools (workspace_id, name, description, mode, webhook_url)
  VALUES ('b0000000-0000-4000-8000-000000000001', 'webhook_personalizado', 'ya existía', 'sync',
          'https://hooks.example/x');
SELECT is(public.retire_custom_webhook(), 2, 'the configs with a URL are moved to n8n_tools');
SELECT results_eq(
  $$SELECT enabled, webhook_url, mode, sensitivity, auth_header_name, auth_header_value
      FROM public.n8n_tools WHERE name = 'webhook_personalizado_2'$$,
  $$VALUES (false, 'https://hooks.example/legacy'::text, 'async'::text, 'write'::text,
            'X-Token'::text, 'plain-secret'::text)$$,
  'as a disabled write tool, under a name the workspace didn''t use, its header left for encrypt-credentials');
SELECT ok(
  (SELECT description LIKE '%Migrada desde custom_webhook — revisa antes de activar%nombre={{contact.name}}, token (valor fijo, no se copia)%'
     FROM public.n8n_tools WHERE name = 'webhook_personalizado_2'),
  'its description says it was migrated and names the old payload fields');
SELECT ok(
  (SELECT description NOT LIKE '%sk_live_secret123%'
     FROM public.n8n_tools WHERE name = 'webhook_personalizado_2'),
  'a fixed payload value never reaches the description the model reads');
SELECT results_eq(
  $$SELECT enabled, auth_header_name, auth_header_value FROM public.n8n_tools
     WHERE workspace_id = 'a0000000-0000-4000-8000-000000000001' AND name = 'webhook_personalizado'$$,
  $$VALUES (false, NULL::text, NULL::text)$$,
  'a config that was off migrates disabled, and a header the API would refuse is dropped');
SELECT is_empty(
  $$SELECT id FROM public.n8n_tools WHERE workspace_id = 'd0000000-0000-4000-8000-000000000001'$$,
  'a config without a URL is skipped');
SELECT is((SELECT count(*)::int FROM public.tools WHERE key = 'custom_webhook'), 0,
  'and custom_webhook leaves the catalog, its configs with it');
SELECT is(public.retire_custom_webhook(), 0, 'a second run does nothing');
SELECT ok(NOT has_function_privilege('authenticated', 'public.retire_custom_webhook()', 'EXECUTE'),
  'sessions cannot run it');
SELECT ok(NOT has_function_privilege('anon', 'public.retire_custom_webhook()', 'EXECUTE'),
  'nor anon');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"b0000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
SELECT results_eq($$SELECT enabled FROM public.n8n_tools WHERE name = 'webhook_personalizado_2'$$,
  $$VALUES (false)$$, 'the workspace admin sees the migrated tool, disabled');
SELECT throws_ok($$SELECT auth_header_value FROM public.n8n_tools WHERE name = 'webhook_personalizado_2'$$,
  '42501', NULL, 'and cannot read its header');
RESET ROLE;

-- ── automation engine: server-only outbox, workspace-bound, capped ─────────
SELECT ok(NOT has_function_privilege('anon', 'public.claim_next_automation_run()', 'EXECUTE'),
  'anon cannot claim automation runs');
SELECT ok(NOT has_function_privilege('authenticated', 'public.claim_next_automation_run()', 'EXECUTE'),
  'sessions cannot claim automation runs');
SELECT ok(has_function_privilege('service_role', 'public.claim_next_automation_run()', 'EXECUTE'),
  'service_role can claim automation runs');
SELECT ok(NOT has_function_privilege('anon', 'public.mark_automation_run_dispatched(uuid, integer, integer)', 'EXECUTE'),
  'anon cannot mark a run dispatched');
SELECT ok(NOT has_function_privilege('authenticated', 'public.mark_automation_run_dispatched(uuid, integer, integer)', 'EXECUTE'),
  'sessions cannot mark a run dispatched');
SELECT ok(NOT has_function_privilege('authenticated', 'public.release_automation_run_dispatch(uuid)', 'EXECUTE'),
  'sessions cannot release a dispatch');
SELECT ok(NOT has_function_privilege('authenticated', 'public.append_contact_tags(uuid, uuid, text[])', 'EXECUTE'),
  'sessions cannot append tags through the definer function');
SELECT ok(NOT has_function_privilege('authenticated', 'public.automation_event_ttl(text)', 'EXECUTE'),
  'sessions cannot call automation_event_ttl');
SELECT hasnt_function('public', 'mark_automation_run_dispatched', ARRAY['uuid'],
  'the one-argument mark (no cooldown, no cap) is gone');
SELECT ok(NOT has_table_privilege('authenticated', 'public.automation_events', 'INSERT'),
  'sessions cannot insert into the automation outbox');
SELECT ok(NOT has_table_privilege('authenticated', 'public.automation_runs', 'INSERT'),
  'sessions cannot queue automation runs');
SELECT ok(NOT has_table_privilege('authenticated', 'public.automation_runs', 'UPDATE'),
  'sessions cannot change automation runs');
SELECT ok(NOT has_table_privilege('authenticated', 'public.automation_rules', 'UPDATE'),
  'sessions cannot write rules: the server checks the role, the schema and the cap');
SELECT policies_are('public', 'automation_rules', ARRAY['ws members read automations'],
  'members only read rules');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.automation_events'::regclass),
  'automation_events has RLS');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.automation_runs'::regclass),
  'automation_runs has RLS');
SELECT fk_ok('public', 'automation_events', ARRAY['workspace_id', 'conversation_id'], 'public', 'conversations', ARRAY['workspace_id', 'id']);
SELECT fk_ok('public', 'automation_events', ARRAY['workspace_id', 'contact_id'], 'public', 'contacts', ARRAY['workspace_id', 'id']);
SELECT fk_ok('public', 'automation_events', ARRAY['workspace_id', 'message_id'], 'public', 'messages', ARRAY['workspace_id', 'id']);
SELECT fk_ok('public', 'automation_events', ARRAY['workspace_id', 'rule_id'], 'public', 'automation_rules', ARRAY['workspace_id', 'id']);
SELECT fk_ok('public', 'automation_runs', ARRAY['workspace_id', 'conversation_id'], 'public', 'conversations', ARRAY['workspace_id', 'id']);
SELECT fk_ok('public', 'automation_runs', ARRAY['workspace_id', 'contact_id'], 'public', 'contacts', ARRAY['workspace_id', 'id']);
SELECT fk_ok('public', 'automation_runs', ARRAY['workspace_id', 'rule_id'], 'public', 'automation_rules', ARRAY['workspace_id', 'id']);
SELECT fk_ok('public', 'automation_runs', ARRAY['workspace_id', 'event_id'], 'public', 'automation_events', ARRAY['workspace_id', 'id']);
SELECT is_empty($$SELECT 1 FROM public.automation_rules WHERE enabled AND enabled_since IS NULL$$,
  'no rule is on without having been enabled under the engine (legacy rules start off)');

INSERT INTO public.contacts (id, workspace_id, phone, opt_in) VALUES
  ('b0000000-0000-4000-8000-0000000000c9', 'b0000000-0000-4000-8000-000000000001', '+15550009999', true);
INSERT INTO public.conversations (id, workspace_id, contact_id) VALUES
  ('b0000000-0000-4000-8000-0000000000d9', 'b0000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-0000000000c9');
INSERT INTO public.automation_rules (id, workspace_id, name, trigger_type, action_type, action_config, enabled, paused_reason) VALUES
  ('b0000000-0000-4000-8000-0000000000a9', 'b0000000-0000-4000-8000-000000000001', 'Bienvenida',
   'first_message', 'send_template', '{"template_name": "bienvenida"}', false, 'upgrade');
UPDATE public.automation_rules SET enabled = true WHERE id = 'b0000000-0000-4000-8000-0000000000a9';
SELECT results_eq(
  $$SELECT enabled_since IS NOT NULL, paused_reason FROM public.automation_rules
     WHERE id = 'b0000000-0000-4000-8000-0000000000a9'$$,
  $$VALUES (true, NULL::text)$$,
  'enabling a paused rule stamps enabled_since and clears why it was paused');

INSERT INTO public.messages (id, workspace_id, conversation_id, direction, type, body) VALUES
  ('b0000000-0000-4000-8000-0000000000b9', 'b0000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-0000000000d9', 'in', 'text', 'hola');
SELECT results_eq(
  $$SELECT event_type, contact_id FROM public.automation_events
     WHERE subject_id = 'b0000000-0000-4000-8000-0000000000d9'$$,
  $$VALUES ('first_message'::text, 'b0000000-0000-4000-8000-0000000000c9'::uuid)$$,
  'the first inbound message emits one first_message event, in the same transaction');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"b0000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
SELECT throws_ok(
  $$INSERT INTO public.automation_events (workspace_id, event_type, subject_id, occurrence)
    VALUES ('b0000000-0000-4000-8000-000000000001', 'first_message', gen_random_uuid(), 'x')$$,
  '42501', NULL, 'even an admin cannot plant an event in the outbox');
SELECT throws_ok(
  $$UPDATE public.automation_rules SET enabled = true$$,
  '42501', NULL, 'even an admin cannot switch a rule on behind the server');
SELECT isnt_empty($$SELECT 1 FROM public.automation_events$$,
  'a member reads the trace of their workspace');
RESET ROLE;

SELECT throws_ok(
  $$INSERT INTO public.automation_events (workspace_id, event_type, subject_id, occurrence, contact_id)
    VALUES ('a0000000-0000-4000-8000-000000000001', 'first_message', gen_random_uuid(), 'x',
            'b0000000-0000-4000-8000-0000000000c9')$$,
  '23503', NULL, 'an event "in A" cannot point at a contact of B');
SELECT throws_ok(
  $$INSERT INTO public.automation_runs (workspace_id, rule_id, event_id, trigger_type, conversation_id)
    SELECT 'a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000a9', e.id,
           'first_message', 'b0000000-0000-4000-8000-0000000000d9'
      FROM public.automation_events e WHERE e.subject_id = 'b0000000-0000-4000-8000-0000000000d9'$$,
  '23503', NULL, 'a run "in A" cannot use a rule, event or conversation of B');

-- mark: opt-in, cooldown per (rule, contact), daily cap per workspace
INSERT INTO public.automation_runs (id, workspace_id, rule_id, event_id, trigger_type, conversation_id, status, claimed_at)
  SELECT 'b0000000-0000-4000-8000-0000000000f7', 'b0000000-0000-4000-8000-000000000001',
         'b0000000-0000-4000-8000-0000000000a9', e.id, 'first_message',
         'b0000000-0000-4000-8000-0000000000d9', 'processing', now()
    FROM public.automation_events e WHERE e.subject_id = 'b0000000-0000-4000-8000-0000000000d9';
INSERT INTO public.automation_events (id, workspace_id, event_type, subject_id, occurrence, conversation_id, contact_id)
  VALUES (900001, 'b0000000-0000-4000-8000-000000000001', 'handoff_requested',
          'b0000000-0000-4000-8000-0000000000d9', '1',
          'b0000000-0000-4000-8000-0000000000d9', 'b0000000-0000-4000-8000-0000000000c9');
INSERT INTO public.automation_runs (id, workspace_id, rule_id, event_id, trigger_type, conversation_id, status, claimed_at)
  VALUES ('b0000000-0000-4000-8000-0000000000f8', 'b0000000-0000-4000-8000-000000000001',
          'b0000000-0000-4000-8000-0000000000a9', 900001, 'handoff_requested',
          'b0000000-0000-4000-8000-0000000000d9', 'processing', now());
SELECT is(public.mark_automation_run_dispatched('b0000000-0000-4000-8000-0000000000f7', 24, 300), 'ok',
  'the first send of a rule to a contact is allowed');
SELECT is(public.mark_automation_run_dispatched('b0000000-0000-4000-8000-0000000000f7', 24, 300), 'already_dispatched',
  'a run marked once is never marked again');
SELECT is(public.mark_automation_run_dispatched('b0000000-0000-4000-8000-0000000000f8', 24, 300), 'cooldown',
  'the same rule to the same contact within the cooldown is refused');
SELECT is(public.mark_automation_run_dispatched('b0000000-0000-4000-8000-0000000000f8', 0, 1), 'daily_cap',
  'past the workspace''s daily cap nothing more is sent');
SELECT ok(public.release_automation_run_dispatch('b0000000-0000-4000-8000-0000000000f7'),
  'a send that provably did not happen releases its mark');
UPDATE public.contacts SET opted_out_at = now() WHERE id = 'b0000000-0000-4000-8000-0000000000c9';
SELECT is(public.mark_automation_run_dispatched('b0000000-0000-4000-8000-0000000000f8', 0, 0), 'opted_out',
  'nothing is sent to a contact who opted out');

-- an explicit opt-out survives the inbound upsert that opts writers in
INSERT INTO public.contacts (workspace_id, phone, opt_in, opt_in_at)
  VALUES ('b0000000-0000-4000-8000-000000000001', '+15550009999', true, now())
  ON CONFLICT (workspace_id, phone) DO UPDATE SET opt_in = EXCLUDED.opt_in, opt_in_at = EXCLUDED.opt_in_at;
SELECT is((SELECT opt_in FROM public.contacts WHERE id = 'b0000000-0000-4000-8000-0000000000c9'), false,
  'writing again after STOP does not opt the contact back in');
UPDATE public.contacts SET opt_in = true, opted_out_at = NULL WHERE id = 'b0000000-0000-4000-8000-0000000000c9';
SELECT is((SELECT opt_in FROM public.contacts WHERE id = 'b0000000-0000-4000-8000-0000000000c9'), true,
  'ALTA (clearing the opt-out) opts them back in');

-- a rule switched off after the claim sends nothing
UPDATE public.automation_rules SET enabled = false WHERE id = 'b0000000-0000-4000-8000-0000000000a9';
SELECT is(public.mark_automation_run_dispatched('b0000000-0000-4000-8000-0000000000f8', 0, 0), 'rule_disabled',
  'the mark re-checks that the rule is still on');
UPDATE public.automation_rules SET enabled = true WHERE id = 'b0000000-0000-4000-8000-0000000000a9';

-- a reminder's cooldown is per appointment: two appointments of one contact both get theirs
INSERT INTO public.appointments (id, workspace_id, contact_id, conversation_id, scheduled_at, status) VALUES
  ('b0000000-0000-4000-8000-0000000000e8', 'b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000c9',
   'b0000000-0000-4000-8000-0000000000d9', now() + interval '20 hours', 'booked'),
  ('b0000000-0000-4000-8000-0000000000e9', 'b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000c9',
   'b0000000-0000-4000-8000-0000000000d9', now() + interval '22 hours', 'booked');
INSERT INTO public.automation_rules (id, workspace_id, name, trigger_type, trigger_config, action_type, action_config, enabled) VALUES
  ('b0000000-0000-4000-8000-0000000000a8', 'b0000000-0000-4000-8000-000000000001', 'Recordatorio',
   'appointment_upcoming', '{"hours_before": 24}', 'send_template', '{"template_name": "recordatorio"}', true);
INSERT INTO public.automation_events (id, workspace_id, event_type, subject_id, occurrence, conversation_id, contact_id, rule_id) VALUES
  (900010, 'b0000000-0000-4000-8000-000000000001', 'appointment_upcoming', 'b0000000-0000-4000-8000-0000000000e8', 'x:24h:1',
   'b0000000-0000-4000-8000-0000000000d9', 'b0000000-0000-4000-8000-0000000000c9', 'b0000000-0000-4000-8000-0000000000a8'),
  (900011, 'b0000000-0000-4000-8000-000000000001', 'appointment_upcoming', 'b0000000-0000-4000-8000-0000000000e9', 'x:24h:2',
   'b0000000-0000-4000-8000-0000000000d9', 'b0000000-0000-4000-8000-0000000000c9', 'b0000000-0000-4000-8000-0000000000a8'),
  (900012, 'b0000000-0000-4000-8000-000000000001', 'appointment_upcoming', 'b0000000-0000-4000-8000-0000000000e8', 'x:24h:3',
   'b0000000-0000-4000-8000-0000000000d9', 'b0000000-0000-4000-8000-0000000000c9', 'b0000000-0000-4000-8000-0000000000a8');
INSERT INTO public.automation_runs (id, workspace_id, rule_id, event_id, trigger_type, conversation_id, status, claimed_at) VALUES
  ('b0000000-0000-4000-8000-0000000000f1', 'b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000a8',
   900010, 'appointment_upcoming', 'b0000000-0000-4000-8000-0000000000d9', 'processing', now()),
  ('b0000000-0000-4000-8000-0000000000f2', 'b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000a8',
   900011, 'appointment_upcoming', 'b0000000-0000-4000-8000-0000000000d9', 'processing', now()),
  ('b0000000-0000-4000-8000-0000000000f3', 'b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000a8',
   900012, 'appointment_upcoming', 'b0000000-0000-4000-8000-0000000000d9', 'processing', now());
SELECT is(public.mark_automation_run_dispatched('b0000000-0000-4000-8000-0000000000f1', 24, 0), 'ok',
  'the first reminder for an appointment goes out');
SELECT is(public.mark_automation_run_dispatched('b0000000-0000-4000-8000-0000000000f2', 24, 0), 'ok',
  'the same contact''s other appointment gets its own reminder');
SELECT is(public.mark_automation_run_dispatched('b0000000-0000-4000-8000-0000000000f3', 24, 0), 'cooldown',
  'a second reminder for the same appointment within the cooldown is refused');

-- only a manager or admin opts a contact back in, and every manual change is recorded
INSERT INTO auth.users (id, email, instance_id, aud, role) VALUES
  ('b0000000-0000-4000-8000-0000000000e2', 'sec-b-agent@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
INSERT INTO public.users (id, full_name, email) VALUES
  ('b0000000-0000-4000-8000-0000000000e2', 'B agent', 'sec-b-agent@test.local');
INSERT INTO public.memberships (workspace_id, user_id, role, is_active) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000e2', 'agent', true);
UPDATE public.contacts SET opted_out_at = now() WHERE id = 'b0000000-0000-4000-8000-0000000000c9';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"b0000000-0000-4000-8000-0000000000e2","role":"authenticated"}', true);
SELECT throws_ok(
  $$UPDATE public.contacts SET opt_in = true, opted_out_at = NULL WHERE id = 'b0000000-0000-4000-8000-0000000000c9'$$,
  '42501', NULL, 'an agent cannot undo a contact''s opt-out');
SELECT set_config('request.jwt.claims',
  '{"sub":"b0000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
SELECT lives_ok(
  $$UPDATE public.contacts SET opt_in = true, opted_out_at = NULL WHERE id = 'b0000000-0000-4000-8000-0000000000c9'$$,
  'an admin can');
RESET ROLE;
SELECT results_eq(
  $$SELECT payload->>'user_id', (payload->>'opt_out_cleared')::boolean FROM public.events
     WHERE type = 'contact_opt_in_changed' AND payload->>'contact_id' = 'b0000000-0000-4000-8000-0000000000c9'$$,
  $$VALUES ('b0000000-0000-4000-8000-0000000000e1'::text, true)$$,
  'the override is recorded with who made it');

-- the claim discards what expired instead of sending it late (nothing else queued)
UPDATE public.automation_runs SET status = 'done', finished_at = now()
 WHERE status IN ('pending', 'processing');
UPDATE public.automation_events SET occurred_at = now() - interval '3 hours' WHERE id = 900001;
-- The rule has been on since yesterday (the trigger stamps enabled_since itself).
ALTER TABLE public.automation_rules DISABLE TRIGGER trg_automation_rules_enabled_since;
UPDATE public.automation_rules SET enabled_since = now() - interval '1 day'
 WHERE id = 'b0000000-0000-4000-8000-0000000000a9';
ALTER TABLE public.automation_rules ENABLE TRIGGER trg_automation_rules_enabled_since;
INSERT INTO public.automation_runs (id, workspace_id, rule_id, event_id, trigger_type, conversation_id, status)
  VALUES ('b0000000-0000-4000-8000-0000000000f9', 'b0000000-0000-4000-8000-000000000001',
          'b0000000-0000-4000-8000-0000000000a9', 900001, 'handoff_requested',
          'b0000000-0000-4000-8000-0000000000d9', 'pending')
  ON CONFLICT (rule_id, event_id) DO UPDATE SET status = 'pending', dispatched_at = NULL, not_before = now();
SELECT is_empty($$SELECT * FROM public.claim_next_automation_run()
                   WHERE workspace_id = 'b0000000-0000-4000-8000-000000000001'$$,
  'a handoff event older than its 2-hour TTL is never handed out');
SELECT results_eq(
  $$SELECT status, error FROM public.automation_runs
     WHERE rule_id = 'b0000000-0000-4000-8000-0000000000a9' AND event_id = 900001$$,
  $$VALUES ('skipped'::text, 'stale'::text)$$,
  'it is closed as skipped/stale, with a trace');

-- the claim gives up after the last attempt, keeping that attempt's cause
INSERT INTO public.automation_events (id, workspace_id, event_type, subject_id, occurrence, conversation_id)
  VALUES (900013, 'b0000000-0000-4000-8000-000000000001', 'inbound_message', gen_random_uuid(), '1',
          'b0000000-0000-4000-8000-0000000000d9');
INSERT INTO public.automation_runs (id, workspace_id, rule_id, event_id, trigger_type, conversation_id, status, attempts, error)
  VALUES ('b0000000-0000-4000-8000-0000000000f4', 'b0000000-0000-4000-8000-000000000001',
          'b0000000-0000-4000-8000-0000000000a9', 900013, 'keyword_match',
          'b0000000-0000-4000-8000-0000000000d9', 'pending', 3, 'db_read_failed');
SELECT is_empty($$SELECT * FROM public.claim_next_automation_run()$$,
  'a run out of attempts is not handed out');
SELECT is((SELECT error FROM public.automation_runs WHERE id = 'b0000000-0000-4000-8000-0000000000f4'),
  'max_attempts:db_read_failed', 'and it fails with the cause of its last retry');

-- what the tab shows per rule: server-only, one workspace at a time
SELECT ok(NOT has_function_privilege('authenticated', 'public.automation_rule_health(uuid)', 'EXECUTE'),
  'sessions cannot call automation_rule_health');
SELECT ok(NOT has_function_privilege('authenticated', 'public.guard_contact_opt_in_change()', 'EXECUTE'),
  'nor the opt-in guard');
SELECT ok((SELECT failures_24h FROM public.automation_rule_health('b0000000-0000-4000-8000-000000000001')
            WHERE rule_id = 'b0000000-0000-4000-8000-0000000000a9') >= 1,
  'a rule''s failures in the last 24 hours are counted');
SELECT is_empty($$SELECT 1 FROM public.automation_rule_health('a0000000-0000-4000-8000-000000000001')
                   WHERE rule_id = 'b0000000-0000-4000-8000-0000000000a9'$$,
  'another workspace''s health never lists this workspace''s rules');

-- ── password-reset audit: append-only, server-only ──────────────────────────
SELECT ok(NOT has_table_privilege('authenticated', 'public.member_password_resets', 'SELECT'),
  'sessions cannot read the password-reset audit');
SELECT ok(NOT has_table_privilege('service_role', 'public.member_password_resets', 'UPDATE'),
  'not even the service role may UPDATE the audit');
SELECT ok(NOT has_table_privilege('service_role', 'public.member_password_resets', 'DELETE'),
  'not even the service role may DELETE the audit');
INSERT INTO public.member_password_resets (actor_user_id, target_user_id, workspace_id, affected_workspace_ids, outcome)
  VALUES ('a0000000-0000-4000-8000-0000000000e1', 'b0000000-0000-4000-8000-0000000000e1',
          'b0000000-0000-4000-8000-000000000001', ARRAY['b0000000-0000-4000-8000-000000000001']::uuid[], 'done');
SELECT throws_ok($$UPDATE public.member_password_resets SET outcome = 'failed'$$, '42501', NULL,
  'an audit row cannot be changed, even by the owner');
SELECT throws_ok($$DELETE FROM public.member_password_resets$$, '42501', NULL,
  'an audit row cannot be deleted, even by the owner');
SELECT lives_ok($$DELETE FROM public.workspaces WHERE id = 'a0000000-0000-4000-8000-000000000001'$$,
  'a workspace can still be deleted: the audit has no foreign keys');
SELECT is((SELECT count(*)::int FROM public.member_password_resets), 1,
  'the audit outlives the workspaces it mentions');

SELECT * FROM finish();
ROLLBACK;
