-- Topic insights (#13) — run with `supabase test db` against a local stack.
--
-- Pins the rules the nightly classifier and the /analisis dashboard were
-- ported with: service-role-only functions, eligibility on the customer's
-- last message, evidence only from the customer, a classification budget of
-- its own, and each topic measured only over the period it was analysed.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(56);

-- ── Privileges ───────────────────────────────────────────────────────────────
SELECT ok(NOT has_function_privilege('anon',
  'public.select_conversations_to_classify(integer, uuid[], integer, timestamptz)', 'EXECUTE'),
  'anon cannot execute select_conversations_to_classify()');
SELECT ok(NOT has_function_privilege('authenticated',
  'public.reserve_classification_tokens(uuid, uuid, integer, bigint, timestamptz)', 'EXECUTE'),
  'authenticated cannot execute reserve_classification_tokens()');
SELECT ok(NOT has_function_privilege('authenticated',
  'public.get_insights(uuid, timestamptz, timestamptz, text[], text, timestamptz)', 'EXECUTE'),
  'authenticated cannot execute get_insights() (it reads without RLS)');
SELECT ok(has_function_privilege('service_role',
  'public.get_insights(uuid, timestamptz, timestamptz, text[], text, timestamptz)', 'EXECUTE'),
  'service_role can execute get_insights()');
SELECT ok(NOT has_table_privilege('authenticated', 'public.conversation_classification', 'SELECT'),
  'sessions cannot read conversation_classification');
SELECT ok(NOT has_table_privilege('authenticated', 'public.insight_topics', 'INSERT'),
  'sessions cannot write insight_topics (the server does, after its own checks)');

-- ── Fixtures ─────────────────────────────────────────────────────────────────
INSERT INTO public.workspaces (id, name, slug) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'Insights', 'insights-test');
INSERT INTO public.contacts (id, workspace_id, phone) VALUES
  ('e0000000-0000-4000-8000-0000000000c1', 'e0000000-0000-4000-8000-000000000001', '+15550100001'),
  ('e0000000-0000-4000-8000-0000000000c2', 'e0000000-0000-4000-8000-000000000001', '+15550100002'),
  ('e0000000-0000-4000-8000-0000000000c3', 'e0000000-0000-4000-8000-000000000001', '+15550100003'),
  ('e0000000-0000-4000-8000-0000000000c4', 'e0000000-0000-4000-8000-000000000001', '+15550100004'),
  ('e0000000-0000-4000-8000-0000000000c5', 'e0000000-0000-4000-8000-000000000001', '+15550100005');
INSERT INTO public.conversations (id, workspace_id, contact_id, last_message_at) VALUES
  ('e0000000-0000-4000-8000-0000000000a1', 'e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000c1', now() - interval '2 hours'),
  ('e0000000-0000-4000-8000-0000000000a2', 'e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000c2', now() - interval '30 minutes'),
  ('e0000000-0000-4000-8000-0000000000a3', 'e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000c3', now() - interval '1 day'),
  ('e0000000-0000-4000-8000-0000000000a4', 'e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000c4', now() - interval '5 days'),
  ('e0000000-0000-4000-8000-0000000000a5', 'e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000c5', now() - interval '1 day');
-- a1: the customer wrote 3 h ago, the bot answered 2 h ago.
-- a2: the customer wrote 30 min ago (not settled yet).
-- a3: the customer last wrote 10 days ago; a reminder went out yesterday.
INSERT INTO public.messages (id, workspace_id, conversation_id, direction, body, created_at) VALUES
  ('e0000000-0000-4000-8000-0000000000e1', 'e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a1', 'in',  'está caro', now() - interval '3 hours'),
  ('e0000000-0000-4000-8000-0000000000e2', 'e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a1', 'out', 'tenemos promociones', now() - interval '2 hours'),
  ('e0000000-0000-4000-8000-0000000000e3', 'e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a2', 'in',  'hola', now() - interval '30 minutes'),
  ('e0000000-0000-4000-8000-0000000000e4', 'e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a3', 'in',  'quiero agendar', now() - interval '10 days'),
  ('e0000000-0000-4000-8000-0000000000e5', 'e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a3', 'out', 'recordatorio', now() - interval '1 day');
INSERT INTO public.insight_topics (id, workspace_id, name, description, created_at, covered_from) VALUES
  ('e0000000-0000-4000-8000-0000000000f1', 'e0000000-0000-4000-8000-000000000001', 'Precio', 'Objeta el precio', now() - interval '60 days', now() - interval '60 days');

-- ── Eligibility: the customer's last message ────────────────────────────────
CREATE TEMP TABLE picked AS
  SELECT * FROM public.select_conversations_to_classify(10, '{}', 120);
SELECT is((SELECT array_agg(conversation_id ORDER BY conversation_id) FROM picked),
  ARRAY['e0000000-0000-4000-8000-0000000000a1'::uuid, 'e0000000-0000-4000-8000-0000000000a3'::uuid],
  'picks conversations whose customer wrote over an hour ago, not one that just wrote');
SELECT is((SELECT last_inbound_at FROM picked WHERE conversation_id = 'e0000000-0000-4000-8000-0000000000a1'),
  (SELECT created_at FROM public.messages WHERE id = 'e0000000-0000-4000-8000-0000000000e1'),
  'the pick carries the customer''s newest message, not the bot''s later reply');

-- The run saves a1 with one citation of the customer and one of the bot.
SELECT is(public.save_conversation_topics(
    'e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a1',
    '[{"topic_id": "e0000000-0000-4000-8000-0000000000f1", "message_id": "e0000000-0000-4000-8000-0000000000e1"},
      {"topic_id": "e0000000-0000-4000-8000-0000000000f1", "message_id": "e0000000-0000-4000-8000-0000000000e2"}]'::jsonb,
    (SELECT last_inbound_at FROM picked WHERE conversation_id = 'e0000000-0000-4000-8000-0000000000a1')),
  1, 'save_conversation_topics keeps the customer''s message as evidence and drops the bot''s');
SELECT public.save_conversation_topics(
  'e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a3', '[]'::jsonb,
  (SELECT last_inbound_at FROM picked WHERE conversation_id = 'e0000000-0000-4000-8000-0000000000a3'));

-- A reminder goes out to a1: nothing new from the customer, nothing to pay for.
INSERT INTO public.messages (workspace_id, conversation_id, direction, body, created_at)
VALUES ('e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a1', 'out', 'te recordamos tu cita', now() - interval '90 minutes');
SELECT is((SELECT count(*)::int FROM public.select_conversations_to_classify(10, '{}', 120)), 0,
  'a reply or a reminder does not make a classified conversation eligible again');

-- The customer writes again (settled): eligible again.
INSERT INTO public.messages (workspace_id, conversation_id, direction, body, created_at)
VALUES ('e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a1', 'in', 'y el estacionamiento?', now() - interval '70 minutes');
SELECT is((SELECT array_agg(conversation_id) FROM public.select_conversations_to_classify(10, '{}', 120)),
  ARRAY['e0000000-0000-4000-8000-0000000000a1'::uuid],
  'a new message from the customer makes it eligible again');
SELECT is((SELECT count(*)::int FROM public.select_conversations_to_classify(10, '{}', 120, now() + interval '1 minute')), 0,
  'the lease hides a claimed conversation from the next pick');

-- The analysis counts follow the customer too: a1's new message and a2's
-- are still unread; a3 (a reminder after its classified message) is not in
-- the period, and a4/a5 have no customer message yet.
SELECT is(public.get_insights('e0000000-0000-4000-8000-000000000001',
            now() - interval '7 days', now(), '{}', 'UTC')->'analysis',
  '{"conversations": 2, "analyzed": 0, "pending": 2, "failed": 0, "too_old": 0}'::jsonb,
  'the analysis counts say how many conversations of the period are read, and why not the rest');

-- ── The classification budget is its own ────────────────────────────────────
INSERT INTO public.events (type, level, workspace_id, payload)
VALUES ('llm_usage', 'info', 'e0000000-0000-4000-8000-000000000001', '{"total_tokens": 900000}');
CREATE TEMP TABLE res AS
  SELECT public.reserve_classification_tokens('e0000000-0000-4000-8000-000000000001',
    'e0000000-0000-4000-8000-0000000000a1', 1000, 300000) AS id;
SELECT ok((SELECT id FROM res) IS NOT NULL,
  'a busy bot (900k tokens today) does not use up the classification budget');
SELECT is((SELECT type FROM public.events WHERE id = (SELECT id FROM res)), 'topic_classification',
  'the reservation is logged as topic_classification, not llm_usage');
SELECT is(public.sum_daily_llm_tokens('e0000000-0000-4000-8000-000000000001',
    date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
  900000::bigint, 'classification spend stays out of the bot''s daily budget');
INSERT INTO public.events (type, level, workspace_id, payload)
VALUES ('topic_classification', 'info', 'e0000000-0000-4000-8000-000000000001', '{"total_tokens": 298500}');
SELECT is(public.reserve_classification_tokens('e0000000-0000-4000-8000-000000000001',
    'e0000000-0000-4000-8000-0000000000a1', 1000, 300000), NULL,
  'the cap counts classification spend: 299,500 + 1,000 > 300,000 is refused');
SELECT ok(public.settle_classification_tokens((SELECT id FROM res), 'e0000000-0000-4000-8000-000000000001',
    'openai/gpt-4o-mini', 400, 20),
  'settle_classification_tokens settles a classification reservation');
SELECT is((SELECT (payload->>'total_tokens')::int FROM public.events WHERE id = (SELECT id FROM res)), 420,
  'the settled row holds the real usage');

-- ── Backfill on the customer's last message, and its coverage ───────────────
INSERT INTO public.insight_topics (id, workspace_id, name, description, created_at, covered_from) VALUES
  ('e0000000-0000-4000-8000-0000000000f2', 'e0000000-0000-4000-8000-000000000001', 'Agenda', 'Quiere agendar', now() - interval '5 days', now() - interval '5 days');
SELECT is((SELECT array_agg(conversation_id) FROM public.next_backfill_batch('e0000000-0000-4000-8000-0000000000f2', 10)),
  ARRAY['e0000000-0000-4000-8000-0000000000a3'::uuid],
  'the backfill takes a conversation whose customer last wrote before the topic, even with a reminder after it');
SELECT is((SELECT last_inbound_at FROM public.next_backfill_batch('e0000000-0000-4000-8000-0000000000f2', 10)),
  (SELECT created_at FROM public.messages WHERE id = 'e0000000-0000-4000-8000-0000000000e4'),
  'the backfill cursor walks the customer''s last message');
SELECT is(public.advance_topic_backfill('e0000000-0000-4000-8000-0000000000f2', NULL, NULL, true), 'done',
  'an empty batch closes the backfill');
SELECT ok((SELECT abs(extract(epoch FROM covered_from - (now() - interval '30 days'))) < 1
             FROM public.insight_topics WHERE id = 'e0000000-0000-4000-8000-0000000000f2'),
  'a finished backfill moves covered_from back to the window it went through');
INSERT INTO public.insight_topics (id, workspace_id, name, description, created_at, covered_from, backfill_status) VALUES
  ('e0000000-0000-4000-8000-0000000000f4', 'e0000000-0000-4000-8000-000000000001', 'Viejo', 'x', now() - interval '45 days', now() - interval '45 days', 'pending');
SELECT is(public.advance_topic_backfill('e0000000-0000-4000-8000-0000000000f4', NULL, NULL, true), 'expired',
  'a backfill past its window expires');
SELECT ok((SELECT abs(extract(epoch FROM covered_from - (now() - interval '45 days'))) < 1
             FROM public.insight_topics WHERE id = 'e0000000-0000-4000-8000-0000000000f4'),
  'an expired backfill leaves covered_from at created_at');

-- ── The dashboard measures each topic over its coverage ─────────────────────
-- Topic f3 is covered from 2 days ago. a4's customer raised it 5 days ago
-- (before coverage, e.g. seen as context), a5's yesterday.
INSERT INTO public.insight_topics (id, workspace_id, name, description, created_at, covered_from, backfill_status) VALUES
  ('e0000000-0000-4000-8000-0000000000f3', 'e0000000-0000-4000-8000-000000000001', 'Horarios', 'Pregunta horarios', now() - interval '2 days', now() - interval '2 days', 'expired');
INSERT INTO public.messages (id, workspace_id, conversation_id, direction, body, created_at) VALUES
  ('e0000000-0000-4000-8000-0000000000e6', 'e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a4', 'in', 'a qué hora abren', now() - interval '5 days'),
  ('e0000000-0000-4000-8000-0000000000e7', 'e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a5', 'in', 'abren el sábado?', now() - interval '1 day');
INSERT INTO public.conversation_topics (conversation_id, topic_id, workspace_id, evidence_message_id, detected_at) VALUES
  ('e0000000-0000-4000-8000-0000000000a4', 'e0000000-0000-4000-8000-0000000000f3', 'e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000e6', now() - interval '5 days'),
  ('e0000000-0000-4000-8000-0000000000a5', 'e0000000-0000-4000-8000-0000000000f3', 'e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000e7', now() - interval '1 day');
-- Both were read by the nightly run (a topic counts only analysed ones).
SELECT public.save_conversation_topics('e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a4', '[]'::jsonb, now() - interval '5 days');
SELECT public.save_conversation_topics('e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a5', '[]'::jsonb, now() - interval '1 day');
CREATE TEMP TABLE ins AS
  SELECT t AS topic
    FROM jsonb_array_elements(public.get_insights('e0000000-0000-4000-8000-000000000001',
           now() - interval '7 days', now(), '{}', 'UTC')->'topics') t
   WHERE t->>'id' = 'e0000000-0000-4000-8000-0000000000f3';
SELECT is((SELECT (topic->>'conversations')::int FROM ins), 1,
  'a detection from before the topic''s coverage does not count');
SELECT ok((SELECT (topic->>'universe')::int FROM ins)
          < (SELECT (public.get_insights('e0000000-0000-4000-8000-000000000001',
                      now() - interval '7 days', now(), '{}', 'UTC')->'base'->>'conversations')::int),
  'the topic''s share is over the customers who wrote while it was covered, not the whole range');
SELECT ok((SELECT topic->'prev_conversations' = 'null'::jsonb FROM ins),
  'no previous-period count (so no delta) when that period was not covered');
SELECT ok((SELECT topic->>'covered_from' IS NOT NULL FROM ins),
  'covered_from comes back when coverage starts inside the range');
SELECT is((SELECT array_agg(conversation_id) FROM public.get_insight_evidence(
    'e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000f3',
    now() - interval '7 days', now(), 'all', NULL, 20, 0)),
  ARRAY['e0000000-0000-4000-8000-0000000000a5'::uuid],
  'the evidence list behind the cell holds the same conversations');
SELECT is((SELECT (t->>'prev_conversations')::int
             FROM jsonb_array_elements(public.get_insights('e0000000-0000-4000-8000-000000000001',
                    now() - interval '7 days', now(), '{}', 'UTC')->'topics') t
            WHERE t->>'id' = 'e0000000-0000-4000-8000-0000000000f1'), 0,
  'a topic covered through the previous period keeps its comparison');

-- ── A failure waits before its next try (review M4) ─────────────────────────
INSERT INTO public.contacts (id, workspace_id, phone) VALUES
  ('e0000000-0000-4000-8000-0000000000c6', 'e0000000-0000-4000-8000-000000000001', '+15550100006');
INSERT INTO public.conversations (id, workspace_id, contact_id, last_message_at) VALUES
  ('e0000000-0000-4000-8000-0000000000a6', 'e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000c6', now() - interval '3 hours');
INSERT INTO public.messages (workspace_id, conversation_id, direction, body, created_at) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a6', 'in', 'x', now() - interval '3 hours');
SELECT is(public.record_classification_failure('e0000000-0000-4000-8000-000000000001',
    'e0000000-0000-4000-8000-0000000000a6', 'invalid_output'), 1, 'the first failure counts one attempt');
SELECT is((SELECT count(*)::int FROM public.select_conversations_to_classify(100, '{}', 120)
            WHERE conversation_id = 'e0000000-0000-4000-8000-0000000000a6'), 0,
  'a failed conversation is not picked again in the same run');
SELECT is((SELECT count(*)::int FROM public.select_conversations_to_classify(100, '{}', 120, now() + interval '61 minutes')
            WHERE conversation_id = 'e0000000-0000-4000-8000-0000000000a6'), 1,
  'an hour later it is tried again');

-- ── The backfill reads only what the nightly run read without the topic (M3) ─
INSERT INTO public.insight_topics (id, workspace_id, name, description) VALUES
  ('e0000000-0000-4000-8000-0000000000f5', 'e0000000-0000-4000-8000-000000000001', 'Envíos', 'Pregunta por envíos');
INSERT INTO public.contacts (id, workspace_id, phone) VALUES
  ('e0000000-0000-4000-8000-0000000000c7', 'e0000000-0000-4000-8000-000000000001', '+15550100007');
INSERT INTO public.conversations (id, workspace_id, contact_id, last_message_at) VALUES
  ('e0000000-0000-4000-8000-0000000000a7', 'e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000c7', now() - interval '2 days');
INSERT INTO public.messages (id, workspace_id, conversation_id, direction, body, created_at) VALUES
  ('e0000000-0000-4000-8000-0000000000e8', 'e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a7', 'in', '¿envían a Mérida?', now() - interval '2 days');
-- The nightly run read a7 with the new topic already in its catalog.
SELECT public.save_conversation_topics('e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a7',
  '[]'::jsonb, now() - interval '2 days', NULL, NULL,
  ARRAY['e0000000-0000-4000-8000-0000000000f1', 'e0000000-0000-4000-8000-0000000000f5']::uuid[]);
CREATE TEMP TABLE bf AS SELECT conversation_id FROM public.next_backfill_batch('e0000000-0000-4000-8000-0000000000f5', 100);
SELECT ok(EXISTS (SELECT 1 FROM bf WHERE conversation_id = 'e0000000-0000-4000-8000-0000000000a3'),
  'the backfill reads a conversation the nightly run read before the topic existed');
SELECT ok(NOT EXISTS (SELECT 1 FROM bf WHERE conversation_id = 'e0000000-0000-4000-8000-0000000000a7'),
  'it does not pay again for one the nightly run already read with the topic');
SELECT ok(NOT EXISTS (SELECT 1 FROM bf WHERE conversation_id IN ('e0000000-0000-4000-8000-0000000000a1',
                                                               'e0000000-0000-4000-8000-0000000000a2')),
  'nor for one still waiting for the nightly run (it will read it with the topic)');
SELECT is((SELECT catalog_at FROM public.conversation_classification
            WHERE conversation_id = 'e0000000-0000-4000-8000-0000000000a7'),
  (SELECT created_at FROM public.insight_topics WHERE id = 'e0000000-0000-4000-8000-0000000000f5'),
  'the nightly run records the newest topic of the catalog it used');

-- ── Topics are measured over analysed conversations (review H2) ─────────────
-- Yesterday 10 customers asked about prices; the run read 4 so far, 1 failed
-- three times, and a customer from 40 days ago was never read.
DO $h2$
DECLARE i INT; k UUID; c UUID; m UUID; t UUID := 'e2000000-0000-4000-8000-0000000000f1';
  ws UUID := 'e2000000-0000-4000-8000-000000000001';
BEGIN
  INSERT INTO public.workspaces (id, name, slug) VALUES (ws, 'H2', 'h2-test');
  INSERT INTO public.insight_topics (id, workspace_id, name, description, created_at, covered_from, backfill_status)
  VALUES (t, ws, 'Precio', 'x', now() - interval '90 days', now() - interval '120 days', 'done');
  FOR i IN 1..11 LOOP
    k := gen_random_uuid(); c := gen_random_uuid(); m := gen_random_uuid();
    INSERT INTO public.contacts (id, workspace_id, phone) VALUES (k, ws, '+1555930000' || lpad(i::text, 2, '0'));
    INSERT INTO public.conversations (id, workspace_id, contact_id, last_message_at)
    VALUES (c, ws, k, CASE WHEN i = 11 THEN now() - interval '40 days' ELSE now() - interval '1 day' END);
    INSERT INTO public.messages (id, workspace_id, conversation_id, direction, body, created_at)
    VALUES (m, ws, c, 'in', '¿precio?', CASE WHEN i = 11 THEN now() - interval '40 days' ELSE now() - interval '1 day' END);
    IF i <= 4 THEN
      PERFORM public.save_conversation_topics(ws, c,
        jsonb_build_array(jsonb_build_object('topic_id', t, 'message_id', m)), now() - interval '1 day');
    ELSIF i = 5 THEN
      PERFORM public.record_classification_failure(ws, c, 'invalid_output', now() - interval '20 hours');
      PERFORM public.record_classification_failure(ws, c, 'invalid_output', now() - interval '18 hours');
      PERFORM public.record_classification_failure(ws, c, 'invalid_output', now() - interval '12 hours');
    END IF;
  END LOOP;
END
$h2$;
CREATE TEMP TABLE h2 AS SELECT public.get_insights('e2000000-0000-4000-8000-000000000001',
  now() - interval '60 days', now(), '{}', 'UTC') AS j;
SELECT is((SELECT (j->'topics'->0->>'universe')::int FROM h2), 4,
  'the topic is measured over the 4 analysed conversations, not the 11 of the period');
SELECT is((SELECT (j->'topics'->0->>'conversations')::int FROM h2), 4, '4 of those 4 raised it (100 %, not 36 %)');
SELECT is((SELECT (j->'topics'->0->>'in_coverage')::int FROM h2), 11, 'in_coverage counts the unread ones too');
SELECT is((SELECT j->'analysis' FROM h2),
  '{"conversations": 11, "analyzed": 4, "pending": 5, "failed": 1, "too_old": 1}'::jsonb,
  'the notice has the counts: pending, failed (quarantine) and too old to be read');

-- ── Fair and oldest first (review H2) ────────────────────────────────────────
-- Workspace F1 has 6 customers waiting (1 to 6 days), F2 one (today).
DO $fair$
DECLARE i INT; k UUID; c UUID; w UUID;
BEGIN
  INSERT INTO public.workspaces (id, name, slug) VALUES
    ('e3000000-0000-4000-8000-000000000001', 'F1', 'f1-test'), ('e3000000-0000-4000-8000-000000000002', 'F2', 'f2-test');
  INSERT INTO public.insight_topics (workspace_id, name, description) VALUES
    ('e3000000-0000-4000-8000-000000000001', 'x', 'x'), ('e3000000-0000-4000-8000-000000000002', 'x', 'x');
  FOR i IN 1..7 LOOP
    w := CASE WHEN i = 7 THEN 'e3000000-0000-4000-8000-000000000002'::uuid ELSE 'e3000000-0000-4000-8000-000000000001'::uuid END;
    k := gen_random_uuid(); c := ('e3000000-0000-4000-8000-0000000000a' || i)::uuid;
    INSERT INTO public.contacts (id, workspace_id, phone) VALUES (k, w, '+1555940000' || i);
    INSERT INTO public.conversations (id, workspace_id, contact_id, last_message_at)
    VALUES (c, w, k, CASE WHEN i = 7 THEN now() - interval '2 hours' ELSE now() - make_interval(days => i) END);
    INSERT INTO public.messages (workspace_id, conversation_id, direction, body, created_at)
    VALUES (w, c, 'in', 'x', CASE WHEN i = 7 THEN now() - interval '2 hours' ELSE now() - make_interval(days => i) END);
  END LOOP;
END
$fair$;
CREATE TEMP TABLE fair AS
  SELECT conversation_id FROM public.select_conversations_to_classify(2,
    ARRAY(SELECT id FROM public.workspaces WHERE id NOT IN ('e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000002')),
    120);
SELECT is((SELECT array_agg(conversation_id ORDER BY conversation_id) FROM fair),
  ARRAY['e3000000-0000-4000-8000-0000000000a2'::uuid, 'e3000000-0000-4000-8000-0000000000a7'::uuid],
  'workspaces take turns; each one''s first is its oldest customer of the last 48 hours');
-- F1 on its own: the rest of the last 48 h oldest first, then the older ones
-- newest first (a first topic reads its history from yesterday backwards).
SELECT is((SELECT array_agg(s.conversation_id ORDER BY s.ord)
             FROM public.select_conversations_to_classify(4,
                    ARRAY(SELECT id FROM public.workspaces WHERE id <> 'e3000000-0000-4000-8000-000000000001'), 120)
                  WITH ORDINALITY AS s(conversation_id, workspace_id, contact_id, last_inbound_at, ord)),
  ARRAY['e3000000-0000-4000-8000-0000000000a1', 'e3000000-0000-4000-8000-0000000000a3',
        'e3000000-0000-4000-8000-0000000000a4', 'e3000000-0000-4000-8000-0000000000a5']::uuid[],
  'inside a workspace: the last 48 hours oldest first, then the rest newest first');

-- ── One active topic per name, case and accents aside (review) ──────────────
SELECT throws_ok(
  $$INSERT INTO public.insight_topics (workspace_id, name, description)
    VALUES ('e0000000-0000-4000-8000-000000000001', '  PRECÍO ', 'x')$$,
  'P0001', 'insight_topics_duplicate', '"PRECÍO" is the active "Precio" again');
UPDATE public.insight_topics SET status = 'archived' WHERE id = 'e0000000-0000-4000-8000-0000000000f4';
SELECT lives_ok(
  $$INSERT INTO public.insight_topics (workspace_id, name, description)
    VALUES ('e0000000-0000-4000-8000-000000000001', 'viejo', 'x')$$,
  'an archived topic does not hold its name');
SELECT throws_ok(
  $$INSERT INTO public.insight_topics (workspace_id, name, description)
    VALUES ('e0000000-0000-4000-8000-000000000001', 'Preci' || 'o' || U&'\0301', 'x')$$,
  'P0001', 'insight_topics_duplicate', 'an accent typed as a combining mark is the same name');
SELECT throws_ok(
  $$INSERT INTO public.insight_topics (workspace_id, name, description)
    VALUES ('e0000000-0000-4000-8000-000000000001', U&'Viejo\00A0', 'x')$$,
  'P0001', 'insight_topics_duplicate', 'a non-breaking space counts as a space');

-- ── Transient failures wait without spending an attempt; blocked causes ─────
SELECT public.defer_classification('e0000000-0000-4000-8000-000000000001',
  'e0000000-0000-4000-8000-0000000000a7', 'timeout', 3600);
SELECT is((SELECT attempts FROM public.conversation_classification
            WHERE conversation_id = 'e0000000-0000-4000-8000-0000000000a7'), 0,
  'a transient failure spends no attempt');
SELECT ok((SELECT claimed_until > now() + interval '59 minutes' FROM public.conversation_classification
            WHERE conversation_id = 'e0000000-0000-4000-8000-0000000000a7'),
  'it waits an hour before the next try');
SELECT public.defer_classification('e0000000-0000-4000-8000-000000000001',
  'e0000000-0000-4000-8000-0000000000a7', 'timeout', 3600);
SELECT public.defer_classification('e0000000-0000-4000-8000-000000000001',
  'e0000000-0000-4000-8000-0000000000a7', 'timeout', 3600);
SELECT ok((SELECT claimed_until BETWEEN now() + interval '239 minutes' AND now() + interval '241 minutes'
             FROM public.conversation_classification WHERE conversation_id = 'e0000000-0000-4000-8000-0000000000a7'),
  'the wait doubles each time the same conversation fails that way again (1 h, 2 h, 4 h)');
SELECT public.note_classification_blocked('e0000000-0000-4000-8000-000000000001', 'key');
SELECT public.note_classification_blocked('e0000000-0000-4000-8000-000000000001', 'key');
SELECT public.note_classification_blocked('e0000000-0000-4000-8000-000000000001', 'cap');
SELECT is((SELECT count(*)::int FROM public.events
            WHERE workspace_id = 'e0000000-0000-4000-8000-000000000001' AND type = 'topic_classification_blocked'), 2,
  'a blocked cause is noted once per workspace, reason and hour');
SELECT ok(NOT has_function_privilege('authenticated', 'public.defer_classification(uuid, uuid, text, integer, timestamptz)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.note_classification_blocked(uuid, text, timestamptz)', 'EXECUTE'),
  'sessions cannot defer a conversation or note a blocked workspace');

-- ── A topic counts only conversations read WITH it (review LOW 8) ────────────
-- Topic T (created 5 days ago, backfill done from 10 days back). X was read
-- by the nightly run before T existed and the backfill left it out; Y was
-- backfilled for T; Z was read by the nightly run with T in its catalog.
DO $l8$
DECLARE ws UUID := 'e4000000-0000-4000-8000-000000000001'; t UUID := 'e4000000-0000-4000-8000-0000000000f1';
  old_t UUID := 'e4000000-0000-4000-8000-0000000000f0'; k UUID; c UUID; m UUID; tag TEXT;
BEGIN
  INSERT INTO public.workspaces (id, name, slug) VALUES (ws, 'L8', 'l8-test');
  INSERT INTO public.insight_topics (id, workspace_id, name, description, created_at, covered_from, backfill_status) VALUES
    (old_t, ws, 'Viejo', 'x', now() - interval '60 days', now() - interval '60 days', 'done'),
    (t, ws, 'Nuevo', 'x', now() - interval '5 days', now() - interval '10 days', 'done');
  FOREACH tag IN ARRAY ARRAY['x', 'y', 'z'] LOOP
    k := gen_random_uuid(); c := ('e4000000-0000-4000-8000-0000000000a' || CASE tag WHEN 'x' THEN '1' WHEN 'y' THEN '2' ELSE '3' END)::uuid; m := gen_random_uuid();
    INSERT INTO public.contacts (id, workspace_id, phone) VALUES (k, ws, '+1555950000' || tag);
    INSERT INTO public.conversations (id, workspace_id, contact_id, last_message_at) VALUES (c, ws, k, now() - interval '7 days');
    INSERT INTO public.messages (id, workspace_id, conversation_id, direction, body, created_at) VALUES (m, ws, c, 'in', 'hola', now() - interval '7 days');
    -- The nightly run read it 7 days ago, when only the old topic existed…
    PERFORM public.save_conversation_topics(ws, c, '[]'::jsonb, now() - interval '7 days', NULL, NULL, ARRAY[old_t]);
    IF tag = 'y' THEN
      PERFORM public.save_conversation_topics(ws, c, '[]'::jsonb, NULL, NULL, NULL, NULL, t);
    ELSIF tag = 'z' THEN
      UPDATE public.conversation_classification SET catalog_at = now() - interval '5 days' WHERE conversation_id = c;
    END IF;
  END LOOP;
END
$l8$;
SELECT is((SELECT (x->>'universe')::int FROM jsonb_array_elements(public.get_insights(
            'e4000000-0000-4000-8000-000000000001', now() - interval '9 days', now(), '{}', 'UTC')->'topics') x
          WHERE x->>'name' = 'Nuevo'), 2,
  'a conversation the backfill left out and the nightly run never read with the topic is not in its denominator');

-- ── Why the rest isn't being read (review LOW 9) ─────────────────────────────
SELECT public.note_classification_blocked('e4000000-0000-4000-8000-000000000001', 'key');
SELECT is(public.get_insights('e4000000-0000-4000-8000-000000000001', now() - interval '9 days', now(), '{}', 'UTC')->>'blocked',
  'key', 'the dashboard gets the cause: the workspace''s key is failing');
INSERT INTO public.events (type, level, workspace_id, payload, created_at)
VALUES ('topic_classification', 'info', 'e4000000-0000-4000-8000-000000000001',
        '{"reserved": false, "total_tokens": 1500}', now() + interval '1 second');
SELECT is(public.get_insights('e4000000-0000-4000-8000-000000000001', now() - interval '9 days', now(), '{}', 'UTC')->>'blocked',
  NULL, 'a paid classification since then clears it');

SELECT * FROM finish();
ROLLBACK;
