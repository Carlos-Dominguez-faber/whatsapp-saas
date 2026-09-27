-- ============================================================================
-- Migration: 20260930000005_appointments_hl_unique_index
-- One local appointment per HighLevel appointment, per workspace.
--
-- reschedule_highlevel records a move on the local row of the HighLevel
-- appointment it moved, and creates that row when the appointment was only
-- known to HighLevel (booked through its link, or by staff). Nothing kept two
-- rows from holding the same HighLevel id, and each would then answer for the
-- same appointment with a different time or status.
--
-- Existing duplicates would make CREATE UNIQUE INDEX fail and stop db push.
-- Instead, in each duplicated (workspace_id, hl_appointment_id) group one row
-- keeps the id — a live one (booked, confirmed) before any other, then the one
-- touched most recently — and the others are unlinked (hl_appointment_id →
-- NULL). Their data stays; only updated_at moves, because
-- trg_appointments_updated_at stamps every UPDATE. A WARNING lists how many,
-- with up to 20 of their ids. Lock, dedupe and index run as one statement
-- (the CLI doesn't wrap a migration in a transaction), so the table is locked
-- against writes until the index exists and no new duplicate slips in.
--
-- Partial (WHERE NOT NULL): rows booked without HighLevel carry no id. No
-- ON CONFLICT relies on it; the tool updates, else inserts, else updates on a
-- unique violation.
-- Without CONCURRENTLY: it can't run inside the DO block's transaction.
-- ============================================================================

DO $$
DECLARE
  v_unlinked UUID[];
BEGIN
  LOCK TABLE public.appointments IN SHARE ROW EXCLUSIVE MODE;

  WITH ranked AS (
    SELECT id,
           row_number() OVER (
             PARTITION BY workspace_id, hl_appointment_id
             ORDER BY (status IN ('booked', 'confirmed')) DESC,
                      updated_at DESC, created_at DESC, id
           ) AS rn
      FROM public.appointments
     WHERE hl_appointment_id IS NOT NULL
  ), unlinked AS (
    UPDATE public.appointments a
       SET hl_appointment_id = NULL
      FROM ranked r
     WHERE a.id = r.id AND r.rn > 1
    RETURNING a.id
  )
  SELECT array_agg(id) INTO v_unlinked FROM unlinked;

  IF v_unlinked IS NOT NULL THEN
    RAISE WARNING
      'appointments: % appointment(s) shared a HighLevel id with another of their workspace; only one keeps it (a live one first, then the one touched most recently). Unlinked (up to 20): %',
      cardinality(v_unlinked), v_unlinked[1:20];
  END IF;

  CREATE UNIQUE INDEX IF NOT EXISTS uq_appointments_workspace_hl_appointment_id
    ON public.appointments (workspace_id, hl_appointment_id)
    WHERE hl_appointment_id IS NOT NULL;
END
$$;

-- ============================================================================
-- End of migration: 20260930000005_appointments_hl_unique_index
-- ============================================================================
