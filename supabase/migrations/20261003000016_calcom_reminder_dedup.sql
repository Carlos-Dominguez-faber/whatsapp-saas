-- ============================================================================
-- Migration: 20261003000016_calcom_reminder_dedup
-- A Cal.com booking moved away and back is not reminded twice.
--
-- Every move in Cal.com creates a new booking, cached as a new appointments
-- row that keeps the original created_at (so its new time is reminded). The
-- reminder scan dedups per (appointment, occurrence), so a booking moved away
-- and then back to a time already reminded was reminded again under the new
-- row. automation_reminder_candidates() now also skips a Cal.com row when
-- this rule emitted the same occurrence (rule, lead, instant) for the same
-- contact under another row and that reminder was sent or is still on its
-- way (not expanded yet, or a run done, pending or processing); a skipped or
-- failed one (it reminded nobody) doesn't block it. HighLevel
-- rows (no calcom_event_type_id) are untouched: they keep one row per
-- appointment. The index backs that lookup.
-- ============================================================================

SET lock_timeout = '10s';

CREATE INDEX IF NOT EXISTS idx_automation_events_reminder_contact
  ON public.automation_events (workspace_id, contact_id, occurrence)
  WHERE event_type = 'appointment_upcoming';

CREATE OR REPLACE FUNCTION public.automation_reminder_candidates(
  p_rule_id UUID,
  p_now     TIMESTAMPTZ DEFAULT NOW(),
  p_limit   INT DEFAULT 50
)
RETURNS TABLE (
  subject_id      UUID,
  occurrence      TEXT,
  contact_id      UUID,
  conversation_id UUID,
  scheduled_at    TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  WITH rule AS (
    SELECT ru.id,
           ru.workspace_id,
           ru.enabled_since,
           trim_scale((ru.trigger_config->>'hours_before')::numeric) AS h
      FROM public.automation_rules ru
     WHERE ru.id = p_rule_id
       AND ru.enabled
       AND ru.trigger_type = 'appointment_upcoming'
       AND (ru.trigger_config->>'hours_before') ~ '^[0-9]+(\.[0-9]+)?$'
  )
  SELECT a.id, o.occurrence, a.contact_id, a.conversation_id, a.scheduled_at
    FROM rule
    JOIN public.appointments a
      ON a.workspace_id = rule.workspace_id
    CROSS JOIN LATERAL (
      SELECT rule.id::text || ':' || rule.h::text || 'h:'
             || to_char(a.scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurrence,
             a.scheduled_at - make_interval(secs => (rule.h * 3600)::double precision) AS due_at
    ) o
   WHERE a.status IN ('booked', 'confirmed')
     AND a.scheduled_at > p_now
     -- The same bound as due_at <= p_now, on the column the index covers.
     AND a.scheduled_at <= p_now + make_interval(secs => (rule.h * 3600)::double precision)
     AND o.due_at <= p_now
     AND a.contact_id IS NOT NULL
     AND a.conversation_id IS NOT NULL
     AND a.created_at <= o.due_at
     -- Due (plus at most a night of quiet hours) before the rule was enabled:
     -- the executor would skip it as late, so it takes no slot.
     AND (rule.enabled_since IS NULL OR o.due_at > rule.enabled_since - INTERVAL '24 hours')
     AND NOT EXISTS (
       SELECT 1 FROM public.automation_events e
        WHERE e.event_type = 'appointment_upcoming'
          AND e.subject_id = a.id
          AND e.occurrence = o.occurrence
     )
     -- A Cal.com booking moved away and back is a new row at a time this
     -- contact was already reminded of by this rule (the occurrence names the
     -- rule, the lead and the instant): not again while another row's
     -- reminder for it was sent or is still on its way (emitted and not
     -- expanded yet, or a run done, pending or processing). One skipped or
     -- failed (say, as moved) reminded nobody, so it doesn't count. HighLevel rows keep one row per appointment and are
     -- untouched.
     AND NOT (
       a.calcom_event_type_id IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM public.automation_events e
          WHERE e.event_type = 'appointment_upcoming'
            AND e.workspace_id = a.workspace_id
            AND e.contact_id = a.contact_id
            AND e.occurrence = o.occurrence
            AND e.subject_id <> a.id
            AND (
              -- Emitted and not expanded yet: on its way.
              NOT EXISTS (SELECT 1 FROM public.automation_runs r WHERE r.event_id = e.id)
              OR EXISTS (
                SELECT 1 FROM public.automation_runs r
                 WHERE r.event_id = e.id
                   AND r.rule_id = rule.id
                   AND r.status IN ('done', 'pending', 'processing')
              )
            )
       )
     )
   ORDER BY o.due_at, a.id
   LIMIT greatest(p_limit, 0);
$$;

RESET lock_timeout;

-- ============================================================================
-- End of migration: 20261003000016_calcom_reminder_dedup
-- ============================================================================
