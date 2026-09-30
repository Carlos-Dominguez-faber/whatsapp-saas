-- ============================================================
-- Migration: 20261002000003_client_test_chat
-- Agente WhatsApp — budget and hourly caps for the /probar chat
--
-- /probar lets any member of a workspace (a viewer account handed to a client
-- included) chat with the workspace's active agent. It spends the workspace's
-- OpenRouter key like the agent playground does, so it is treated the same:
-- its calls count toward the daily budget and are capped per hour. Two caps,
-- because the account belongs to someone outside the team: one per person,
-- and one for the whole workspace.
--
-- reserve_client_test_chat() counts the last hour and, when under both caps,
-- inserts the event row the route later fills with the real token counts —
-- one call, serialized per workspace with a transaction-scoped advisory lock,
-- the way reserve_workspace_llm_call() does it for the playground.
-- ============================================================

CREATE OR REPLACE FUNCTION public.reserve_client_test_chat(
  p_workspace_id UUID,
  p_user_id UUID,
  p_workspace_hourly_limit INT,
  p_user_hourly_limit INT
)
RETURNS TABLE(allowed BOOLEAN, reason TEXT, reservation_id UUID)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_workspace_calls INT;
  v_user_calls INT;
  v_id UUID;
BEGIN
  IF p_workspace_id IS NULL OR p_user_id IS NULL
     OR p_workspace_hourly_limit IS NULL OR p_user_hourly_limit IS NULL THEN
    RAISE EXCEPTION 'reserve_client_test_chat: missing argument' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_workspace_id::text || ':client_test_chat', 0)
  );

  SELECT count(*),
         count(*) FILTER (WHERE e.payload->>'user_id' = p_user_id::text)
    INTO v_workspace_calls, v_user_calls
    FROM public.events e
   WHERE e.type = 'client_test_chat'
     AND e.workspace_id = p_workspace_id
     AND e.created_at >= now() - INTERVAL '1 hour';

  IF v_user_calls >= p_user_hourly_limit THEN
    RETURN QUERY SELECT false, 'user_hour'::text, NULL::UUID;
    RETURN;
  END IF;
  IF v_workspace_calls >= p_workspace_hourly_limit THEN
    RETURN QUERY SELECT false, 'workspace_hour'::text, NULL::UUID;
    RETURN;
  END IF;

  INSERT INTO public.events (type, level, workspace_id, payload)
  VALUES (
    'client_test_chat',
    'info',
    p_workspace_id,
    jsonb_build_object('total_tokens', 0, 'reserved', true, 'user_id', p_user_id)
  )
  RETURNING id INTO v_id;

  RETURN QUERY SELECT true, NULL::text, v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_client_test_chat(uuid, uuid, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_client_test_chat(uuid, uuid, int, int) TO service_role;

-- The daily budget adds /probar's calls to the ones it already counted.
-- Unchanged otherwise (see 20260928000001_sum_daily_llm_tokens).
CREATE OR REPLACE FUNCTION public.sum_daily_llm_tokens(
  p_workspace_id UUID,
  p_day_start TIMESTAMPTZ
)
RETURNS BIGINT
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT COALESCE(SUM(
    CASE
      -- At most 12 digits: a longer number would overflow bigint and turn
      -- the whole sum into an error, which fails every turn of the workspace.
      WHEN payload->>'total_tokens' ~ '^[0-9]{1,12}$'
      THEN (payload->>'total_tokens')::bigint
      ELSE 0
    END
  ), 0)
  FROM public.events
  -- The agent's turns plus the tools that also spend the workspace's
  -- OpenRouter key: template drafts, the agent playground and /probar. Topic
  -- classification has a budget of its own (reserve_classification_tokens).
  WHERE type IN ('llm_usage', 'template_generate', 'agent_test_chat', 'client_test_chat')
    AND workspace_id = p_workspace_id
    AND created_at >= p_day_start;
$$;

REVOKE ALL ON FUNCTION public.sum_daily_llm_tokens(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sum_daily_llm_tokens(uuid, timestamptz) TO service_role;

-- ============================================================
-- End of migration: 20261002000003_client_test_chat
-- ============================================================
