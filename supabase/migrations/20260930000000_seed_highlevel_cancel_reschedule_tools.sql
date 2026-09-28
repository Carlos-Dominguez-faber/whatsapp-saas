-- ============================================================
-- Migration: 20260930000000_seed_highlevel_cancel_reschedule_tools
-- Agente WhatsApp — seed the HighLevel cancel/reschedule/list tools
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
-- Idempotent via ON CONFLICT, matching the original tools seed. Installs that
-- already ran #14's own seed (20260906000002, on provider/kapso) get the
-- descriptions and schema updated to the confirmed-date arguments.
-- ============================================================

INSERT INTO public.tools (key, name, description, schema, sensitivity) VALUES
  ('cancel_highlevel', 'Cancelar cita en HighLevel',
   'Cancels the contact''s HighLevel appointment at the date and time the customer confirmed',
   '{"type":"object","properties":{"appointment_datetime_iso":{"type":"string"}},"required":["appointment_datetime_iso"]}',
   'write'),
  ('reschedule_highlevel', 'Reagendar cita en HighLevel',
   'Moves the contact''s HighLevel appointment from the confirmed date and time to a new one',
   '{"type":"object","properties":{"appointment_datetime_iso":{"type":"string"},"new_datetime_iso":{"type":"string"}},"required":["appointment_datetime_iso","new_datetime_iso"]}',
   'write'),
  ('list_highlevel_appointments', 'Ver citas en HighLevel',
   'Lists the conversation contact''s upcoming HighLevel appointments with their exact date and time',
   '{"type":"object","properties":{}}',
   'read')
ON CONFLICT (key) DO UPDATE
  SET name = EXCLUDED.name,
      description = EXCLUDED.description,
      schema = EXCLUDED.schema,
      sensitivity = EXCLUDED.sensitivity;

-- ============================================================
-- End of migration: 20260930000000_seed_highlevel_cancel_reschedule_tools
-- ============================================================
