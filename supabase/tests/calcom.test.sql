-- Cal.com slot claims and booking cache — run with `supabase test db`.
--
-- claim_calcom_slot() is what keeps a retried or concurrent schedule_calcom
-- from booking twice, and what keeps a dead call's claim from holding the slot
-- forever. These pin both.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(22);

-- ── privileges: service role only ───────────────────────────────────────────
SELECT ok(NOT has_function_privilege('anon',
  'public.claim_calcom_slot(uuid,uuid,uuid,timestamptz,integer,integer)', 'EXECUTE'),
  'anon cannot execute claim_calcom_slot()');
SELECT ok(NOT has_function_privilege('authenticated',
  'public.claim_calcom_slot(uuid,uuid,uuid,timestamptz,integer,integer)', 'EXECUTE'),
  'authenticated cannot execute claim_calcom_slot()');
SELECT ok(has_function_privilege('service_role',
  'public.claim_calcom_slot(uuid,uuid,uuid,timestamptz,integer,integer)', 'EXECUTE'),
  'service_role can execute claim_calcom_slot()');

-- ── the cache index: total, one row per booking and workspace ──────────────
SELECT is(
  (SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_appointments_workspace_calcom_booking_uid'),
  'CREATE UNIQUE INDEX uq_appointments_workspace_calcom_booking_uid ON public.appointments USING btree (workspace_id, calcom_booking_uid)',
  'the Cal.com cache index is total (PostgREST upserts need it without a predicate)');

-- ── fixtures ─────────────────────────────────────────────────────────────────
INSERT INTO public.workspaces (id, name, slug) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'Cal', 'cal-claims');
INSERT INTO public.contacts (id, workspace_id, phone) VALUES
  ('c0000000-0000-4000-8000-0000000000c1', 'c0000000-0000-4000-8000-000000000001', '+15550001001'),
  ('c0000000-0000-4000-8000-0000000000c2', 'c0000000-0000-4000-8000-000000000001', '+15550001002');

CREATE TEMP TABLE r1 AS SELECT * FROM public.claim_calcom_slot(
  'c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000c1', NULL,
  '2030-06-12T16:00:00Z', 7, 120);
SELECT ok((SELECT claim_id IS NOT NULL AND holder_id IS NULL FROM r1), 'a free slot is claimed');
SELECT is(
  (SELECT meta->>'calcom_claim' FROM public.appointments WHERE id = (SELECT claim_id FROM r1)),
  'pending', 'the claim is marked pending, with no booking uid yet');

CREATE TEMP TABLE r2 AS SELECT * FROM public.claim_calcom_slot(
  'c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000c1', NULL,
  '2030-06-12T16:00:00Z', 7, 120);
SELECT ok((SELECT claim_id IS NULL AND holder_id = (SELECT claim_id FROM r1) AND holder_claim = 'pending' FROM r2),
  'a second claim for the same contact and instant gets the holder, not a new claim');

CREATE TEMP TABLE r3 AS SELECT * FROM public.claim_calcom_slot(
  'c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000c2', NULL,
  '2030-06-12T16:00:00Z', 7, 120);
SELECT ok((SELECT claim_id IS NOT NULL FROM r3), 'another contact claims the same instant (Cal.com decides if it is free)');

-- The playground has no contact: its claims still collide with each other.
CREATE TEMP TABLE r4 AS SELECT * FROM public.claim_calcom_slot(
  'c0000000-0000-4000-8000-000000000001', NULL, NULL, '2030-06-13T16:00:00Z', 7, 120);
CREATE TEMP TABLE r5 AS SELECT * FROM public.claim_calcom_slot(
  'c0000000-0000-4000-8000-000000000001', NULL, NULL, '2030-06-13T16:00:00Z', 7, 120);
SELECT ok((SELECT claim_id IS NULL AND holder_id = (SELECT claim_id FROM r4) FROM r5),
  'two contactless (playground) claims for one instant collide');

-- ── expiry: a claim without a booking whose call is over ────────────────────
UPDATE public.appointments SET created_at = now() - INTERVAL '10 minutes'
 WHERE id = (SELECT claim_id FROM r1);
CREATE TEMP TABLE r6 AS SELECT * FROM public.claim_calcom_slot(
  'c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000c1', NULL,
  '2030-06-12T16:00:00Z', 7, 120);
SELECT ok((SELECT claim_id IS NOT NULL AND claim_id <> (SELECT claim_id FROM r1) FROM r6),
  'a pending claim older than the TTL is taken over');
SELECT is(
  (SELECT status || ':' || (meta->>'calcom_claim') FROM public.appointments WHERE id = (SELECT claim_id FROM r1)),
  'cancelled:expired', 'the expired claim stays as a cancelled trace, out of the slot index');

-- A claim that may have booked ('sending', 'unknown', or a #15 claim with no
-- marker) never expires here, however old: schedule_calcom asks Cal.com.
UPDATE public.appointments
   SET created_at = now() - INTERVAL '1 day', meta = '{"calcom_claim":"unknown","attendee_email":"a@b.co"}'
 WHERE id = (SELECT claim_id FROM r6);
CREATE TEMP TABLE r7a AS SELECT * FROM public.claim_calcom_slot(
  'c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000c1', NULL,
  '2030-06-12T16:00:00Z', 7, 120);
SELECT ok((SELECT claim_id IS NULL AND holder_claim = 'unknown' AND holder_age_seconds >= 86399
                  AND holder_email = 'a@b.co' FROM r7a),
  'an unknown-outcome claim is never taken over; its age and email come back');
UPDATE public.appointments SET meta = '{}' WHERE id = (SELECT claim_id FROM r6);
CREATE TEMP TABLE r7b AS SELECT * FROM public.claim_calcom_slot(
  'c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000c1', NULL,
  '2030-06-12T16:00:00Z', 7, 120);
SELECT ok((SELECT claim_id IS NULL AND holder_claim = 'legacy' FROM r7b),
  'a #15 claim with no marker is never taken over either');
-- Freed once Cal.com says there is no booking (what schedule_calcom does):
UPDATE public.appointments SET status = 'cancelled', meta = '{"calcom_claim":"released"}'
 WHERE id = (SELECT claim_id FROM r6);
CREATE TEMP TABLE r7 AS SELECT * FROM public.claim_calcom_slot(
  'c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000c1', NULL,
  '2030-06-12T16:00:00Z', 7, 120);
SELECT ok((SELECT claim_id IS NOT NULL FROM r7), 'a released claim frees the slot');

-- A booking without a uid, a series, or a linked booking never expire.
UPDATE public.appointments
   SET created_at = now() - INTERVAL '10 minutes', meta = '{"calcom_claim":"booked_without_uid"}'
 WHERE id = (SELECT claim_id FROM r7);
CREATE TEMP TABLE r8 AS SELECT * FROM public.claim_calcom_slot(
  'c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000c1', NULL,
  '2030-06-12T16:00:00Z', 7, 120);
SELECT ok((SELECT claim_id IS NULL AND holder_claim = 'booked_without_uid' FROM r8),
  'a booking Cal.com made without a uid keeps the slot');

UPDATE public.appointments
   SET calcom_booking_uid = 'bk_1', meta = '{}'
 WHERE id = (SELECT claim_id FROM r7);
CREATE TEMP TABLE r9 AS SELECT * FROM public.claim_calcom_slot(
  'c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000c1', NULL,
  '2030-06-12T16:00:00Z', 8, 120);
SELECT ok((SELECT claim_id IS NULL AND holder_uid = 'bk_1' AND holder_event_type_id = 7 FROM r9),
  'a linked booking keeps the slot and says which service it is');

-- A claim within the TTL is never taken over, whatever its marker.
UPDATE public.appointments SET created_at = now() - INTERVAL '30 seconds' WHERE id = (SELECT claim_id FROM r3);
CREATE TEMP TABLE r10 AS SELECT * FROM public.claim_calcom_slot(
  'c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000c2', NULL,
  '2030-06-12T16:00:00Z', 7, 120);
SELECT ok((SELECT claim_id IS NULL AND holder_id = (SELECT claim_id FROM r3) FROM r10),
  'a claim younger than the TTL is not taken over');

-- A TTL below a minute is raised to one: a call in flight keeps its claim.
UPDATE public.appointments SET created_at = now() - INTERVAL '45 seconds' WHERE id = (SELECT claim_id FROM r3);
CREATE TEMP TABLE r11 AS SELECT * FROM public.claim_calcom_slot(
  'c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000c2', NULL,
  '2030-06-12T16:00:00Z', 7, 1);
SELECT ok((SELECT claim_id IS NULL FROM r11), 'the TTL never drops below 60 s');

-- ── a cancelled booking frees the slot; the cache index holds one row per uid ──
UPDATE public.appointments SET status = 'cancelled' WHERE id = (SELECT claim_id FROM r7);
CREATE TEMP TABLE r12 AS SELECT * FROM public.claim_calcom_slot(
  'c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000c1', NULL,
  '2030-06-12T16:00:00Z', 7, 120);
SELECT ok((SELECT claim_id IS NOT NULL FROM r12), 'a cancelled booking no longer holds the slot');

SELECT throws_ok($$
  INSERT INTO public.appointments (workspace_id, contact_id, scheduled_at, status, calcom_booking_uid)
  VALUES ('c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000c2',
          '2030-07-01T16:00:00Z', 'cancelled', 'bk_1')
$$, '23505', NULL, 'a Cal.com booking uid is cached once per workspace');

-- HighLevel rows (no event type) never collide with a Cal.com claim.
SELECT lives_ok($$
  INSERT INTO public.appointments (workspace_id, contact_id, scheduled_at, status, hl_appointment_id)
  VALUES ('c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000c1',
          '2030-06-12T16:00:00Z', 'booked', 'hl_1')
$$, 'a HighLevel appointment at a Cal.com-claimed instant is untouched by the claim index');

SELECT throws_ok($$
  SELECT * FROM public.claim_calcom_slot('c0000000-0000-4000-8000-000000000001', NULL, NULL, NULL, 7, 120)
$$, 'P0001', NULL, 'a claim needs an instant');

SELECT * FROM finish();
ROLLBACK;
