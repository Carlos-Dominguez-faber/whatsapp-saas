-- ============================================================
-- Migration: 20260824000007_scope_check_upsert_batch_and_link_message
-- Agente WhatsApp — Scope check in upsert_batch_and_link_message
--
-- upsert_batch_and_link_message() (20260824000006) verifica que el mensaje
-- exista y es idempotente ante una segunda llamada, pero no valida que los
-- p_workspace_id/p_conversation_id que recibe correspondan de verdad al
-- mensaje. Si algún caller (bug interno, no explotable desde afuera porque
-- la RPC es service_role-only) pasara esos parámetros desalineados, el
-- mensaje quedaría linkeado a un batch de otro scope sin ningún error.
--
-- Fix: el pre-check de idempotencia (20260824000006) ya lee batch_id del mensaje
-- antes de proceder — se extiende para leer también workspace_id/
-- conversation_id reales en la MISMA consulta, y comparar contra los
-- parámetros. RAISE EXCEPTION si no coinciden, antes de tocar nada.
-- ============================================================

CREATE OR REPLACE FUNCTION public.upsert_batch_and_link_message(
  p_workspace_id UUID,
  p_conversation_id UUID,
  p_message_id UUID,
  p_silence_ms INTEGER
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
  -- Serializa por conversación — sin esto, dos llamadas concurrentes para la
  -- misma conversation_id pueden crear 2 batches en vez de 1.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_conversation_id::text, 0)
  );

  -- Idempotencia + validación de scope en una sola consulta: lee el estado
  -- real del mensaje (batch_id, workspace_id, conversation_id).
  SELECT batch_id, workspace_id, conversation_id
    INTO v_current_batch_id, v_actual_workspace_id, v_actual_conversation_id
  FROM public.messages
  WHERE id = p_message_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'upsert_batch_and_link_message: message % not found',
      p_message_id;
  END IF;

  IF v_actual_workspace_id <> p_workspace_id
     OR v_actual_conversation_id <> p_conversation_id THEN
    RAISE EXCEPTION
      'upsert_batch_and_link_message: message % belongs to workspace %/conversation %, not %/%',
      p_message_id, v_actual_workspace_id, v_actual_conversation_id,
      p_workspace_id, p_conversation_id;
  END IF;

  IF v_current_batch_id IS NOT NULL THEN
    RETURN v_current_batch_id;
  END IF;

  v_flush_at := NOW() + (p_silence_ms || ' milliseconds')::interval;

  -- 1. Look for an active buffering batch for this conversation
  SELECT id INTO v_existing_id
  FROM public.message_batches
  WHERE workspace_id = p_workspace_id
    AND conversation_id = p_conversation_id
    AND status = 'buffering'
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

  IF v_updated_id IS NOT NULL THEN
    v_batch_id := v_updated_id;
  ELSE
    -- No existing batch, or lost the race to claim_next_batch(): start fresh.
    INSERT INTO public.message_batches (
      workspace_id, conversation_id, status, silence_ms, flush_at, message_count, meta
    ) VALUES (
      p_workspace_id, p_conversation_id, 'buffering', p_silence_ms, v_flush_at, 1, '{}'::jsonb
    )
    RETURNING id INTO v_batch_id;
  END IF;

  -- 2. Link the message to the batch, in the SAME transaction.
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

REVOKE ALL ON FUNCTION public.upsert_batch_and_link_message(uuid, uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_batch_and_link_message(uuid, uuid, uuid, integer) TO service_role;

-- ============================================================
-- End of migration: 20260824000007_scope_check_upsert_batch_and_link_message
-- ============================================================
