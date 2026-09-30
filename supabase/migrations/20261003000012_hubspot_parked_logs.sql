-- ============================================================================
-- Migration: 20261003000012_hubspot_parked_logs
-- HubSpot timeline entries wait out a token problem instead of being lost.
--
-- A revoked token, a missing scope or a connection not yet tested
-- ('unauthorized', 'missing_scope', 'properties_not_ready') closed the log as
-- 'failed' (or after 5 tries): every handoff and close in the meantime was
-- lost, though the fix is one click. Now:
--   1. status 'parked': the queue parks those logs (the claim only takes
--      'pending', so they wait at no cost).
--   2. mark_hubspot_ready() — "Probar conexión" passed — puts the parked logs
--      back to 'pending' (attempts from 0) when the portal is the same; with
--      another portal, parked and pending logs are cancelled as before (the
--      contacts they'd link belong to the old account). It returns how many
--      went back (logs_requeued): DROP + CREATE, the return type changes.
--   3. The purge keeps parked logs three times as long as finished ones.
-- ============================================================================

SET lock_timeout = '10s';

ALTER TABLE public.hubspot_conversation_logs
  DROP CONSTRAINT IF EXISTS hubspot_conversation_logs_status_check;
ALTER TABLE public.hubspot_conversation_logs
  ADD CONSTRAINT hubspot_conversation_logs_status_check
  CHECK (status IN ('pending', 'done', 'failed', 'cancelled', 'parked'));

DROP FUNCTION IF EXISTS public.mark_hubspot_ready(UUID, TEXT, TEXT);
CREATE FUNCTION public.mark_hubspot_ready(
  p_workspace_id UUID,
  p_token_fingerprint TEXT,
  p_portal_id TEXT
)
RETURNS TABLE (updated BOOLEAN, portal_changed BOOLEAN, links_cleared INT, logs_cancelled INT, logs_requeued INT)
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
  v_old_portal TEXT;
  v_links INT := 0;
  v_logs INT := 0;
  v_requeued INT := 0;
  v_changed BOOLEAN;
BEGIN
  SELECT i.config->>'portal_id' INTO v_old_portal
    FROM public.integrations i
   WHERE i.workspace_id = p_workspace_id
     AND i.provider = 'hubspot'
     AND i.config->>'token_fingerprint' = p_token_fingerprint
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, false, 0, 0, 0;
    RETURN;
  END IF;

  v_changed := v_old_portal IS NOT NULL AND v_old_portal <> p_portal_id;
  IF v_changed THEN
    UPDATE public.contacts c
       SET hs_contact_id = NULL, updated_at = now()
     WHERE c.workspace_id = p_workspace_id AND c.hs_contact_id IS NOT NULL;
    GET DIAGNOSTICS v_links = ROW_COUNT;

    UPDATE public.hubspot_conversation_logs l
       SET status = 'cancelled', last_error = 'portal_changed', claimed_until = NULL, updated_at = now()
     WHERE l.workspace_id = p_workspace_id AND l.status IN ('pending', 'parked');
    GET DIAGNOSTICS v_logs = ROW_COUNT;
  ELSE
    UPDATE public.hubspot_conversation_logs l
       SET status = 'pending', attempts = 0, last_error = NULL, claimed_until = NULL, updated_at = now()
     WHERE l.workspace_id = p_workspace_id AND l.status = 'parked';
    GET DIAGNOSTICS v_requeued = ROW_COUNT;
  END IF;

  UPDATE public.integrations i
     SET config = i.config || jsonb_build_object('properties_ready', true, 'portal_id', p_portal_id),
         updated_at = now()
   WHERE i.workspace_id = p_workspace_id AND i.provider = 'hubspot';

  RETURN QUERY SELECT true, v_changed, v_links, v_logs, v_requeued;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_hubspot_ready(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_hubspot_ready(UUID, TEXT, TEXT) TO service_role;

DROP INDEX IF EXISTS public.idx_hubspot_conversation_logs_finished;
CREATE INDEX idx_hubspot_conversation_logs_finished
  ON public.hubspot_conversation_logs (updated_at)
  WHERE status IN ('done', 'failed', 'cancelled', 'parked');

CREATE OR REPLACE FUNCTION public.purge_hubspot_conversation_logs(
  p_keep_days INT DEFAULT 30,
  p_limit     INT DEFAULT 1000
)
RETURNS INT
LANGUAGE sql
VOLATILE
SET search_path = ''
AS $$
  WITH keep AS (
    SELECT GREATEST(COALESCE(p_keep_days, 30), 1) AS days
  ), doomed AS (
    SELECT l.id
      FROM public.hubspot_conversation_logs l, keep
     WHERE (l.status IN ('done', 'failed', 'cancelled')
            AND l.updated_at < now() - make_interval(days => keep.days))
        -- Parked logs wait for someone to fix the token: three times longer.
        OR (l.status = 'parked'
            AND l.updated_at < now() - make_interval(days => keep.days * 3))
     ORDER BY l.updated_at
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 10000)
     FOR UPDATE OF l SKIP LOCKED
  ), gone AS (
    DELETE FROM public.hubspot_conversation_logs l
     USING doomed
     WHERE l.id = doomed.id
    RETURNING 1
  )
  SELECT count(*)::INT FROM gone;
$$;

REVOKE ALL ON FUNCTION public.purge_hubspot_conversation_logs(INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_hubspot_conversation_logs(INT, INT) TO service_role;

RESET lock_timeout;

-- ============================================================================
-- End of migration: 20261003000012_hubspot_parked_logs
-- ============================================================================
