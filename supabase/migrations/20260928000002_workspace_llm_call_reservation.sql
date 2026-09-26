-- ============================================================
-- Migration: 20260928000002_workspace_llm_call_reservation
-- Agente WhatsApp — hourly cap for the LLM tools managers use
--
-- Template drafting (templates/generate) and the agent playground
-- (agents/[id]/test-chat) call the model on the workspace's OpenRouter key
-- (or the agency's, when the workspace has none) with no per-call limit.
--
-- reserve_workspace_llm_call() counts this workspace's calls of one kind in
-- the last hour and, when under the limit, inserts the event row that the
-- route later fills with real token counts — both inside one call,
-- serialized per (workspace, kind) with a transaction-scoped advisory lock,
-- the same way reserve_llm_turn() reserves an agent turn. Those rows also
-- feed sum_daily_llm_tokens(), so the daily budget covers them.
-- ============================================================

CREATE OR REPLACE FUNCTION public.reserve_workspace_llm_call(
  p_workspace_id UUID,
  p_type TEXT,
  p_hourly_limit INT
)
RETURNS TABLE(allowed BOOLEAN, reservation_id UUID)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INT;
  v_id UUID;
BEGIN
  IF p_type NOT IN ('template_generate', 'agent_test_chat') THEN
    RAISE EXCEPTION 'reserve_workspace_llm_call: unsupported type %', p_type
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_workspace_id::text || ':' || p_type, 0)
  );

  SELECT count(*) INTO v_count
  FROM public.events
  WHERE type = p_type
    AND workspace_id = p_workspace_id
    AND created_at >= now() - INTERVAL '1 hour';

  IF v_count >= p_hourly_limit THEN
    RETURN QUERY SELECT false, NULL::UUID;
    RETURN;
  END IF;

  INSERT INTO public.events (type, level, workspace_id, payload)
  VALUES (
    p_type,
    'info',
    p_workspace_id,
    jsonb_build_object('total_tokens', 0, 'reserved', true)
  )
  RETURNING id INTO v_id;

  RETURN QUERY SELECT true, v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_workspace_llm_call(uuid, text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_workspace_llm_call(uuid, text, int) TO service_role;

-- ============================================================
-- End of migration: 20260928000002_workspace_llm_call_reservation
-- ============================================================
