-- Automation history retention — run with `supabase test db` against a local stack.
--
-- purge_automation_history() drops finished runs and orphaned events past the
-- retention, and nothing that could still act or be counted.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(10);

SELECT ok(NOT has_function_privilege('authenticated', 'public.purge_automation_history(interval, integer)', 'EXECUTE'),
  'sessions cannot execute purge_automation_history()');
SELECT is((SELECT count(*)::int FROM cron.job
            WHERE jobname = 'automation-history-purge' AND schedule = '17 * * * *' AND active),
  1, 'the purge is scheduled hourly, once');

INSERT INTO public.workspaces (id, name, slug) VALUES
  ('f2000000-0000-4000-8000-000000000001', 'History', 'history-test');
INSERT INTO public.automation_rules (id, workspace_id, name, enabled, trigger_type, action_type, action_config) VALUES
  ('f2000000-0000-4000-8000-0000000000b1', 'f2000000-0000-4000-8000-000000000001', 'r', false, 'keyword_match', 'add_tag', '{"tag": "x"}');

-- Events: e1 old with a finished run, e2 old with a pending run, e3 old with
-- no run, e4 recent with a finished run, e5 5 days old with no run.
INSERT INTO public.automation_events (id, workspace_id, event_type, subject_id, occurrence, occurred_at, expanded_at) VALUES
  (910001, 'f2000000-0000-4000-8000-000000000001', 'inbound_message', gen_random_uuid(), '1', now() - interval '40 days', now() - interval '40 days'),
  (910002, 'f2000000-0000-4000-8000-000000000001', 'inbound_message', gen_random_uuid(), '1', now() - interval '40 days', now() - interval '40 days'),
  (910003, 'f2000000-0000-4000-8000-000000000001', 'inbound_message', gen_random_uuid(), '1', now() - interval '40 days', NULL),
  (910004, 'f2000000-0000-4000-8000-000000000001', 'inbound_message', gen_random_uuid(), '1', now() - interval '2 days', now() - interval '2 days'),
  (910005, 'f2000000-0000-4000-8000-000000000001', 'inbound_message', gen_random_uuid(), '1', now() - interval '5 days', now() - interval '5 days');
INSERT INTO public.automation_runs (id, workspace_id, rule_id, event_id, trigger_type, status, created_at, finished_at) VALUES
  ('f2000000-0000-4000-8000-0000000000c1', 'f2000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-0000000000b1', 910001, 'keyword_match', 'done', now() - interval '40 days', now() - interval '40 days'),
  ('f2000000-0000-4000-8000-0000000000c2', 'f2000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-0000000000b1', 910002, 'keyword_match', 'pending', now() - interval '40 days', NULL),
  ('f2000000-0000-4000-8000-0000000000c4', 'f2000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-0000000000b1', 910004, 'keyword_match', 'failed', now() - interval '2 days', now() - interval '2 days');

-- A caller asking for 1 day still gets the 8-day floor: nothing under it goes.
SELECT public.purge_automation_history(INTERVAL '1 day');
SELECT ok(EXISTS (SELECT 1 FROM public.automation_events WHERE id = 910005),
  'the retention never drops below 8 days (a reminder event must outlive its appointment)');

SELECT ok(NOT EXISTS (SELECT 1 FROM public.automation_runs WHERE id = 'f2000000-0000-4000-8000-0000000000c1'),
  'an old finished run is deleted');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.automation_events WHERE id = 910001),
  'and so is its event, once no run points at it');
SELECT ok(EXISTS (SELECT 1 FROM public.automation_runs WHERE id = 'f2000000-0000-4000-8000-0000000000c2'),
  'a pending run is never deleted, however old');
SELECT ok(EXISTS (SELECT 1 FROM public.automation_events WHERE id = 910002),
  'nor the event it still needs');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.automation_events WHERE id = 910003),
  'an old event no rule took is deleted');
SELECT ok(EXISTS (SELECT 1 FROM public.automation_runs WHERE id = 'f2000000-0000-4000-8000-0000000000c4')
          AND EXISTS (SELECT 1 FROM public.automation_events WHERE id = 910004),
  'recent history stays (the rules'' health and the caps read it)');
SELECT results_eq(
  $$SELECT runs_deleted, events_deleted FROM public.purge_automation_history()$$,
  $$VALUES (0, 0)$$,
  'running it again deletes nothing more');

SELECT * FROM finish();
ROLLBACK;
