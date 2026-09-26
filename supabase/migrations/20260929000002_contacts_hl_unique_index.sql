-- ============================================================================
-- Migration: 20260929000002_contacts_hl_unique_index
-- One local contact per HighLevel contact, per workspace.
--
-- The HighLevel contact webhook synced into `contacts` with an upsert on
-- (workspace_id, hl_contact_id), but no unique index backed that pair, so
-- Postgres refused the ON CONFLICT (42P10) and no HighLevel contact ever
-- reached the database through that path. syncContactFromHL no longer relies
-- on the upsert; this index keeps two local contacts from claiming the same
-- HighLevel contact.
--
-- Existing duplicates would make CREATE UNIQUE INDEX fail and stop db push.
-- Instead, in each duplicated (workspace_id, hl_contact_id) group the most
-- recently updated contact keeps the link and the others are unlinked
-- (hl_contact_id → NULL); nothing else about them changes. A WARNING says how
-- many. The index is total, not partial: NULLs never collide in a unique
-- index, and a partial one could not back an ON CONFLICT from PostgREST.
--
-- Idempotent over installs that applied #9's 20260906000000 (same index name).
-- Without CONCURRENTLY: it can't run inside a migration's transaction.
-- ============================================================================

DO $$
DECLARE
  v_unlinked INT;
BEGIN
  WITH ranked AS (
    SELECT id,
           row_number() OVER (
             PARTITION BY workspace_id, hl_contact_id
             ORDER BY updated_at DESC NULLS LAST, created_at DESC, id
           ) AS rn
      FROM public.contacts
     WHERE hl_contact_id IS NOT NULL
  )
  UPDATE public.contacts c
     SET hl_contact_id = NULL
    FROM ranked r
   WHERE c.id = r.id AND r.rn > 1;

  GET DIAGNOSTICS v_unlinked = ROW_COUNT;
  IF v_unlinked > 0 THEN
    RAISE WARNING
      'contacts: % contact(s) shared a HighLevel id with another contact of their workspace; only the most recently updated one keeps the link.',
      v_unlinked;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_contacts_workspace_hl_contact_id
  ON public.contacts (workspace_id, hl_contact_id);

-- ============================================================================
-- End of migration: 20260929000002_contacts_hl_unique_index
-- ============================================================================
