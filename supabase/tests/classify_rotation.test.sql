-- Turns of the topic classifier (review round 3): workspaces take turns by
-- the one served longest ago, in the nightly phase and in the backfill.
-- Run with `supabase test db` against a local stack.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(10);

-- W workspaces with 30 customers each who wrote yesterday; `sel` selects of 5
-- a second apart, each claimed row read at once. Reads per workspace.
CREATE FUNCTION pg_temp.turns(p_workspaces INT, p_selects INT, p_tag TEXT)
RETURNS TABLE (reads BIGINT)
LANGUAGE plpgsql AS $$
DECLARE ws UUID; c UUID; ct UUID; k INT; i INT; s INT; r RECORD; now0 TIMESTAMPTZ := '2027-01-15 12:00Z';
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS rot_ws (tag TEXT, ws UUID);
  CREATE TEMP TABLE IF NOT EXISTS rot_reads (tag TEXT, ws UUID);
  FOR k IN 1..p_workspaces LOOP
    ws := gen_random_uuid();
    INSERT INTO rot_ws VALUES (p_tag, ws);
    INSERT INTO public.workspaces (id, name, slug) VALUES (ws, 'rot ' || k, 'rot-' || ws);
    INSERT INTO public.insight_topics (workspace_id, name, description, created_at, covered_from, backfill_status)
      VALUES (ws, 'Precio', 'x', now0 - interval '60 days', now0 - interval '60 days', 'done');
    FOR i IN 1..30 LOOP
      ct := gen_random_uuid(); c := gen_random_uuid();
      INSERT INTO public.contacts (id, workspace_id, phone) VALUES (ct, ws, '+1778' || lpad(k::text, 2, '0') || lpad(i::text, 5, '0') || p_tag);
      INSERT INTO public.conversations (id, workspace_id, contact_id, last_message_at)
        VALUES (c, ws, ct, now0 - interval '20 hours' + i * interval '10 minutes');
      INSERT INTO public.messages (workspace_id, conversation_id, direction, body, created_at)
        VALUES (ws, c, 'in', 'x', now0 - interval '20 hours' + i * interval '10 minutes');
    END LOOP;
  END LOOP;
  FOR s IN 1..p_selects LOOP
    FOR r IN SELECT * FROM public.select_conversations_to_classify(5, '{}', 180, now0 + s * interval '1 second')
              WHERE workspace_id IN (SELECT rw.ws FROM rot_ws rw WHERE rw.tag = p_tag) LOOP
      INSERT INTO rot_reads VALUES (p_tag, r.workspace_id);
      -- The call: its reservation is the workspace's turn.
      PERFORM public.reserve_classification_tokens(r.workspace_id, r.conversation_id, 1, 300000,
        now0 + s * interval '1 second');
      UPDATE public.conversation_classification SET classified_until = r.last_inbound_at, claimed_until = NULL
       WHERE conversation_id = r.conversation_id;
    END LOOP;
  END LOOP;
  RETURN QUERY SELECT count(rr.ws) FROM rot_ws w LEFT JOIN rot_reads rr ON rr.ws = w.ws AND rr.tag = p_tag
                WHERE w.tag = p_tag GROUP BY w.ws;
END $$;

CREATE TEMP TABLE r10 AS SELECT * FROM pg_temp.turns(10, 36, 'a');
SELECT is((SELECT min(reads) || '/' || max(reads) FROM r10), '18/18',
  '10 workspaces, 36 selects of 5: each gets its fair 18 (it was 5 to 30)');
-- The other workspaces' rows (the first run's) are read by now.
UPDATE public.conversation_classification SET classified_until = now() WHERE classified_until IS NULL;
CREATE TEMP TABLE r20 AS SELECT * FROM pg_temp.turns(20, 36, 'b');
SELECT is((SELECT min(reads) || '/' || max(reads) FROM r20), '9/9',
  '20 workspaces, 36 selects of 5: each gets its fair 9 (it was 0 to 26)');
SELECT ok((SELECT count(*) FROM public.classification_workspace_state s JOIN rot_ws w ON w.ws = s.workspace_id
            WHERE s.last_served_at IS NOT NULL) = 30,
  'a call for a workspace (its reservation) stamps when it was served');

-- ── A row claimed but never called is not a turn ─────────────────────────────
UPDATE public.conversation_classification SET classified_until = now() WHERE classified_until IS NULL;
DO $nc$
DECLARE ws UUID; k UUID; c UUID; i INT; j INT; now0 TIMESTAMPTZ := '2027-01-15 12:00Z';
BEGIN
  FOR i IN 1..3 LOOP
    ws := ('e7100000-0000-4000-8000-00000000000' || i)::uuid;
    INSERT INTO public.workspaces (id, name, slug) VALUES (ws, 'NC ' || i, 'nc-' || i);
    INSERT INTO public.insight_topics (workspace_id, name, description, created_at, covered_from, backfill_status)
      VALUES (ws, 'Precio', 'x', now0 - interval '60 days', now0 - interval '60 days', 'done');
    FOR j IN 1..2 LOOP
      k := gen_random_uuid(); c := gen_random_uuid();
      INSERT INTO public.contacts (id, workspace_id, phone) VALUES (k, ws, '+1557' || i || j);
      INSERT INTO public.conversations (id, workspace_id, contact_id, last_message_at) VALUES (c, ws, k, now0 - interval '5 hours');
      INSERT INTO public.messages (workspace_id, conversation_id, direction, body, created_at) VALUES (ws, c, 'in', 'x', now0 - interval '5 hours');
    END LOOP;
  END LOOP;
END
$nc$;
CREATE TEMP TABLE nc_first AS
  SELECT * FROM public.select_conversations_to_classify(3, ARRAY(SELECT ws FROM rot_ws), 180, '2027-01-15 12:01Z');
-- Only the first one is called; the other two run out of time (their lease lapses).
SELECT public.reserve_classification_tokens(n.workspace_id, n.conversation_id, 1, 300000, '2027-01-15 12:01Z')
  FROM (SELECT * FROM nc_first LIMIT 1) n;
UPDATE public.conversation_classification SET claimed_until = NULL
 WHERE conversation_id IN (SELECT conversation_id FROM nc_first OFFSET 1);
UPDATE public.conversation_classification SET classified_until = now()
 WHERE conversation_id IN (SELECT conversation_id FROM nc_first LIMIT 1);
SELECT is((SELECT count(*)::int FROM public.select_conversations_to_classify(2, ARRAY(SELECT ws FROM rot_ws), 180, '2027-01-15 12:02Z') x
            WHERE x.workspace_id = (SELECT workspace_id FROM nc_first LIMIT 1)), 0,
  'the two claimed but never called go before the one that was');

-- ── The backfill takes turns the same way ────────────────────────────────────
-- Its order, for this test's two workspaces (an install may have others pending).
CREATE FUNCTION pg_temp.bf_order(p_skip UUID[]) RETURNS TEXT[] LANGUAGE sql AS $$
  SELECT array_agg(x.name ORDER BY x.ord)
    FROM public.pending_backfill_topics(200, p_skip) WITH ORDINALITY AS x(id, workspace_id, name, description, ord)
   WHERE x.workspace_id IN ('e7000000-0000-4000-8000-00000000000a', 'e7000000-0000-4000-8000-00000000000b');
$$;
DO $bf$
DECLARE a UUID := 'e7000000-0000-4000-8000-00000000000a'; b UUID := 'e7000000-0000-4000-8000-00000000000b';
BEGIN
  INSERT INTO public.workspaces (id, name, slug) VALUES (a, 'BF A', 'bf-a'), (b, 'BF B', 'bf-b');
  INSERT INTO public.insight_topics (id, workspace_id, name, description, created_at) VALUES
    ('e7000000-0000-4000-8000-0000000000a1', a, 'A1', 'x', now() - interval '3 hours'),
    ('e7000000-0000-4000-8000-0000000000a2', a, 'A2', 'x', now() - interval '2 hours'),
    ('e7000000-0000-4000-8000-0000000000b1', b, 'B1', 'x', now() - interval '1 hour');
END
$bf$;
SELECT is(pg_temp.bf_order(ARRAY(SELECT ws FROM rot_ws)),
  ARRAY['A1', 'B1', 'A2'], 'each workspace''s oldest topic before anyone''s second');
DO $st$
DECLARE k UUID := gen_random_uuid(); c UUID := gen_random_uuid();
BEGIN
  INSERT INTO public.contacts (id, workspace_id, phone) VALUES (k, 'e7000000-0000-4000-8000-00000000000a', '+15559700001');
  INSERT INTO public.conversations (id, workspace_id, contact_id) VALUES (c, 'e7000000-0000-4000-8000-00000000000a', k);
  -- A nightly call is not a backfill turn …
  PERFORM public.reserve_classification_tokens('e7000000-0000-4000-8000-00000000000a', c, 1, 300000);
END
$st$;
SELECT is(pg_temp.bf_order(ARRAY(SELECT ws FROM rot_ws)),
  ARRAY['A1', 'B1', 'A2'], 'the nightly phase''s turns don''t count in the backfill''s');
DO $st2$
BEGIN
  -- … a backfill call is.
  PERFORM public.reserve_classification_tokens('e7000000-0000-4000-8000-00000000000a',
    (SELECT id FROM public.conversations WHERE workspace_id = 'e7000000-0000-4000-8000-00000000000a' LIMIT 1),
    1, 300000, now(), 'backfill');
END
$st2$;
SELECT is(pg_temp.bf_order(ARRAY(SELECT ws FROM rot_ws)),
  ARRAY['B1', 'A1', 'A2'], 'a backfill call sends the workspace to the back of the backfill''s turns');

-- REVIEW r4 M2 (T1): X, Y and W with a topic each; W also has nightly work
-- served every run after the backfill's call. In 24 runs each gets its turns.
DO $t1$
DECLARE
  x UUID := 'e7200000-0000-4000-8000-00000000000a'; y UUID := 'e7200000-0000-4000-8000-00000000000b';
  w UUID := 'e7200000-0000-4000-8000-00000000000c'; wsid UUID; k UUID; c UUID; conv UUID; first_ws UUID;
  t0 TIMESTAMPTZ := now() - interval '2 hours'; r INT;
BEGIN
  CREATE TEMP TABLE t1_turns (ws UUID);
  INSERT INTO public.workspaces (id, name, slug) VALUES (x, 'X', 't1-x'), (y, 'Y', 't1-y'), (w, 'W', 't1-w');
  FOREACH wsid IN ARRAY ARRAY[x, y, w] LOOP
    k := gen_random_uuid(); c := gen_random_uuid();
    INSERT INTO public.contacts (id, workspace_id, phone) VALUES (k, wsid, '+1555' || substr(wsid::text, 36, 1) || '7440001');
    INSERT INTO public.conversations (id, workspace_id, contact_id) VALUES (c, wsid, k);
    INSERT INTO public.insight_topics (workspace_id, name, description, created_at)
      VALUES (wsid, 'T-' || substr(wsid::text, 36, 1), 'x', now() - interval '3 hours');
  END LOOP;
  INSERT INTO public.classification_workspace_state (workspace_id, last_served_at) VALUES
    (x, t0 - interval '10 minutes'), (y, t0 - interval '9 minutes'), (w, t0 - interval '1 minute')
  ON CONFLICT (workspace_id) DO UPDATE SET last_served_at = EXCLUDED.last_served_at;
  FOR r IN 0..23 LOOP
    SELECT p.workspace_id INTO first_ws
      FROM public.pending_backfill_topics(200, '{}') WITH ORDINALITY AS p(id, workspace_id, name, description, ord)
     WHERE p.workspace_id IN (x, y, w) ORDER BY p.ord LIMIT 1;
    INSERT INTO t1_turns VALUES (first_ws);
    SELECT id INTO conv FROM public.conversations WHERE workspace_id = first_ws LIMIT 1;
    PERFORM public.reserve_classification_tokens(first_ws, conv, 1, 300000, t0 + r * interval '5 minutes' + interval '1 second', 'backfill');
    SELECT id INTO conv FROM public.conversations WHERE workspace_id = w LIMIT 1;
    PERFORM public.reserve_classification_tokens(w, conv, 1, 300000, t0 + r * interval '5 minutes' + interval '30 seconds');
  END LOOP;
END
$t1$;
SELECT is((SELECT string_agg(n::text, '/' ORDER BY ws) FROM (SELECT ws, count(*) AS n FROM t1_turns GROUP BY ws) z),
  '8/8/8', 'a workspace with nightly work every run gets its backfill turns too (it was 12/12/0)');
SELECT is(pg_temp.bf_order(ARRAY(SELECT ws FROM rot_ws) || 'e7000000-0000-4000-8000-00000000000b'::uuid),
  ARRAY['A1', 'A2'], 'a workspace skipped this run is left out');
SELECT ok(NOT has_function_privilege('authenticated', 'public.pending_backfill_topics(integer, uuid[], timestamptz)', 'EXECUTE'),
  'server only');

SELECT * FROM finish();
ROLLBACK;
