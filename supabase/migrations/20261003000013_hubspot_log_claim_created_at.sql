-- ============================================================================
-- Migration: 20261003000013_hubspot_log_claim_created_at
-- The HubSpot timeline entry is dated when the handoff or close happened.
--
-- The entry took hs_timestamp and its transcript from the moment the queue
-- processed it: minutes later normally, hours after an outage or a parked
-- token, with messages written after the handoff mixed in. The claim now
-- returns the log's created_at (when the transition was queued): the entry
-- is dated then and its transcript stops there. DROP + CREATE: the return
-- type changes.
-- ============================================================================

SET lock_timeout = '10s';

DROP FUNCTION IF EXISTS public.claim_hubspot_conversation_log(INT);
CREATE FUNCTION public.claim_hubspot_conversation_log(p_lease_seconds INT DEFAULT 120)
RETURNS TABLE (id UUID, workspace_id UUID, conversation_id UUID, reason TEXT, attempts INT, created_at TIMESTAMPTZ)
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_id UUID;
  v_lease INTERVAL := make_interval(secs => LEAST(GREATEST(COALESCE(p_lease_seconds, 120), 30), 600));
BEGIN
  SELECT l.id INTO v_id
    FROM public.hubspot_conversation_logs l
   WHERE l.status = 'pending'
     AND (l.claimed_until IS NULL OR l.claimed_until < now())
   ORDER BY l.created_at
   LIMIT 1
   FOR UPDATE SKIP LOCKED;
  IF v_id IS NULL THEN
    RETURN;
  END IF;

  -- FIFO global, sin round-robin por workspace; con el volumen de traspasos no hay
  -- acaparamiento real. Si aparece, copiar el round-robin de claim_next_automation_run.
  RETURN QUERY
  UPDATE public.hubspot_conversation_logs l
     SET claimed_until = now() + v_lease,
         attempts = l.attempts + 1,
         updated_at = now()
   WHERE l.id = v_id
  RETURNING l.id, l.workspace_id, l.conversation_id, l.reason, l.attempts, l.created_at;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_hubspot_conversation_log(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_hubspot_conversation_log(INT) TO service_role;

RESET lock_timeout;

-- ============================================================================
-- End of migration: 20261003000013_hubspot_log_claim_created_at
-- ============================================================================
