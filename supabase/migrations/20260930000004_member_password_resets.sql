-- ============================================================
-- Migration: 20260930000004_member_password_resets
-- Agente WhatsApp — append-only audit of the agency's password resets
--
-- A reset changes a person's password in every workspace they belong to, so
-- its record must outlive any one of them: no foreign keys (deleting a
-- workspace or a user leaves the rows), no UPDATE, DELETE or TRUNCATE for
-- anyone (a trigger refuses them even for the service role), and no access at
-- all for sessions. The app writes one 'attempted' row before the reset and
-- one 'done' or 'failed' row after it.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.member_password_resets (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_user_id           UUID NOT NULL,
  target_user_id          UUID NOT NULL,
  -- The workspace the reset was made from, and every workspace where the
  -- person was active at that moment (the password applies to all of them).
  workspace_id            UUID NOT NULL,
  affected_workspace_ids  UUID[] NOT NULL DEFAULT '{}',
  outcome                 TEXT NOT NULL CHECK (outcome IN ('attempted', 'done', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_member_password_resets_target
  ON public.member_password_resets (target_user_id, created_at DESC);

ALTER TABLE public.member_password_resets ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.refuse_audit_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'audit rows are append-only (%)', TG_TABLE_NAME
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_member_password_resets_append_only ON public.member_password_resets;
CREATE TRIGGER trg_member_password_resets_append_only
  BEFORE UPDATE OR DELETE ON public.member_password_resets
  FOR EACH ROW EXECUTE FUNCTION public.refuse_audit_change();

DROP TRIGGER IF EXISTS trg_member_password_resets_no_truncate ON public.member_password_resets;
CREATE TRIGGER trg_member_password_resets_no_truncate
  BEFORE TRUNCATE ON public.member_password_resets
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_audit_change();

REVOKE ALL ON public.member_password_resets FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.member_password_resets TO service_role;
REVOKE ALL ON FUNCTION public.refuse_audit_change() FROM PUBLIC, anon, authenticated;

-- ============================================================
-- End of migration: 20260930000004_member_password_resets
-- ============================================================
