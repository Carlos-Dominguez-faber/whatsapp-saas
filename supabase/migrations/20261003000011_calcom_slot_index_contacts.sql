-- ============================================================================
-- Migration: 20261003000011_calcom_slot_index_contacts
-- Deleting contacts never trips the Cal.com slot index.
--
-- idx_appointments_calcom_slot_claim (20261003000002) is unique on
-- (workspace_id, COALESCE(contact_id, <nobody>), scheduled_at): a contactless
-- (playground) claim collides with another one at the same instant. But
-- appointments.contact_id is ON DELETE SET NULL, so deleting two contacts
-- with live Cal.com bookings at the same time turned both rows into
-- <nobody> at that instant and the DELETE failed with 23505 (and a single
-- orphaned row took the playground's place at that time).
--
-- Two parts, because each covers what the other can't:
--   1. The index leaves out rows with no contact that are linked to a
--      booking: (contact_id IS NOT NULL OR calcom_booking_uid IS NULL). A
--      deleted contact's linked bookings stay as history, outside the slot
--      index; a contactless claim (no uid yet) still collides as before.
--   2. BEFORE DELETE on contacts: the contact's Cal.com claims that never got
--      a uid are closed (status 'cancelled', meta.calcom_claim
--      'contact_deleted'). With no contact they can't be resolved, reminded or
--      handed to anyone; left open, two of them at one instant would still
--      collide once their contact_id went NULL. A booking one of them may have
--      made stays in Cal.com.
-- A predicate alone leaves that last case; a trigger alone would have to
-- rewrite the linked bookings too. claim_calcom_slot()'s holder lookup uses
-- the same predicate as the index.
-- ============================================================================

SET lock_timeout = '10s';

CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_calcom_slot_claim_v2
  ON public.appointments (
    workspace_id,
    COALESCE(contact_id, '00000000-0000-0000-0000-000000000000'::uuid),
    scheduled_at
  )
  WHERE status IN ('booked', 'confirmed')
    AND calcom_event_type_id IS NOT NULL
    AND (contact_id IS NOT NULL OR calcom_booking_uid IS NULL);
DROP INDEX IF EXISTS public.idx_appointments_calcom_slot_claim;
ALTER INDEX public.idx_appointments_calcom_slot_claim_v2 RENAME TO idx_appointments_calcom_slot_claim;

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
           COALESCE(a.meta->>'calcom_claim', 'legacy') AS claim, a.created_at,
           a.meta->>'attendee_email' AS email
      INTO v_holder
      FROM public.appointments a
     WHERE a.workspace_id = p_workspace_id
       AND COALESCE(a.contact_id, v_nobody) = COALESCE(p_contact_id, v_nobody)
       AND a.scheduled_at = p_scheduled_at
       AND a.status IN ('booked', 'confirmed')
       AND a.calcom_event_type_id IS NOT NULL
       -- The index's own predicate (20261003000011).
       AND (a.contact_id IS NOT NULL OR a.calcom_booking_uid IS NULL)
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

-- SECURITY DEFINER: an admin or manager deleting a contact through their
-- session may not be allowed to update appointments under RLS, and a claim
-- left open would still collide.
CREATE OR REPLACE FUNCTION public.close_calcom_claims_of_deleted_contact()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.appointments a
     SET status = 'cancelled',
         meta = a.meta || jsonb_build_object('calcom_claim', 'contact_deleted')
   WHERE a.contact_id = OLD.id
     AND a.workspace_id = OLD.workspace_id
     AND a.calcom_event_type_id IS NOT NULL
     AND a.calcom_booking_uid IS NULL
     AND a.status IN ('booked', 'confirmed');
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_contacts_close_calcom_claims ON public.contacts;
CREATE TRIGGER trg_contacts_close_calcom_claims
  BEFORE DELETE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.close_calcom_claims_of_deleted_contact();

REVOKE ALL ON FUNCTION public.close_calcom_claims_of_deleted_contact() FROM PUBLIC, anon, authenticated;

RESET lock_timeout;

-- ============================================================================
-- End of migration: 20261003000011_calcom_slot_index_contacts
-- ============================================================================
