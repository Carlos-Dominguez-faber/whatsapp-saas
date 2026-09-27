-- ============================================================
-- Migration: 20260930000003_restrict_server_event_inserts
-- Agente WhatsApp — sessions cannot write the events the server audits,
-- dedupes or caps on
--
-- 20260928000003 kept sessions from inserting the budget events. The same
-- applies to every event type the server reads back to decide something, or
-- keeps as an audit trail — a session inserting one could:
--   - fake an audit entry (member_password_reset, n8n_tool_config_change);
--   - silence the contact's handoff acknowledgement (handoff_ack_sent,
--     deduped for 15 minutes) or the team's email (handoff_team_notified,
--     deduped and capped per hour; handoff_team_notify_capped, once a day);
--   - use up the daily JEV quota (jev_judgment is counted);
--   - pre-empt a once-a-day alert (hl_contact_link_conflict,
--     inbound_destination_mismatch, inbound_destination_unchecked,
--     phone_number_without_country_code, n8n_tool_name_collision).
--
-- Only the server writes those, with the service role (which bypasses RLS).
-- Sessions keep inserting every other type as before. Idempotent.
-- ============================================================

DROP POLICY IF EXISTS "events_insert" ON public.events;

CREATE POLICY "events_insert" ON public.events
  FOR INSERT
  WITH CHECK (
    workspace_id IN (SELECT public.auth_workspace_ids())
    AND public.auth_has_role(workspace_id, ARRAY['admin','manager','agent']::public.workspace_role[])
    AND type NOT IN (
      -- 20260928000003: the LLM budget
      'llm_usage', 'template_generate', 'agent_test_chat',
      'cost_alert', 'cost_cut', 'model_outside_catalog',
      -- audit trail
      'member_password_reset', 'n8n_tool_config_change',
      -- dedupes and caps
      'handoff_ack_sent', 'handoff_team_notified', 'handoff_team_notify_capped',
      'jev_judgment',
      -- once-a-day alerts
      'hl_contact_link_conflict', 'inbound_destination_mismatch',
      'inbound_destination_unchecked', 'phone_number_without_country_code',
      'n8n_tool_name_collision'
    )
  );

-- ============================================================
-- End of migration: 20260930000003_restrict_server_event_inserts
-- ============================================================
