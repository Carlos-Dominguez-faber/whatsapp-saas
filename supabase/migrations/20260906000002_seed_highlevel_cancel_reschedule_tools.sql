-- ============================================================
-- Migration: 20260906000002_seed_highlevel_cancel_reschedule_tools
-- Agente WhatsApp — seed the HighLevel cancel/reschedule tools
--
-- Same reasoning as 20260617000001_seed_check_availability_tool:
-- cancel_highlevel and reschedule_highlevel are implemented and registered in
-- code (src/features/tools/index.ts), but getEnabledTools() only returns
-- registry tools that have an enabled tool_configs row backed by a
-- public.tools catalog entry. Seed them so they show in Settings and can be
-- enabled per workspace.
--
-- The schema column is for catalog/display only — the agent builds the LLM
-- tool schema from the code zod definition.
-- Idempotent via ON CONFLICT, matching the original tools seed.
-- ============================================================

INSERT INTO public.tools (key, name, description, schema, sensitivity) VALUES
  ('cancel_highlevel', 'Cancelar cita en HighLevel',
   'Cancels the contact''s next active appointment in HighLevel',
   '{"type":"object","properties":{}}',
   'write'),
  ('reschedule_highlevel', 'Reagendar cita en HighLevel',
   'Reschedules the contact''s next active HighLevel appointment to a new time',
   '{"type":"object","properties":{"new_datetime_iso":{"type":"string"}},"required":["new_datetime_iso"]}',
   'write')
ON CONFLICT (key) DO UPDATE
  SET name = EXCLUDED.name,
      description = EXCLUDED.description,
      schema = EXCLUDED.schema,
      sensitivity = EXCLUDED.sensitivity;

-- ============================================================
-- End of migration: 20260906000002_seed_highlevel_cancel_reschedule_tools
-- ============================================================
