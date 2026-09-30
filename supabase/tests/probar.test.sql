-- /probar (#5) — run with `supabase test db` against a local stack.
--
-- The chat spends the workspace's OpenRouter key and may be handed to someone
-- outside the team, so its calls are reserved per person and per workspace,
-- and they count toward the daily budget.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(9);

SELECT ok(NOT has_function_privilege('anon', 'public.reserve_client_test_chat(uuid, uuid, integer, integer)', 'EXECUTE'),
  'anon cannot execute reserve_client_test_chat()');
SELECT ok(NOT has_function_privilege('authenticated', 'public.reserve_client_test_chat(uuid, uuid, integer, integer)', 'EXECUTE'),
  'authenticated cannot execute reserve_client_test_chat() (a session could reserve for anyone)');
SELECT ok(has_function_privilege('service_role', 'public.reserve_client_test_chat(uuid, uuid, integer, integer)', 'EXECUTE'),
  'service_role can execute reserve_client_test_chat()');

INSERT INTO public.workspaces (id, name, slug) VALUES
  ('f1000000-0000-4000-8000-000000000001', 'Probar', 'probar-test');

-- Person A, limits 60/workspace and 2/person: two calls, then no.
SELECT public.reserve_client_test_chat('f1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-0000000000a1', 60, 2);
SELECT public.reserve_client_test_chat('f1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-0000000000a1', 60, 2);
SELECT is((SELECT reason FROM public.reserve_client_test_chat(
    'f1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-0000000000a1', 60, 2)),
  'user_hour', 'a person over their hourly calls is refused');
SELECT ok((SELECT allowed FROM public.reserve_client_test_chat(
    'f1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-0000000000b2', 60, 2)),
  'another person in the same workspace still gets their calls');

-- The workspace cap counts everyone: 3 calls so far.
SELECT is((SELECT reason FROM public.reserve_client_test_chat(
    'f1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-0000000000c3', 3, 20)),
  'workspace_hour', 'the workspace''s hourly calls cap every /probar account together');

SELECT is((SELECT count(*)::int FROM public.events
            WHERE workspace_id = 'f1000000-0000-4000-8000-000000000001'
              AND type = 'client_test_chat'
              AND payload->>'user_id' IS NOT NULL
              AND payload->>'reserved' = 'true'), 3,
  'each allowed call leaves one reservation row with who made it');

UPDATE public.events SET payload = payload || '{"total_tokens": 1200}'
 WHERE workspace_id = 'f1000000-0000-4000-8000-000000000001' AND type = 'client_test_chat';
SELECT is(public.sum_daily_llm_tokens('f1000000-0000-4000-8000-000000000001',
    date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
  3600::bigint, '/probar''s tokens count toward the daily budget');
SELECT throws_ok(
  $$SELECT * FROM public.reserve_client_test_chat('f1000000-0000-4000-8000-000000000001', NULL, 60, 20)$$,
  '22023', NULL, 'a reservation without a person is refused');

SELECT * FROM finish();
ROLLBACK;
