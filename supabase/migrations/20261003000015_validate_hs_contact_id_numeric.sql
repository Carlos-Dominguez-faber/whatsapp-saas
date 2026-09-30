-- ============================================================================
-- Migration: 20261003000015_validate_hs_contact_id_numeric
-- Validates contacts_hs_contact_id_numeric (added NOT VALID in
-- 20261003000010), in its own file: db push runs each migration in one
-- transaction, and VALIDATE CONSTRAINT only takes SHARE UPDATE EXCLUSIVE on
-- contacts while it scans (writes go on). 20261003000010 already cleared any
-- value that would fail it.
-- ============================================================================

SET lock_timeout = '10s';

ALTER TABLE public.contacts VALIDATE CONSTRAINT contacts_hs_contact_id_numeric;

RESET lock_timeout;

-- ============================================================================
-- End of migration: 20261003000015_validate_hs_contact_id_numeric
-- ============================================================================
