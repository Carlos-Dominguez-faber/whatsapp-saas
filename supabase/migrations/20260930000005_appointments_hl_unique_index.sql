-- ============================================================================
-- Migration: 20260930000005_appointments_hl_unique_index
-- One local appointment per HighLevel appointment, per workspace.
--
-- The local rows are a cache of HighLevel's appointments: every read of an
-- appointment from HighLevel is written back to its row (an upsert on this
-- pair), creating it for one only HighLevel knew (booked through its link, or
-- by staff). Nothing kept two rows from holding the same HighLevel id.
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
-- Total, not partial: NULLs never collide in a unique index (rows booked
-- without HighLevel carry no id), and a partial one could not back the
-- write-back's ON CONFLICT from PostgREST.
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
    ON public.appointments (workspace_id, hl_appointment_id);
END
$$;

-- ============================================================================
-- End of migration: 20260930000005_appointments_hl_unique_index
-- ============================================================================
