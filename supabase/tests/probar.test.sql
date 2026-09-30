-- /probar (#5) — run with `supabase test db` against a local stack.
--
-- The chat spends the workspace's OpenRouter key and may be handed to someone
-- outside the team, so each call reserves its token ceiling per person and
-- per workspace, under /probar's own daily cap and below the workspace's
-- degrade threshold, and its tokens count toward the daily budget.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(13);

SELECT ok(NOT has_function_privilege('anon', 'public.reserve_client_test_chat(uuid, uuid, integer, integer, bigint, bigint, bigint)', 'EXECUTE'),
  'anon cannot execute reserve_client_test_chat()');
SELECT ok(NOT has_function_privilege('authenticated', 'public.reserve_client_test_chat(uuid, uuid, integer, integer, bigint, bigint, bigint)', 'EXECUTE'),
  'authenticated cannot execute reserve_client_test_chat() (a session could reserve for anyone)');
SELECT ok(has_function_privilege('service_role', 'public.reserve_client_test_chat(uuid, uuid, integer, integer, bigint, bigint, bigint)', 'EXECUTE'),
  'service_role can execute reserve_client_test_chat()');

INSERT INTO public.workspaces (id, name, slug) VALUES
  ('f1000000-0000-4000-8000-000000000001', 'Probar', 'probar-test'),
  ('f1000000-0000-4000-8000-000000000002', 'Probar 2', 'probar-test-2');

-- Person A, limits 60/workspace and 2/person: two calls, then no.
SELECT public.reserve_client_test_chat('f1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-0000000000a1', 60, 2, 1000, 100000, 800000);
SELECT public.reserve_client_test_chat('f1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-0000000000a1', 60, 2, 1000, 100000, 800000);
SELECT is((SELECT reason FROM public.reserve_client_test_chat(
    'f1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-0000000000a1', 60, 2, 1000, 100000, 800000)),
  'user_hour', 'a person over their hourly calls is refused');
SELECT ok((SELECT allowed FROM public.reserve_client_test_chat(
    'f1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-0000000000b2', 60, 2, 1000, 100000, 800000)),
  'another person in the same workspace still gets their calls');
SELECT is((SELECT reason FROM public.reserve_client_test_chat(
    'f1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-0000000000c3', 3, 20, 1000, 100000, 800000)),
  'workspace_hour', 'the workspace''s hourly calls cap every /probar account together');
SELECT is((SELECT count(*)::int FROM public.events
            WHERE workspace_id = 'f1000000-0000-4000-8000-000000000001'
              AND type = 'client_test_chat'
              AND payload->>'user_id' IS NOT NULL
              AND (payload->>'total_tokens')::int = 1000
              AND payload->>'reserved' = 'true'), 3,
  'each allowed call leaves a reservation holding its ceiling, with who made it');

-- Daily cap on tokens, counting what is still in flight (workspace 2).
SELECT public.reserve_client_test_chat('f1000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-0000000000d1', 60, 20, 40000, 100000, 800000);
SELECT public.reserve_client_test_chat('f1000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-0000000000d2', 60, 20, 40000, 100000, 800000);
SELECT is((SELECT reason FROM public.reserve_client_test_chat(
    'f1000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-0000000000d3', 60, 20, 40000, 100000, 800000)),
  'daily_cap', 'two calls in flight (80k) leave no room for a third 40k one under the 100k cap');
-- The first two settle at their real count: room again.
UPDATE public.events SET payload = payload || '{"total_tokens": 5000, "reserved": false}'
 WHERE workspace_id = 'f1000000-0000-4000-8000-000000000002' AND type = 'client_test_chat';
SELECT ok((SELECT allowed FROM public.reserve_client_test_chat(
    'f1000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-0000000000d3', 60, 20, 40000, 100000, 800000)),
  'once settled, the real counts free the rest of the day');

-- The workspace close to its degrade threshold: /probar can't be the one to cross it.
INSERT INTO public.events (type, level, workspace_id, payload)
VALUES ('llm_usage', 'info', 'f1000000-0000-4000-8000-000000000002', '{"total_tokens": 760000}');
SELECT is((SELECT reason FROM public.reserve_client_test_chat(
    'f1000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-0000000000d4', 60, 20, 5000, 100000, 800000)),
  'budget', 'a call whose ceiling would take the workspace to the degrade threshold is refused');

SELECT is(public.sum_daily_llm_tokens('f1000000-0000-4000-8000-000000000001',
    date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
  3000::bigint, '/probar''s tokens (in flight: their ceiling) count toward the daily budget');
SELECT throws_ok(
  $$SELECT * FROM public.reserve_client_test_chat('f1000000-0000-4000-8000-000000000001', NULL, 60, 20, 1000, 100000, 800000)$$,
  '22023', NULL, 'a reservation without a person is refused');
SELECT throws_ok(
  $$SELECT * FROM public.reserve_client_test_chat('f1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-0000000000a9', 60, 20, 0, 100000, 800000)$$,
  '22023', NULL, 'a reservation without a ceiling is refused');

SELECT * FROM finish();
ROLLBACK;
