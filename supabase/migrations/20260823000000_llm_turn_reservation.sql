-- ============================================================
-- Migration: 20260823000000_llm_turn_reservation
-- Agente WhatsApp — atomic per-contact hourly LLM turn reservation
--
-- checkRateLimits' per-contact hourly turn limit was a classic
-- check-then-act race: two concurrent requests for the same contact both
-- read a count under the ceiling before either had written its own
-- llm_usage event, so both were authorized. Verified with 2 concurrent
-- requests against the real function: both allowed, counter ended up at
-- 21 turns with the limit set to 20.
--
-- reserve_llm_turn() closes this the same way claim_next_batch() already
-- does for batch claiming (20260608000002_buffer_rpc.sql): the count-check
-- and the row that makes the NEXT caller's count-check see this one both
-- happen inside a single function call, serialized per (workspace, contact)
-- via pg_advisory_xact_lock so two concurrent calls for the SAME contact
-- can't both pass. The lock is scoped to the transaction wrapping this one
-- RPC call (milliseconds) — NOT held across the LLM round-trip, which the
-- stateless Supabase REST client couldn't hold a lock across anyway.
--
-- The reservation is a real llm_usage row with total_tokens=0, inserted
-- immediately; cost-tracker.ts's recordLlmUsage() later updates that same
-- row with the real token counts instead of inserting a new one. If the
-- LLM call fails before recordLlmUsage runs, the reservation stays at 0
-- tokens — correct, since a turn slot really was spent on the attempt even
-- though no tokens were billed.
-- ============================================================

CREATE OR REPLACE FUNCTION reserve_llm_turn(
  p_workspace_id UUID,
  p_contact_id TEXT,
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
  -- Serialize concurrent reservations for the same (workspace, contact) —
  -- released automatically when this function's transaction ends.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_workspace_id::text || ':' || p_contact_id, 0)
  );

  SELECT count(*) INTO v_count
  FROM public.events
  WHERE type = 'llm_usage'
    AND workspace_id = p_workspace_id
    AND payload->>'contact_id' = p_contact_id
    AND created_at >= now() - INTERVAL '1 hour';

  IF v_count >= p_hourly_limit THEN
    RETURN QUERY SELECT false, NULL::UUID;
    RETURN;
  END IF;

  INSERT INTO public.events (type, level, workspace_id, payload)
  VALUES (
    'llm_usage',
    'info',
    p_workspace_id,
    jsonb_build_object(
      'contact_id', p_contact_id,
      'total_tokens', 0,
      'reserved', true
    )
  )
  RETURNING id INTO v_id;

  RETURN QUERY SELECT true, v_id;
END;
$$;

-- Server-side only (called from decide() via service_role) — never by an
-- end-user client. Matches the REVOKE pattern in
-- 20260608000008_sec02_function_hardening.sql for the sibling worker RPCs.
REVOKE EXECUTE ON FUNCTION public.reserve_llm_turn(uuid, text, int) FROM anon, authenticated;

-- ============================================================
-- End of migration: 20260823000000_llm_turn_reservation
-- ============================================================
