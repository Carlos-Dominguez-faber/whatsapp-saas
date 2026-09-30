-- HubSpot: one active CRM, the conversation-log queue and the token-bound
-- contact links — run with `supabase test db`.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(30);

-- ── privileges: the queue and its RPCs are service role only ────────────────
SELECT ok(NOT has_table_privilege('anon', 'public.hubspot_conversation_logs', 'SELECT'),
  'anon cannot read hubspot_conversation_logs');
SELECT ok(NOT has_table_privilege('authenticated', 'public.hubspot_conversation_logs', 'SELECT'),
  'sessions cannot read hubspot_conversation_logs');
SELECT ok(NOT has_table_privilege('authenticated', 'public.hubspot_conversation_logs', 'INSERT'),
  'sessions cannot write hubspot_conversation_logs');
SELECT ok(NOT has_function_privilege('anon', 'public.enqueue_hubspot_conversation_log(uuid,uuid,integer,text)', 'EXECUTE'),
  'anon cannot enqueue');
SELECT ok(NOT has_function_privilege('authenticated', 'public.claim_hubspot_conversation_log(integer)', 'EXECUTE'),
  'authenticated cannot claim');
SELECT ok(NOT has_function_privilege('authenticated', 'public.mark_hubspot_ready(uuid,text,text)', 'EXECUTE'),
  'authenticated cannot mark HubSpot ready');
SELECT ok(NOT has_function_privilege('authenticated', 'public.link_hubspot_contact(uuid,uuid,text,text)', 'EXECUTE'),
  'authenticated cannot link contacts');
SELECT ok(NOT has_function_privilege('authenticated', 'public.read_hubspot_link(uuid,uuid,text)', 'EXECUTE'),
  'authenticated cannot read links');
SELECT ok(NOT has_function_privilege('authenticated', 'public.purge_hubspot_conversation_logs(integer,integer)', 'EXECUTE'),
  'authenticated cannot purge');
SELECT ok(has_function_privilege('service_role', 'public.purge_hubspot_conversation_logs(integer,integer)', 'EXECUTE'),
  'service_role can purge');

-- ── fixtures ─────────────────────────────────────────────────────────────────
INSERT INTO public.workspaces (id, name, slug) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'HS', 'hs-tests'),
  ('e0000000-0000-4000-8000-000000000002', 'Other', 'hs-other');
INSERT INTO public.contacts (id, workspace_id, phone) VALUES
  ('e0000000-0000-4000-8000-0000000000c1', 'e0000000-0000-4000-8000-000000000001', '+15550002001');
INSERT INTO public.conversations (id, workspace_id, contact_id) VALUES
  ('e0000000-0000-4000-8000-0000000000a1', 'e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000c1');

-- ── one active CRM ───────────────────────────────────────────────────────────
INSERT INTO public.integrations (workspace_id, provider, enabled, credentials, config) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'highlevel', true, '{}', '{}');
SELECT throws_ok($$
  INSERT INTO public.integrations (workspace_id, provider, enabled, credentials, config)
  VALUES ('e0000000-0000-4000-8000-000000000001', 'hubspot', true, '{}', '{}')
$$, '23505', NULL, 'HubSpot cannot be enabled next to HighLevel');
SELECT lives_ok($$
  INSERT INTO public.integrations (workspace_id, provider, enabled, credentials, config)
  VALUES ('e0000000-0000-4000-8000-000000000001', 'hubspot', false, '{}',
          '{"token_fingerprint":"fp_a","properties_ready":true,"portal_id":"111"}')
$$, 'a disabled HubSpot row is allowed next to HighLevel');

-- The queue only takes a log when HubSpot is the enabled CRM.
SELECT is(public.enqueue_hubspot_conversation_log(
  'e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a1', 1, 'handoff'),
  false, 'nothing is queued while HubSpot is not enabled');

UPDATE public.integrations SET enabled = false
 WHERE workspace_id = 'e0000000-0000-4000-8000-000000000001' AND provider = 'highlevel';
UPDATE public.integrations SET enabled = true
 WHERE workspace_id = 'e0000000-0000-4000-8000-000000000001' AND provider = 'hubspot';

SELECT is(public.enqueue_hubspot_conversation_log(
  'e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a1', 1, 'handoff'),
  true, 'a handoff is queued once HubSpot is the CRM');
SELECT is(public.enqueue_hubspot_conversation_log(
  'e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a1', 1, 'handoff'),
  false, 'the same transition is queued once');
SELECT is(public.enqueue_hubspot_conversation_log(
  'e0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-0000000000a1', 2, 'closed'),
  false, 'another workspace cannot queue this conversation');

-- ── claim: a lease, and attempts go up ──────────────────────────────────────
CREATE TEMP TABLE c1 AS SELECT * FROM public.claim_hubspot_conversation_log(120);
SELECT is((SELECT attempts FROM c1), 1, 'the claim takes the row and counts the attempt');
SELECT is((SELECT count(*)::INT FROM public.claim_hubspot_conversation_log(120)), 0,
  'a leased row is not claimed again');

-- ── links: numeric ids, bound to the tested token ───────────────────────────
SELECT throws_ok($$
  UPDATE public.contacts SET hs_contact_id = '12/../deals'
   WHERE id = 'e0000000-0000-4000-8000-0000000000c1'
$$, '23514', NULL, 'hs_contact_id takes HubSpot ids only (digits)');
SELECT is(public.link_hubspot_contact('e0000000-0000-4000-8000-000000000001',
  'e0000000-0000-4000-8000-0000000000c1', '600', 'fp_other'), false,
  'a link made with another token is refused');
SELECT is(public.link_hubspot_contact('e0000000-0000-4000-8000-000000000001',
  'e0000000-0000-4000-8000-0000000000c1', '600', 'fp_a'), true,
  'a link made with the tested token is written');
SELECT is((SELECT ready FROM public.read_hubspot_link('e0000000-0000-4000-8000-000000000001',
  'e0000000-0000-4000-8000-0000000000c1', 'fp_other')), false,
  'a link is not read with another token');

-- ── a token problem parks a log; a passing test (same portal) requeues it ───
INSERT INTO public.hubspot_conversation_logs (workspace_id, conversation_id, from_state_version, reason, status, attempts, last_error)
VALUES ('e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a1', 30, 'handoff', 'parked', 1, 'missing_scope');
SELECT is((SELECT count(*)::INT FROM public.claim_hubspot_conversation_log(120) c
            WHERE c.id = (SELECT id FROM public.hubspot_conversation_logs WHERE from_state_version = 30)),
  0, 'a parked log is never claimed');
CREATE TEMP TABLE m0 AS SELECT * FROM public.mark_hubspot_ready(
  'e0000000-0000-4000-8000-000000000001', 'fp_a', '111');
SELECT ok((SELECT updated AND NOT portal_changed AND logs_requeued = 1 FROM m0),
  'a passing test on the same portal requeues the parked log');
SELECT is((SELECT status || '/' || attempts || '/' || coalesce(last_error, '-') FROM public.hubspot_conversation_logs
            WHERE from_state_version = 30), 'pending/0/-', 'back to pending, attempts from 0');
UPDATE public.hubspot_conversation_logs SET status = 'parked', last_error = 'unauthorized' WHERE from_state_version = 30;

-- ── another portal: links cleared and pending logs cancelled at once ────────
UPDATE public.hubspot_conversation_logs SET claimed_until = NULL;
CREATE TEMP TABLE m1 AS SELECT * FROM public.mark_hubspot_ready(
  'e0000000-0000-4000-8000-000000000001', 'fp_a', '222');
SELECT ok((SELECT updated AND portal_changed AND links_cleared = 1 AND logs_cancelled = 2 AND logs_requeued = 0 FROM m1),
  'a new portal clears the links and cancels the pending and parked logs');
SELECT is((SELECT hs_contact_id FROM public.contacts WHERE id = 'e0000000-0000-4000-8000-0000000000c1'),
  NULL, 'the old portal''s id is gone');

-- ── purge: finished rows past the retention, pending ones never ─────────────
INSERT INTO public.hubspot_conversation_logs (workspace_id, conversation_id, from_state_version, reason, status, updated_at)
VALUES ('e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a1', 50, 'closed', 'done', now() - INTERVAL '40 days'),
       ('e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a1', 51, 'closed', 'pending', now() - INTERVAL '40 days'),
       ('e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a1', 52, 'closed', 'failed', now() - INTERVAL '2 days');
-- The update trigger (if any) must not have moved updated_at for this test.
UPDATE public.hubspot_conversation_logs SET updated_at = now() - INTERVAL '40 days' WHERE from_state_version IN (50, 51);
INSERT INTO public.hubspot_conversation_logs (workspace_id, conversation_id, from_state_version, reason, status, updated_at)
VALUES ('e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a1', 53, 'closed', 'parked', now()),
       ('e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a1', 54, 'closed', 'parked', now());
UPDATE public.hubspot_conversation_logs SET updated_at = now() - INTERVAL '40 days' WHERE from_state_version = 53;
UPDATE public.hubspot_conversation_logs SET updated_at = now() - INTERVAL '100 days' WHERE from_state_version = 54;
SELECT is(public.purge_hubspot_conversation_logs(30, 1000), 2,
  'the old finished row goes, and a parked one only past three times the retention');
SELECT is((SELECT count(*)::INT FROM public.hubspot_conversation_logs WHERE from_state_version = 53), 1,
  'a parked log 40 days old stays');
SELECT is((SELECT count(*)::INT FROM public.hubspot_conversation_logs WHERE from_state_version IN (51, 52)), 2,
  'a pending row and a recent failed one stay');

SELECT * FROM finish();
ROLLBACK;
