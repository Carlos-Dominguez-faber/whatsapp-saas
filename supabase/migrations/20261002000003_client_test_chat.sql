-- ============================================================
-- Migration: 20261002000003_client_test_chat
-- Agente WhatsApp — budget and hourly caps for the /probar chat
--
-- /probar lets any member of a workspace (a viewer account handed to a client
-- included) chat with the workspace's active agent. It spends the workspace's
-- OpenRouter key like the agent playground does, so it is treated the same:
-- its calls count toward the daily budget and are capped per hour. Two hourly caps,
-- because the account belongs to someone outside the team: one per person,
-- and one for the whole workspace.
--
-- reserve_client_test_chat() reserves one call, in one statement serialized
-- per workspace with a transaction-scoped advisory lock (the way
-- reserve_workspace_llm_call() does it for the playground), and refuses it
-- when:
--   * the person or the workspace used up their calls of the last hour;
--   * /probar's own daily budget (p_daily_cap tokens a UTC day, per
--     workspace) can't fit the call's ceiling on top of what it spent and
--     what is still in flight;
--   * the call's ceiling would take the workspace's day (the bot's budget)
--     to p_workspace_limit, the degrade threshold: /probar must never make
--     the bot answer customers with a cheaper model, or stop.
-- The reservation row carries the ceiling as its total_tokens until the
-- route settles it with the real count, so calls in flight count too — N
-- requests at once can't all pass on the same balance.

DROP FUNCTION IF EXISTS public.reserve_client_test_chat(UUID, UUID, INT, INT);

CREATE OR REPLACE FUNCTION public.reserve_client_test_chat(
  p_workspace_id UUID,
  p_user_id UUID,
  p_workspace_hourly_limit INT,
  p_user_hourly_limit INT,
  p_ceiling BIGINT,
  p_daily_cap BIGINT,
  p_workspace_limit BIGINT
)
RETURNS TABLE(allowed BOOLEAN, reason TEXT, reservation_id UUID)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_workspace_calls INT;
  v_user_calls INT;
  v_day_start TIMESTAMPTZ := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_probar_today BIGINT;
  v_id UUID;
BEGIN
  IF p_workspace_id IS NULL OR p_user_id IS NULL
     OR p_workspace_hourly_limit IS NULL OR p_user_hourly_limit IS NULL
     OR p_ceiling IS NULL OR p_ceiling <= 0 OR p_daily_cap IS NULL OR p_workspace_limit IS NULL THEN
    RAISE EXCEPTION 'reserve_client_test_chat: missing argument' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_workspace_id::text || ':client_test_chat', 0)
  );

  SELECT count(*) FILTER (WHERE e.created_at >= now() - INTERVAL '1 hour'),
         count(*) FILTER (WHERE e.created_at >= now() - INTERVAL '1 hour'
                            AND e.payload->>'user_id' = p_user_id::text),
         COALESCE(SUM(CASE WHEN e.created_at >= v_day_start
                            AND e.payload->>'total_tokens' ~ '^[0-9]{1,12}$'
                           THEN (e.payload->>'total_tokens')::bigint ELSE 0 END), 0)
    INTO v_workspace_calls, v_user_calls, v_probar_today
    FROM public.events e
   WHERE e.type = 'client_test_chat'
     AND e.workspace_id = p_workspace_id
     AND e.created_at >= LEAST(v_day_start, now() - INTERVAL '1 hour');

  IF v_user_calls >= p_user_hourly_limit THEN
    RETURN QUERY SELECT false, 'user_hour'::text, NULL::UUID;
    RETURN;
  END IF;
  IF v_workspace_calls >= p_workspace_hourly_limit THEN
    RETURN QUERY SELECT false, 'workspace_hour'::text, NULL::UUID;
    RETURN;
  END IF;
  IF v_probar_today + p_ceiling > p_daily_cap THEN
    RETURN QUERY SELECT false, 'daily_cap'::text, NULL::UUID;
    RETURN;
  END IF;
  IF public.sum_daily_llm_tokens(p_workspace_id, v_day_start) + p_ceiling >= p_workspace_limit THEN
    RETURN QUERY SELECT false, 'budget'::text, NULL::UUID;
    RETURN;
  END IF;

  INSERT INTO public.events (type, level, workspace_id, payload)
  VALUES (
    'client_test_chat',
    'info',
    p_workspace_id,
    jsonb_build_object('total_tokens', p_ceiling, 'ceiling', p_ceiling, 'reserved', true, 'user_id', p_user_id)
  )
  RETURNING id INTO v_id;

  RETURN QUERY SELECT true, NULL::text, v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_client_test_chat(uuid, uuid, int, int, bigint, bigint, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_client_test_chat(uuid, uuid, int, int, bigint, bigint, bigint) TO service_role;

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
