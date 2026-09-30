-- Topic insights (#13) — run with `supabase test db` against a local stack.
--
-- Pins the rules the nightly classifier and the /analisis dashboard were
-- ported with: service-role-only functions, eligibility on the customer's
-- last message, evidence only from the customer, a classification budget of
-- its own, and each topic measured only over the period it was analysed.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(34);

-- ── Privileges ───────────────────────────────────────────────────────────────
SELECT ok(NOT has_function_privilege('anon',
  'public.select_conversations_to_classify(integer, uuid[], integer, timestamptz)', 'EXECUTE'),
  'anon cannot execute select_conversations_to_classify()');
SELECT ok(NOT has_function_privilege('authenticated',
  'public.reserve_classification_tokens(uuid, uuid, integer, bigint)', 'EXECUTE'),
  'authenticated cannot execute reserve_classification_tokens()');
SELECT ok(NOT has_function_privilege('authenticated',
  'public.get_insights(uuid, timestamptz, timestamptz, text[], text)', 'EXECUTE'),
  'authenticated cannot execute get_insights() (it reads without RLS)');
SELECT ok(has_function_privilege('service_role',
  'public.get_insights(uuid, timestamptz, timestamptz, text[], text)', 'EXECUTE'),
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

-- oldest_pending follows the customer too: a1's new message is pending; a3
-- (a reminder after its classified message) and a4/a5 (no customer message
-- yet) are not.
SELECT is((public.get_insights('e0000000-0000-4000-8000-000000000001',
            now() - interval '7 days', now(), '{}', 'UTC')->>'oldest_pending')::timestamptz,
  now() - interval '70 minutes',
  'oldest_pending is the oldest customer message the nightly run still has to read');

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

SELECT * FROM finish();
ROLLBACK;
