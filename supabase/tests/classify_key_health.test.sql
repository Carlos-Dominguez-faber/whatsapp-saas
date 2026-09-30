-- Key health of the topic classifier (classify-topics.ts, the failure model):
-- a key's transient streak, its down time with a probe, and what resets it.
-- Run with `supabase test db` against a local stack.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(27);

INSERT INTO public.workspaces (id, name, slug) VALUES
  ('e6000000-0000-4000-8000-000000000001', 'KH A', 'kh-a'),
  ('e6000000-0000-4000-8000-000000000002', 'KH B', 'kh-b');

-- ── The gate maps the workspace to its key ───────────────────────────────────
SELECT is(public.classification_key_gate('e6000000-0000-4000-8000-000000000001', 'sha256:a', 'own', 180, '2027-01-01 10:00+00'),
  '{"state": "up", "failures": 0}'::jsonb, 'a key never seen is up');
SELECT is((SELECT key_id || '/' || key_scope FROM public.classification_workspace_state
            WHERE workspace_id = 'e6000000-0000-4000-8000-000000000001'),
  'sha256:a/own', 'and the workspace is mapped to it');

-- ── Transient failures in a row, on THIS key ─────────────────────────────────
SELECT is(public.record_classification_key_outcome('sha256:a', 'own', 'transient', 'provider_unavailable',
  3, 900, 21600, 900, '2027-01-01 10:00+00'), 'up', 'one transient: still up');
SELECT is(public.record_classification_key_outcome('sha256:a', 'own', 'transient', 'timeout',
  3, 900, 21600, 900, '2027-01-01 10:01+00'), 'up', 'two: still up');
SELECT public.record_classification_key_outcome('sha256:other', 'own', 'answered', NULL,
  3, 900, 21600, 900, '2027-01-01 10:01+00');
SELECT is((public.classification_key_gate('e6000000-0000-4000-8000-000000000001', 'sha256:a', 'own', 180, '2027-01-01 10:01+00')->>'failures')::int,
  2, 'an answer on ANOTHER key does not reset this one');
SELECT is(public.record_classification_key_outcome('sha256:a', 'own', 'transient', 'provider_unavailable',
  3, 900, 21600, 900, '2027-01-01 10:02+00'), 'down', 'the third in a row takes the key down');
SELECT is((SELECT down_until FROM public.classification_key_health WHERE key_id = 'sha256:a'),
  '2027-01-01 10:17+00'::timestamptz, 'for 15 minutes');
SELECT is(public.classification_key_gate('e6000000-0000-4000-8000-000000000001', 'sha256:a', 'own', 180, '2027-01-01 10:10+00'),
  '{"state": "down"}'::jsonb, 'no call on it before then');

-- ── One probe when the wait ends ─────────────────────────────────────────────
SELECT is(public.classification_key_gate('e6000000-0000-4000-8000-000000000001', 'sha256:a', 'own', 180, '2027-01-01 10:17+00'),
  '{"state": "probe"}'::jsonb, 'when it ends, the first caller probes');
SELECT is(public.classification_key_gate('e6000000-0000-4000-8000-000000000002', 'sha256:a', 'own', 180, '2027-01-01 10:17:30+00'),
  '{"state": "down"}'::jsonb, 'nobody else does meanwhile (another workspace on the same key included)');
SELECT is(public.record_classification_key_outcome('sha256:a', 'own', 'transient', 'timeout',
  3, 900, 21600, 900, '2027-01-01 10:18+00'), 'down', 'a probe that fails takes it down again at once');
SELECT is((SELECT down_until FROM public.classification_key_health WHERE key_id = 'sha256:a'),
  '2027-01-01 10:48+00'::timestamptz, 'for twice as long (30 minutes)');
SELECT is(public.classification_key_gate('e6000000-0000-4000-8000-000000000001', 'sha256:a', 'own', 180, '2027-01-01 10:40+00'),
  '{"state": "down"}'::jsonb, 'still down before the new time');
DO $$
BEGIN
  FOR i IN 1..8 LOOP
    PERFORM public.record_classification_key_outcome('sha256:a', 'own', 'transient', 'timeout',
      3, 900, 21600, 900, '2027-01-01 11:00+00'::timestamptz + make_interval(hours => i));
  END LOOP;
END $$;
SELECT is((SELECT down_until FROM public.classification_key_health WHERE key_id = 'sha256:a'),
  '2027-01-01 19:00+00'::timestamptz + interval '6 hours', 'the wait stops doubling at 6 hours');
SELECT is(public.record_classification_key_outcome('sha256:a', 'own', 'answered', NULL,
  3, 900, 21600, 900, '2027-01-02 02:00+00'), 'up', 'an answer brings it back');
SELECT is((SELECT row(transient_failures, down_count, down_since, down_until)::text
             FROM public.classification_key_health WHERE key_id = 'sha256:a'),
  '(0,0,,)', 'with nothing left of the episode');
SELECT is(public.classification_key_gate('e6000000-0000-4000-8000-000000000001', 'sha256:a', 'own', 180, '2027-01-02 02:01+00'),
  '{"state": "up", "failures": 0}'::jsonb, 'and calls go again');

-- ── A key refused outright is down from the first answer ─────────────────────
SELECT is(public.record_classification_key_outcome('sha256:b', 'platform', 'rejected', 'key_rejected',
  3, 900, 21600, 900, '2027-01-01 10:00+00'), 'down', 'a 401/402/404/429 takes it down at once');
SELECT is((SELECT down_until FROM public.classification_key_health WHERE key_id = 'sha256:b'),
  '2027-01-01 10:15+00'::timestamptz, 'for a flat 15 minutes (a refused request bills nothing)');
SELECT public.record_classification_key_outcome('sha256:b', 'platform', 'rejected', 'key_rejected',
  3, 900, 21600, 900, '2027-01-01 10:15+00');
SELECT is((SELECT down_since FROM public.classification_key_health WHERE key_id = 'sha256:b'),
  '2027-01-01 10:00+00'::timestamptz, 'refused again, it keeps the time it went down');

-- ── A backfill waits on a conversation in its transient wait ─────────────────
DO $bf$
DECLARE ws UUID := 'e6000000-0000-4000-8000-000000000002'; k UUID := gen_random_uuid();
  c UUID := 'e6000000-0000-4000-8000-0000000000c1';
BEGIN
  INSERT INTO public.contacts (id, workspace_id, phone) VALUES (k, ws, '+15559600001');
  INSERT INTO public.conversations (id, workspace_id, contact_id, last_message_at) VALUES (c, ws, k, now() - interval '2 days');
  INSERT INTO public.messages (workspace_id, conversation_id, direction, body, created_at)
  VALUES (ws, c, 'in', 'hola', now() - interval '2 days');
  PERFORM public.save_conversation_topics(ws, c, '[]'::jsonb, now() - interval '2 days');
  INSERT INTO public.insight_topics (id, workspace_id, name, description)
  VALUES ('e6000000-0000-4000-8000-0000000000f1', ws, 'Nuevo', 'x');
END
$bf$;
SELECT is((SELECT waits_until FROM public.next_backfill_batch('e6000000-0000-4000-8000-0000000000f1', 5)),
  NULL, 'a conversation that is not waiting can be read');
SELECT is(public.defer_classification('e6000000-0000-4000-8000-000000000002', 'e6000000-0000-4000-8000-0000000000c1', 'timeout', 3600),
  1, 'a transient failure returns the failures in a row');
SELECT ok((SELECT waits_until > now() + interval '59 minutes' FROM public.next_backfill_batch('e6000000-0000-4000-8000-0000000000f1', 5)),
  'the backfill sees it waiting (the cursor cannot step around it)');
SELECT public.save_conversation_topics('e6000000-0000-4000-8000-000000000002', 'e6000000-0000-4000-8000-0000000000c1',
  '[]'::jsonb, NULL, NULL, NULL, NULL, 'e6000000-0000-4000-8000-0000000000f1');
SELECT is((SELECT transient_failures FROM public.conversation_classification
            WHERE conversation_id = 'e6000000-0000-4000-8000-0000000000c1'), 0,
  'read by the backfill, its streak is over');

-- ── Only the server ──────────────────────────────────────────────────────────
SELECT ok(NOT has_function_privilege('authenticated', 'public.classification_key_gate(uuid, text, text, integer, timestamptz)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated',
            'public.record_classification_key_outcome(text, text, text, text, integer, integer, integer, integer, timestamptz)', 'EXECUTE'),
  'sessions cannot read or move a key''s health');
SELECT ok(NOT has_table_privilege('authenticated', 'public.classification_key_health', 'SELECT')
          AND NOT has_table_privilege('anon', 'public.classification_workspace_state', 'SELECT'),
  'nor see the tables');
SELECT throws_ok($$SELECT public.record_classification_key_outcome('sha256:a', 'own', 'bogus')$$,
  '22023', NULL, 'an unknown outcome is refused');

SELECT * FROM finish();
ROLLBACK;
