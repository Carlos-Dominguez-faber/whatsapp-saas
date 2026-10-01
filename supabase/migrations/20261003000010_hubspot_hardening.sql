-- ============================================================================
-- Migration: 20261003000010_hubspot_hardening
-- HubSpot: numeric contact ids only, and a purge for the conversation-log queue.
--
-- 1. contacts.hs_contact_id is interpolated into HubSpot URL paths
--    (/crm/objects/.../contacts/{id}). HubSpot's ids are digits; the CHECK
--    keeps anything else out of the column, whoever writes it. An install
--    that ran #17 may hold a non-numeric value: it is unlinked (set to NULL,
--    the next push resolves the contact again by whatsapp_phone) with a
--    WARNING, instead of making the constraint fail db push.
--
-- 2. hubspot_conversation_logs only grows: every handoff and close of a
--    HubSpot workspace adds a row. purge_hubspot_conversation_logs() deletes
--    finished rows (done, failed, cancelled) older than p_keep_days, at most
--    p_limit per call; the queue's cron phase calls it once per tick. The
--    partial index keeps that DELETE off the pending rows. Service role only.
--
-- The CHECK is added NOT VALID (enforced for every new write at once, with
-- only a brief lock) and validated by its own migration,
-- 20261003000015_validate_hs_contact_id_numeric: db push runs each file in
-- one transaction, so a VALIDATE here would hold this file's locks while it
-- scans contacts. lock_timeout keeps a busy table from queueing every write
-- behind this migration.
-- ============================================================================

SET lock_timeout = '10s';

DO $$
DECLARE
  v_cleared UUID[];
BEGIN
  WITH cleared AS (
    UPDATE public.contacts c
       SET hs_contact_id = NULL
     WHERE c.hs_contact_id IS NOT NULL
       AND c.hs_contact_id !~ '^[0-9]{1,20}$'
    RETURNING c.id
  )
  SELECT array_agg(id) INTO v_cleared FROM cleared;
  IF v_cleared IS NOT NULL THEN
    RAISE WARNING
      'contacts: % HubSpot link(s) were not a HubSpot id and were cleared; the next sync links them again. Contacts (up to 20): %',
      cardinality(v_cleared), v_cleared[1:20];
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'contacts_hs_contact_id_numeric'
       AND conrelid = 'public.contacts'::regclass
  ) THEN
    ALTER TABLE public.contacts
      ADD CONSTRAINT contacts_hs_contact_id_numeric
      CHECK (hs_contact_id IS NULL OR hs_contact_id ~ '^[0-9]{1,20}$') NOT VALID;
  END IF;
END $$;


CREATE INDEX IF NOT EXISTS idx_hubspot_conversation_logs_finished
  ON public.hubspot_conversation_logs (updated_at)
  WHERE status IN ('done', 'failed', 'cancelled');

CREATE OR REPLACE FUNCTION public.purge_hubspot_conversation_logs(
  p_keep_days INT DEFAULT 30,
  p_limit     INT DEFAULT 1000
)
RETURNS INT
LANGUAGE sql
VOLATILE
SET search_path = ''
AS $$
  WITH doomed AS (
    SELECT l.id
      FROM public.hubspot_conversation_logs l
     WHERE l.status IN ('done', 'failed', 'cancelled')
       AND l.updated_at < now() - make_interval(days => GREATEST(COALESCE(p_keep_days, 30), 1))
     ORDER BY l.updated_at
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 10000)
     FOR UPDATE SKIP LOCKED
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
-- End of migration: 20261003000010_hubspot_hardening
-- ============================================================================
