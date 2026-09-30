-- ============================================================
-- Migration: 20261002000005_automation_history_purge
-- Agente WhatsApp — automation history is kept 30 days
--
-- Every inbound message with a keyword rule on, every handoff and every
-- reminder leaves an automation_events row and, per matching rule, an
-- automation_runs row. Nothing deleted them, so both tables grew forever.
--
-- purge_automation_history() deletes what nothing needs any more:
--   * FINISHED runs (done, failed, skipped) older than the retention;
--   * events older than the retention with no run left (a pending run keeps
--     its event).
-- It never touches a pending or processing run. What still reads history:
-- the cooldown and the daily template cap look back 24 h, the rules' health
-- 24 h plus the last outcome, and the reminder scan only emits for
-- appointments still ahead (at most 168 h after the event it would find), so
-- nothing can fire twice once its event is gone. The retention has an 8-day
-- floor to keep that true whatever a caller passes.
--
-- It deletes at most p_batch rows of each table per call, and a pg_cron job
-- (no URL or secret, so it is scheduled right here) calls it every hour:
-- a backlog drains over a few hours without long locks.
-- ============================================================

CREATE OR REPLACE FUNCTION public.purge_automation_history(
  p_retention INTERVAL DEFAULT INTERVAL '30 days',
  p_batch INT DEFAULT 5000
)
RETURNS TABLE (runs_deleted INT, events_deleted INT)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_cutoff TIMESTAMPTZ := now() - GREATEST(COALESCE(p_retention, INTERVAL '30 days'), INTERVAL '8 days');
  v_batch  INT := LEAST(GREATEST(COALESCE(p_batch, 5000), 1), 50000);
  v_runs   INT;
  v_events INT;
BEGIN
  WITH doomed AS (
    SELECT r.id
      FROM public.automation_runs r
     WHERE r.status IN ('done', 'failed', 'skipped')
       AND COALESCE(r.finished_at, r.created_at) < v_cutoff
     LIMIT v_batch
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.automation_runs r
   USING doomed d
   WHERE r.id = d.id;
  GET DIAGNOSTICS v_runs = ROW_COUNT;

  WITH doomed AS (
    SELECT e.id
      FROM public.automation_events e
     WHERE e.occurred_at < v_cutoff
       AND NOT EXISTS (SELECT 1 FROM public.automation_runs r WHERE r.event_id = e.id)
     LIMIT v_batch
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.automation_events e
   USING doomed d
   WHERE e.id = d.id;
  GET DIAGNOSTICS v_events = ROW_COUNT;

  RETURN QUERY SELECT v_runs, v_events;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_automation_history(INTERVAL, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_automation_history(INTERVAL, INT) TO service_role;

-- Hourly, at minute 17 (away from the minute-0 crowd). cron.schedule() with an
-- existing name updates that job, so this is idempotent. pg_cron comes from
-- 20260615000003_enable_pg_cron_pg_net.
SELECT cron.schedule(
  'automation-history-purge',
  '17 * * * *',
  $job$SELECT public.purge_automation_history()$job$
);

-- ============================================================
-- End of migration: 20261002000005_automation_history_purge
-- ============================================================
