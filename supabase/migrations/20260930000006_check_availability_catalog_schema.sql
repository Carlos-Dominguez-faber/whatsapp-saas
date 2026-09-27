-- ============================================================================
-- Migration: 20260930000006_check_availability_catalog_schema
-- check_availability no longer takes a time zone from the model.
--
-- Its slots come in the workspace's scheduling zone (the business's, then the
-- HighLevel integration's, then the default), the same one schedule, cancel
-- and reschedule read the copied date in. The catalog's schema is for display
-- only (the agent builds the tool's schema from the code), but it stays
-- accurate. Idempotent.
-- ============================================================================

UPDATE public.tools
   SET schema = schema #- '{properties,timezone}'
 WHERE key = 'check_availability'
   AND schema #> '{properties,timezone}' IS NOT NULL;

-- ============================================================================
-- End of migration: 20260930000006_check_availability_catalog_schema
-- ============================================================================
