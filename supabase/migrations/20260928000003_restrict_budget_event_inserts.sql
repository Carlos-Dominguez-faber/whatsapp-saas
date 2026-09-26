-- ============================================================
-- Migration: 20260928000003_restrict_budget_event_inserts
-- Agente WhatsApp — sessions cannot write the events the budget reads
--
-- events_insert (foundation) lets any admin, manager or agent session insert
-- any event type in its workspace. The daily LLM budget sums llm_usage,
-- template_generate and agent_test_chat rows, and cost_alert, cost_cut and
-- model_outside_catalog are emitted once per day, so a session could fill
-- the budget with fake usage (cutting the agent off) or pre-empt those alerts.
--
-- Only the server writes those types, with the service role (which bypasses
-- RLS). Sessions keep inserting every other type as before.
-- ============================================================

DROP POLICY IF EXISTS "events_insert" ON public.events;

CREATE POLICY "events_insert" ON public.events
  FOR INSERT
  WITH CHECK (
    workspace_id IN (SELECT public.auth_workspace_ids())
    AND public.auth_has_role(workspace_id, ARRAY['admin','manager','agent']::public.workspace_role[])
    AND type NOT IN (
      'llm_usage', 'template_generate', 'agent_test_chat',
      'cost_alert', 'cost_cut', 'model_outside_catalog'
    )
  );

-- ============================================================
-- End of migration: 20260928000003_restrict_budget_event_inserts
-- ============================================================
