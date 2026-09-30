-- ============================================================================
-- Migration: 20261003000003_calcom_booking_cache
-- Cal.com bookings: one cached row per booking, and a slot claim that expires.
--
-- 1. uq_appointments_workspace_calcom_booking_uid — the local rows are a cache
--    of Cal.com's bookings (Cal.com is the only source of truth): every read
--    of a booking is written back to its row with an upsert on this pair. Same
--    shape and reasons as uq_appointments_workspace_hl_appointment_id
--    (20260930000005): TOTAL, not partial (PostgREST sends ON CONFLICT
--    without a predicate: 42P10), NULLs never collide, and existing
--    duplicates (an install that ran #15, whose reschedule rewrote the uid in
--    place) are unlinked with a WARNING instead of failing db push.
--
-- 2. claim_calcom_slot() — schedule_calcom claims (workspace, contact,
--    instant) in `appointments` BEFORE calling Cal.com, backed by
--    idx_appointments_calcom_slot_claim (20261003000002). The claim's
--    meta.calcom_claim says how far its call got:
--      'pending'  claimed, nothing sent to Cal.com yet;
--      'sending'  marked right before the POST: it may have booked;
--      'unknown'  the POST got no answer: it may have booked;
--      'booked_without_uid' / 'series'  Cal.com booked (it IS a booking);
--      none       a claim #15 left: it may have booked.
--    Only a 'pending' claim older than p_ttl_seconds is expired here (status
--    'cancelled', meta.calcom_claim 'expired') and replaced in the same call:
--    its call died before sending anything. Any other holder is returned as
--    is, with its age and the attendee email it was sent with: schedule_calcom
--    asks Cal.com whether that booking exists before freeing the slot, or
--    hands the conversation to a person.
--
-- lock_timeout: the LOCK below waits at most 10 s for writers in flight
-- instead of queueing every new write behind it; if it can't get the lock,
-- db push fails and can simply be run again.
-- ============================================================================

SET lock_timeout = '10s';

DO $$
DECLARE
  v_unlinked UUID[];
BEGIN
  LOCK TABLE public.appointments IN SHARE ROW EXCLUSIVE MODE;

  WITH ranked AS (
    SELECT id,
           row_number() OVER (
             PARTITION BY workspace_id, calcom_booking_uid
             ORDER BY (status IN ('booked', 'confirmed')) DESC,
                      updated_at DESC, created_at DESC, id
           ) AS rn
      FROM public.appointments
     WHERE calcom_booking_uid IS NOT NULL
  ), unlinked AS (
    UPDATE public.appointments a
       SET calcom_booking_uid = NULL,
           status = CASE WHEN a.calcom_event_type_id IS NOT NULL THEN 'cancelled' ELSE a.status END
      FROM ranked r
     WHERE a.id = r.id AND r.rn > 1
    RETURNING a.id
  )
  SELECT array_agg(id) INTO v_unlinked FROM unlinked;

  IF v_unlinked IS NOT NULL THEN
    RAISE WARNING
      'appointments: % appointment(s) shared a Cal.com booking uid with another of their workspace; only one keeps it (a live one first, then the one touched most recently). Unlinked (up to 20): %',
      cardinality(v_unlinked), v_unlinked[1:20];
  END IF;

  CREATE UNIQUE INDEX IF NOT EXISTS uq_appointments_workspace_calcom_booking_uid
    ON public.appointments (workspace_id, calcom_booking_uid);
END $$;

COMMENT ON INDEX public.uq_appointments_workspace_calcom_booking_uid IS
  'Un registro local por reserva de Cal.com y workspace (caché de Cal.com). Total, no parcial: PostgREST no manda el predicado del ON CONFLICT.';

CREATE OR REPLACE FUNCTION public.claim_calcom_slot(
  p_workspace_id    UUID,
  p_contact_id      UUID,
  p_conversation_id UUID,
  p_scheduled_at    TIMESTAMPTZ,
  p_event_type_id   INT,
  p_ttl_seconds     INT DEFAULT 120
)
RETURNS TABLE (
  claim_id             UUID,
  holder_id            UUID,
  holder_uid           TEXT,
  holder_event_type_id INT,
  holder_claim         TEXT,
  holder_age_seconds   INT,
  holder_email         TEXT
)
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
  -- Never shorter than a tool call (30 s budget), never longer than an hour.
  v_ttl        INTERVAL := make_interval(secs => LEAST(GREATEST(COALESCE(p_ttl_seconds, 120), 60), 3600));
  v_nobody     CONSTANT UUID := '00000000-0000-0000-0000-000000000000';
  v_id         UUID;
  v_constraint TEXT;
  v_holder     RECORD;
  v_round      INT;
BEGIN
  IF p_workspace_id IS NULL OR p_scheduled_at IS NULL OR p_event_type_id IS NULL THEN
    RAISE EXCEPTION 'claim_calcom_slot: workspace, instant and event type are required';
  END IF;

  -- A later round runs after an expired claim was cleared, or after the
  -- holder went away between the INSERT and the SELECT.
  FOR v_round IN 1..3 LOOP
    BEGIN
      INSERT INTO public.appointments
        (workspace_id, contact_id, conversation_id, scheduled_at, status, calcom_event_type_id, meta)
      VALUES
        (p_workspace_id, p_contact_id, p_conversation_id, p_scheduled_at, 'booked', p_event_type_id,
         jsonb_build_object('calcom_claim', 'pending'))
      RETURNING id INTO v_id;
      RETURN QUERY SELECT v_id, NULL::UUID, NULL::TEXT, NULL::INT, NULL::TEXT, NULL::INT, NULL::TEXT;
      RETURN;
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint IS DISTINCT FROM 'idx_appointments_calcom_slot_claim' THEN
        RAISE;
      END IF;
    END;

    -- Who holds it. FOR UPDATE: a concurrent expiry waits for this one.
    SELECT a.id, a.calcom_booking_uid, a.calcom_event_type_id,
           COALESCE(a.meta->>'calcom_claim',
                    CASE WHEN a.calcom_booking_uid IS NULL THEN 'legacy' ELSE 'booked' END) AS claim,
           a.created_at,
           a.meta->>'attendee_email' AS email
      INTO v_holder
      FROM public.appointments a
     WHERE a.workspace_id = p_workspace_id
       AND COALESCE(a.contact_id, v_nobody) = COALESCE(p_contact_id, v_nobody)
       AND a.scheduled_at = p_scheduled_at
       AND a.status IN ('booked', 'confirmed')
       AND a.calcom_event_type_id IS NOT NULL
     LIMIT 1
     FOR UPDATE;
    IF NOT FOUND THEN
      -- The holder went away in the meantime: claim again.
      CONTINUE;
    END IF;

    -- A claim whose call died before sending anything: expire it and claim
    -- again. Nothing else expires on its own (see the header).
    IF v_holder.calcom_booking_uid IS NULL
       AND v_holder.claim = 'pending'
       AND v_holder.created_at < now() - v_ttl THEN
      UPDATE public.appointments a
         SET status = 'cancelled',
             meta = a.meta || jsonb_build_object('calcom_claim', 'expired')
       WHERE a.id = v_holder.id;
      CONTINUE;
    END IF;

    RETURN QUERY SELECT NULL::UUID, v_holder.id, v_holder.calcom_booking_uid,
                        v_holder.calcom_event_type_id, v_holder.claim,
                        GREATEST(0, EXTRACT(EPOCH FROM now() - v_holder.created_at))::INT,
                        v_holder.email;
    RETURN;
  END LOOP;

  RAISE EXCEPTION 'claim_calcom_slot: the slot kept changing hands';
END;
$$;

REVOKE ALL ON FUNCTION public.claim_calcom_slot(UUID, UUID, UUID, TIMESTAMPTZ, INT, INT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_calcom_slot(UUID, UUID, UUID, TIMESTAMPTZ, INT, INT)
  TO service_role;

RESET lock_timeout;

-- ============================================================================
-- End of migration: 20261003000003_calcom_booking_cache
-- ============================================================================
