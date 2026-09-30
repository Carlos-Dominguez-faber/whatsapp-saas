-- Key health of the topic classifier (classify-topics.ts, the failure model):
-- a key's transient streak, its down time with a probe, what resets it, and
-- each workspace's lane on a shared key. Run with `supabase test db`.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(39);

INSERT INTO public.workspaces (id, name, slug) VALUES
  ('e6000000-0000-4000-8000-000000000001', 'KH A', 'kh-a'),
  ('e6000000-0000-4000-8000-000000000002', 'KH B', 'kh-b'),
  ('e6000000-0000-4000-8000-000000000003', 'KH C', 'kh-c');

-- Shorthands: the run's defaults (breaker 3, 15 min doubling to 6 h, 15 min flat).
CREATE FUNCTION pg_temp.out(p_key TEXT, p_scope TEXT, p_ws UUID, p_outcome TEXT, p_at TIMESTAMPTZ, p_code TEXT DEFAULT 'provider_unavailable')
RETURNS JSONB LANGUAGE sql AS $$
  SELECT public.record_classification_key_outcome(p_key, p_scope, p_ws, p_outcome, p_code, 3, 900, 21600, 900, p_at);
$$;
CREATE FUNCTION pg_temp.gate(p_ws UUID, p_key TEXT, p_scope TEXT, p_at TIMESTAMPTZ) RETURNS JSONB LANGUAGE sql AS $$
  SELECT public.classification_key_gate(p_ws, p_key, p_scope, 180, p_at);
$$;
CREATE FUNCTION pg_temp.until(p_id TEXT) RETURNS TIMESTAMPTZ LANGUAGE sql AS $$
  SELECT down_until FROM public.classification_key_health WHERE key_id = p_id;
$$;

-- ── The gate maps the workspace to its key ───────────────────────────────────
SELECT is(pg_temp.gate('e6000000-0000-4000-8000-000000000001', 'sha256:a', 'own', '2027-01-01 10:00+00'),
  '{"state": "up", "workspace": "up"}'::jsonb, 'a key never seen is up, and so is the workspace on it');
SELECT is((SELECT key_id || '/' || key_scope FROM public.classification_workspace_state
            WHERE workspace_id = 'e6000000-0000-4000-8000-000000000001'),
  'sha256:a/own', 'and the workspace is mapped to it');

-- ── Transient failures in a row, on a key only ONE workspace uses ────────────
SELECT is(pg_temp.out('sha256:a', 'own', 'e6000000-0000-4000-8000-000000000001', 'transient', '2027-01-01 10:00+00'),
  '{"key": "up", "workspace": "up"}'::jsonb, 'one transient: still up');
SELECT is(pg_temp.out('sha256:a', 'own', 'e6000000-0000-4000-8000-000000000001', 'transient', '2027-01-01 10:01+00', 'timeout'),
  '{"key": "up", "workspace": "up"}'::jsonb, 'two: still up');
SELECT pg_temp.out('sha256:other', 'own', 'e6000000-0000-4000-8000-000000000002', 'answered', '2027-01-01 10:01+00');
SELECT is((SELECT transient_failures FROM public.classification_key_health WHERE key_id = 'sha256:a'),
  2, 'an answer on ANOTHER key does not reset this one');
SELECT is(pg_temp.out('sha256:a', 'own', 'e6000000-0000-4000-8000-000000000001', 'transient', '2027-01-01 10:02+00'),
  '{"key": "down", "workspace": "down"}'::jsonb, 'the third in a row takes the key down');
SELECT is(pg_temp.until('sha256:a'), '2027-01-01 10:17+00'::timestamptz, 'for 15 minutes');
SELECT is(pg_temp.gate('e6000000-0000-4000-8000-000000000001', 'sha256:a', 'own', '2027-01-01 10:10+00'),
  '{"state": "down"}'::jsonb, 'no call on it before then');

-- ── One probe when the wait ends ─────────────────────────────────────────────
SELECT is(pg_temp.gate('e6000000-0000-4000-8000-000000000001', 'sha256:a', 'own', '2027-01-01 10:17+00')->>'state',
  'probe', 'when it ends, the first caller probes');
SELECT is(pg_temp.gate('e6000000-0000-4000-8000-000000000002', 'sha256:a', 'own', '2027-01-01 10:17:30+00'),
  '{"state": "down"}'::jsonb, 'nobody else does meanwhile (another workspace on the same key included)');
SELECT is(pg_temp.out('sha256:a', 'own', 'e6000000-0000-4000-8000-000000000001', 'transient', '2027-01-01 10:18+00', 'timeout')->>'key',
  'down', 'a probe that fails takes it down again at once');
SELECT is(pg_temp.until('sha256:a'), '2027-01-01 10:48+00'::timestamptz, 'for twice as long (30 minutes)');
DO $$
BEGIN
  FOR i IN 1..8 LOOP
    PERFORM pg_temp.out('sha256:a', 'own', 'e6000000-0000-4000-8000-000000000001', 'transient',
      '2027-01-01 11:00+00'::timestamptz + make_interval(hours => i), 'timeout');
  END LOOP;
END $$;
SELECT is(pg_temp.until('sha256:a'), '2027-01-01 19:00+00'::timestamptz + interval '6 hours',
  'the wait stops doubling at 6 hours');

-- ── REVIEW r4 L1 (T2): a refusal never shortens a longer wait ────────────────
SELECT pg_temp.out('sha256:a', 'own', 'e6000000-0000-4000-8000-000000000001', 'rejected', '2027-01-01 19:01+00', 'key_rejected');
SELECT is(pg_temp.until('sha256:a'), '2027-01-01 19:00+00'::timestamptz + interval '6 hours',
  'a 429 while down for 6 hours leaves the 6 hours (it was cut to 16 minutes)');

SELECT is(pg_temp.out('sha256:a', 'own', 'e6000000-0000-4000-8000-000000000001', 'answered', '2027-01-02 02:00+00'),
  '{"key": "up", "workspace": "up"}'::jsonb, 'an answer brings it back');
SELECT is((SELECT row(transient_failures, down_count, down_since, down_until)::text
             FROM public.classification_key_health WHERE key_id = 'sha256:a'),
  '(0,0,,)', 'with nothing left of the episode');
SELECT is((SELECT down_since FROM public.classification_key_health
            WHERE key_id = 'lane:e6000000-0000-4000-8000-000000000001:sha256:a'),
  NULL, 'the workspace''s lane too');
SELECT is(pg_temp.gate('e6000000-0000-4000-8000-000000000001', 'sha256:a', 'own', '2027-01-02 02:01+00'),
  '{"state": "up", "workspace": "up"}'::jsonb, 'and calls go again');

-- ── REVIEW r4 L2: writing every answer is cheap ──────────────────────────────
CREATE TEMP TABLE before_answer AS SELECT xmin::text AS x FROM public.classification_key_health WHERE key_id = 'sha256:a';
SELECT pg_temp.out('sha256:a', 'own', 'e6000000-0000-4000-8000-000000000001', 'answered', '2027-01-02 02:02+00');
SELECT is((SELECT xmin::text FROM public.classification_key_health WHERE key_id = 'sha256:a'), (SELECT x FROM before_answer),
  'an answer on a healthy key writes nothing');
SELECT is((SELECT count(*)::int FROM public.classification_key_health WHERE key_id LIKE '%never-failed%'), 0,
  'nor creates a row for a key that never failed');
SELECT pg_temp.out('sha256:never-failed', 'own', 'e6000000-0000-4000-8000-000000000003', 'answered', '2027-01-02 02:02+00');
SELECT is((SELECT count(*)::int FROM public.classification_key_health WHERE key_id LIKE '%never-failed%'), 0,
  'even after its answers');

-- ── A key refused outright is down from the first answer ─────────────────────
SELECT is(pg_temp.out('sha256:b', 'platform', 'e6000000-0000-4000-8000-000000000001', 'rejected', '2027-01-01 10:00+00', 'key_rejected')->>'key',
  'down', 'a 401/402/404/429 takes it down at once');
SELECT is(pg_temp.until('sha256:b'), '2027-01-01 10:15+00'::timestamptz, 'for a flat 15 minutes (a refused request bills nothing)');
SELECT pg_temp.out('sha256:b', 'platform', 'e6000000-0000-4000-8000-000000000001', 'rejected', '2027-01-01 10:15+00', 'key_rejected');
SELECT is((SELECT down_since FROM public.classification_key_health WHERE key_id = 'sha256:b'),
  '2027-01-01 10:00+00'::timestamptz, 'refused again, it keeps the time it went down');

-- ── REVIEW r4 L4: one tenant can't take a shared key down ────────────────────
-- The platform key 'sha256:p'; A's calls keep timing out, B's and C's answer.
SELECT pg_temp.gate(w, 'sha256:p', 'platform', '2027-01-03 10:00+00') FROM unnest(ARRAY[
  'e6000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000002',
  'e6000000-0000-4000-8000-000000000003']::uuid[]) w;
DO $$
BEGIN
  FOR i IN 1..5 LOOP
    PERFORM pg_temp.out('sha256:p', 'platform', 'e6000000-0000-4000-8000-000000000001', 'transient',
      '2027-01-03 10:00+00'::timestamptz + make_interval(mins => i), 'timeout');
  END LOOP;
END $$;
SELECT is((SELECT down_since FROM public.classification_key_health WHERE key_id = 'sha256:p'), NULL,
  'five timeouts in a row from ONE workspace leave the platform key up');
SELECT isnt((SELECT down_since FROM public.classification_key_health
              WHERE key_id = 'lane:e6000000-0000-4000-8000-000000000001:sha256:p'), NULL,
  'its own lane is what goes down (at the third)');
SELECT is(pg_temp.gate('e6000000-0000-4000-8000-000000000002', 'sha256:p', 'platform', '2027-01-03 10:06+00'),
  '{"state": "up", "workspace": "up"}'::jsonb, 'the others on the key call as usual');
SELECT is(pg_temp.gate('e6000000-0000-4000-8000-000000000001', 'sha256:p', 'platform', '2027-01-03 10:06+00'),
  '{"state": "up", "workspace": "down"}'::jsonb, 'that workspace waits');
SELECT is(public.get_insights('e6000000-0000-4000-8000-000000000001', now() - interval '1 day', now(), '{}', 'UTC')->>'blocked',
  'workspace', 'and its dashboard says its own calls are failing');
-- An outage: B and C fail too. The streak now comes from two workspaces.
SELECT pg_temp.out('sha256:p', 'platform', 'e6000000-0000-4000-8000-000000000002', 'answered', '2027-01-03 10:07+00');
SELECT pg_temp.out('sha256:p', 'platform', 'e6000000-0000-4000-8000-000000000002', 'transient', '2027-01-03 10:10+00');
SELECT pg_temp.out('sha256:p', 'platform', 'e6000000-0000-4000-8000-000000000003', 'transient', '2027-01-03 10:10:30+00');
SELECT is(pg_temp.out('sha256:p', 'platform', 'e6000000-0000-4000-8000-000000000002', 'transient', '2027-01-03 10:11+00')->>'key',
  'down', 'three in a row from two workspaces take the shared key down');
SELECT is(public.get_insights('e6000000-0000-4000-8000-000000000003', now() - interval '1 day', now(), '{}', 'UTC')->>'blocked',
  'platform_key', 'which every workspace on it sees');
-- An own key pasted into two workspaces is shared too.
SELECT pg_temp.gate(w, 'sha256:twice', 'own', '2027-01-04 10:00+00') FROM unnest(ARRAY[
  'e6000000-0000-4000-8000-000000000002', 'e6000000-0000-4000-8000-000000000003']::uuid[]) w;
SELECT pg_temp.out('sha256:twice', 'own', 'e6000000-0000-4000-8000-000000000002', 'transient', '2027-01-04 10:00+00'::timestamptz + i * interval '1 minute')
  FROM generate_series(1, 4) i;
SELECT is((SELECT down_since FROM public.classification_key_health WHERE key_id = 'sha256:twice'), NULL,
  'an own key two workspaces use needs both failing, too');

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
            'public.record_classification_key_outcome(text, text, uuid, text, text, integer, integer, integer, integer, timestamptz)', 'EXECUTE'),
  'sessions cannot read or move a key''s health');
SELECT ok(NOT has_table_privilege('authenticated', 'public.classification_key_health', 'SELECT')
          AND NOT has_table_privilege('anon', 'public.classification_workspace_state', 'SELECT'),
  'nor see the tables');
SELECT throws_ok($$SELECT public.record_classification_key_outcome('sha256:a', 'own', 'e6000000-0000-4000-8000-000000000001', 'bogus')$$,
  '22023', NULL, 'an unknown outcome is refused');

SELECT * FROM finish();
ROLLBACK;
