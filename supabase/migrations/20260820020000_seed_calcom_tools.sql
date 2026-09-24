-- ============================================================
-- Migration: 20260820020000_seed_calcom_tools
-- Agente WhatsApp — seed the 5 Cal.com scheduling tools
--
-- Same reasoning as 20260617000001_seed_check_availability_tool: tools are
-- implemented and registered in code (src/features/tools/index.ts), but
-- getEnabledTools() only returns tools that have a tool_configs row backed
-- by a public.tools catalog entry. Seed them so they show in Settings and
-- can be enabled per workspace.
--
-- The schema column is for catalog/display only — the agent builds the LLM
-- tool schema from the code zod definition.
-- Idempotent via ON CONFLICT, matching the original tools seed.
-- ============================================================

INSERT INTO public.tools (key, name, description, schema, sensitivity) VALUES
  ('list_event_types_calcom', 'Cal.com — Listar tipos de evento',
   'Lists the Cal.com event types (services) available to book',
   '{"type":"object","properties":{}}',
   'read'),
  ('check_availability_calcom', 'Cal.com — Consultar disponibilidad',
   'Checks real free time slots from Cal.com for an event type and date range',
   '{"type":"object","properties":{"event_type_id":{"type":"number"},"date_from":{"type":"string"},"date_to":{"type":"string"}},"required":["event_type_id","date_from","date_to"]}',
   'read'),
  ('schedule_calcom', 'Cal.com — Agendar cita',
   'Books an appointment directly on Cal.com',
   '{"type":"object","properties":{"event_type_id":{"type":"number"},"datetime_iso":{"type":"string"},"attendee_name":{"type":"string"},"attendee_email":{"type":"string"}},"required":["event_type_id","datetime_iso","attendee_name"]}',
   'write'),
  ('cancel_calcom', 'Cal.com — Cancelar cita',
   'Cancels the contact''s active Cal.com appointment',
   '{"type":"object","properties":{}}',
   'write'),
  ('reschedule_calcom', 'Cal.com — Reagendar cita',
   'Reschedules the contact''s active Cal.com appointment to a new time',
   '{"type":"object","properties":{"new_datetime_iso":{"type":"string"}},"required":["new_datetime_iso"]}',
   'write')
ON CONFLICT (key) DO UPDATE
  SET name = EXCLUDED.name,
      description = EXCLUDED.description,
      schema = EXCLUDED.schema,
      sensitivity = EXCLUDED.sensitivity;

-- ============================================================
-- End of migration: 20260820020000_seed_calcom_tools
-- ============================================================
