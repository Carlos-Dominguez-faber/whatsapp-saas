-- ============================================================================
-- Migration: 20261003000017_stale_calcom_claims
-- The Cal.com claim sweep's lookup, as one service-role function.
--
-- stale_calcom_claims() returns the claims that may have booked and that
-- nobody is asking about: no booking uid, marked 'sending' or 'unknown' (or a
-- #15 claim with no marker), older than p_older_than_seconds, not yet swept.
-- Its WHERE carries idx_appointments_calcom_slot_claim's own predicate
-- (live, a Cal.com event type, not a deleted contact's row), so the planner
-- can read that partial index instead of scanning appointments. A function
-- (not a PostgREST query) because the index predicate uses jsonb `?`, which
-- PostgREST filters can't express.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.stale_calcom_claims(
  p_older_than_seconds INT DEFAULT 600,
  p_limit              INT DEFAULT 20
)
RETURNS TABLE (
  id                   UUID,
  workspace_id         UUID,
  conversation_id      UUID,
  scheduled_at         TIMESTAMPTZ,
  calcom_event_type_id INT,
  meta                 JSONB
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT a.id, a.workspace_id, a.conversation_id, a.scheduled_at, a.calcom_event_type_id, a.meta
    FROM public.appointments a
   WHERE a.status IN ('booked', 'confirmed')
     AND a.calcom_event_type_id IS NOT NULL
     AND NOT (a.meta ? 'contact_deleted_from')
     AND a.calcom_booking_uid IS NULL
     AND (a.meta->>'calcom_claim' IN ('sending', 'unknown') OR NOT (a.meta ? 'calcom_claim'))
     AND NOT (a.meta ? 'calcom_swept')
     AND a.created_at < now() - make_interval(secs => GREATEST(COALESCE(p_older_than_seconds, 600), 60))
   ORDER BY a.created_at
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 200);
$$;

REVOKE ALL ON FUNCTION public.stale_calcom_claims(INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stale_calcom_claims(INT, INT) TO service_role;

-- ============================================================================
-- End of migration: 20261003000017_stale_calcom_claims
-- ============================================================================
