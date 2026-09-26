-- ============================================================================
-- Migration: 20260929000001_atomic_batches_and_serialized_claim
-- The inbound buffer can no longer lose, merge or double-answer a batch.
--
-- Consolidates PR #9's five versions of upsert_batch_and_link_message
-- (20260824000003/4/6/7 and 20260825000000) and its claim_next_batch change
-- (20260902000000), plus one fix of ours. Idempotent over installs that
-- applied those migrations: `setup.mjs db-push` marks their versions as
-- reverted but their objects stay, and every statement here replaces them.
--
-- 1. upsert_batch_and_link_message(): extending/creating the batch and linking
--    the message happen in ONE transaction, under a per-conversation advisory
--    lock, idempotent for a message already linked, and refusing a message
--    from another workspace or conversation. A reconciled orphan always gets
--    its own batch (p_force_new_batch) that stays isolated even if it is
--    retried, and a batch past its own flush_at stops absorbing new messages.
-- 2. idx_messages_orphaned: supports the reconciler's lookup of inbound
--    messages the webhook never linked.
-- 3. claim_next_batch():
--    - a stale lease is 7 minutes, strictly above the routes' maxDuration
--      (300 s), so a live worker's batch is never handed to a second one;
--    - reclaiming a stale batch counts a retry, and after 3 it is
--      dead-lettered with an event, so a function killed mid-turn no longer
--      re-sends the same reply forever;
--    - NEW: one batch per conversation at a time. Before, a batch created
--      while another of the same conversation was being processed could be
--      claimed by a second worker and answered in parallel, out of order.
-- ============================================================================

-- ── 1. Atomic batch upsert ──────────────────────────────────────────────────

-- The 4-argument version from #9's intermediate migrations, if present.
DROP FUNCTION IF EXISTS public.upsert_batch_and_link_message(uuid, uuid, uuid, integer);

CREATE OR REPLACE FUNCTION public.upsert_batch_and_link_message(
  p_workspace_id UUID,
  p_conversation_id UUID,
  p_message_id UUID,
  p_silence_ms INTEGER,
  p_force_new_batch BOOLEAN DEFAULT false
)
RETURNS UUID
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_batch_id UUID;
  v_existing_id UUID;
  v_updated_id UUID;
  v_flush_at TIMESTAMPTZ;
  v_linked_rows INT;
  v_current_batch_id UUID;
  v_actual_workspace_id UUID;
  v_actual_conversation_id UUID;
BEGIN
  -- Serialize per conversation: two near-simultaneous messages must not
  -- create two batches (two AI replies). claim_next_batch() takes the same key.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_conversation_id::text, 0));

  -- Idempotency and scope in one read.
  SELECT batch_id, workspace_id, conversation_id
    INTO v_current_batch_id, v_actual_workspace_id, v_actual_conversation_id
    FROM public.messages
   WHERE id = p_message_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'upsert_batch_and_link_message: message % not found', p_message_id;
  END IF;

  IF v_actual_workspace_id <> p_workspace_id
     OR v_actual_conversation_id <> p_conversation_id THEN
    RAISE EXCEPTION
      'upsert_batch_and_link_message: message % belongs to another workspace or conversation',
      p_message_id;
  END IF;

  IF v_current_batch_id IS NOT NULL THEN
    RETURN v_current_batch_id;
  END IF;

  v_flush_at := NOW() + (p_silence_ms || ' milliseconds')::interval;

  IF NOT p_force_new_batch THEN
    -- The conversation's open batch, if it hasn't reached its own deadline and
    -- isn't a reconciled orphan's (those must stay alone, even on a retry).
    SELECT id INTO v_existing_id
      FROM public.message_batches
     WHERE workspace_id = p_workspace_id
       AND conversation_id = p_conversation_id
       AND status = 'buffering'
       AND flush_at > NOW()
       AND COALESCE((meta->>'isolated')::boolean, false) = false
     ORDER BY created_at DESC
     LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      UPDATE public.message_batches
         SET flush_at = v_flush_at,
             message_count = message_batches.message_count + 1,
             updated_at = NOW()
       WHERE id = v_existing_id
         AND status = 'buffering'
      RETURNING id INTO v_updated_id;
    END IF;
  END IF;

  IF v_updated_id IS NOT NULL THEN
    v_batch_id := v_updated_id;
  ELSE
    INSERT INTO public.message_batches (
      workspace_id, conversation_id, status, silence_ms, flush_at, message_count, meta
    ) VALUES (
      p_workspace_id, p_conversation_id, 'buffering', p_silence_ms, v_flush_at, 1,
      CASE WHEN p_force_new_batch THEN '{"isolated": true}'::jsonb ELSE '{}'::jsonb END
    )
    RETURNING id INTO v_batch_id;
  END IF;

  -- Link in the SAME transaction: claim_next_batch() can't consolidate the
  -- batch between the two writes and miss this message.
  UPDATE public.messages
     SET batch_id = v_batch_id
   WHERE id = p_message_id
     AND batch_id IS NULL;

  GET DIAGNOSTICS v_linked_rows = ROW_COUNT;
  IF v_linked_rows = 0 THEN
    RAISE EXCEPTION
      'upsert_batch_and_link_message: message % link race lost, batch % not linked',
      p_message_id, v_batch_id;
  END IF;

  RETURN v_batch_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_batch_and_link_message(uuid, uuid, uuid, integer, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_batch_and_link_message(uuid, uuid, uuid, integer, boolean)
  TO service_role;

-- ── 2. Orphaned inbound messages ────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_messages_orphaned
  ON public.messages(created_at)
  WHERE batch_id IS NULL AND direction = 'in';

-- ── 3. claim_next_batch ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.claim_next_batch()
RETURNS SETOF public.message_batches
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_candidate RECORD;
BEGIN
  -- 1. Dead-letter stale batches that already burned their retries (the same
  --    limit as MAX_BATCH_RETRIES in buffer.ts — change both together).
  WITH dead AS (
    UPDATE public.message_batches
       SET status = 'cancelled',
           updated_at = NOW(),
           meta = COALESCE(meta, '{}'::jsonb)
                  || jsonb_build_object('cancelled_reason', 'stale_lease_max_retries')
     WHERE status = 'processing'
       AND updated_at < NOW() - INTERVAL '7 minutes'
       AND COALESCE((meta->>'retry_count')::int, 0) >= 3
     RETURNING id, workspace_id, conversation_id, meta
  )
  INSERT INTO public.events (type, level, workspace_id, conversation_id, payload)
  SELECT 'batch_dead_letter',
         'error',
         dead.workspace_id,
         dead.conversation_id,
         jsonb_build_object(
           'batch_id', dead.id,
           'retry_count', COALESCE((dead.meta->>'retry_count')::int, 0),
           'source', 'claim_next_batch',
           'error', 'stale lease reclaimed too many times'
         )
    FROM dead;

  -- 2. The oldest ready (or stale) batch whose conversation has no other batch
  --    in flight. The advisory lock (the same key upsert_batch_and_link_message
  --    takes) keeps two concurrent claims off one conversation.
  FOR v_candidate IN
    SELECT b.id, b.conversation_id
      FROM public.message_batches b
     WHERE (b.status = 'buffering' AND b.flush_at < NOW())
        OR (b.status = 'processing' AND b.updated_at < NOW() - INTERVAL '7 minutes')
     ORDER BY b.flush_at ASC
     LIMIT 50
  LOOP
    CONTINUE WHEN NOT pg_try_advisory_xact_lock(
      hashtextextended(v_candidate.conversation_id::text, 0)
    );
    CONTINUE WHEN EXISTS (
      SELECT 1
        FROM public.message_batches p
       WHERE p.conversation_id = v_candidate.conversation_id
         AND p.id <> v_candidate.id
         AND p.status = 'processing'
         AND p.updated_at >= NOW() - INTERVAL '7 minutes'
    );

    RETURN QUERY
      UPDATE public.message_batches AS b
         SET status = 'processing',
             updated_at = NOW(),
             meta = CASE
               WHEN b.status = 'processing' THEN
                 COALESCE(b.meta, '{}'::jsonb) || jsonb_build_object(
                   'retry_count', COALESCE((b.meta->>'retry_count')::int, 0) + 1,
                   'last_error', 'stale lease reclaimed by claim_next_batch'
                 )
               ELSE b.meta
             END
       WHERE b.id = v_candidate.id
         AND (
           (b.status = 'buffering' AND b.flush_at < NOW())
           OR (b.status = 'processing' AND b.updated_at < NOW() - INTERVAL '7 minutes')
         )
      RETURNING b.*;

    IF FOUND THEN
      RETURN;
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_next_batch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_batch() TO service_role;

-- ============================================================================
-- End of migration: 20260929000001_atomic_batches_and_serialized_claim
-- ============================================================================
