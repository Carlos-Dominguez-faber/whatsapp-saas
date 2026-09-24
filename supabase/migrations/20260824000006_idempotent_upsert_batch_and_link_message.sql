-- ============================================================
-- Migration: 20260824000006_idempotent_upsert_batch_and_link_message
-- Agente WhatsApp — Idempotent upsert_batch_and_link_message
--
-- upsert_batch_and_link_message() (20260824000004) serializa por
-- conversación y verifica ROW_COUNT, pero no es idempotente: si la misma
-- llamada (mismo p_message_id) se ejecuta dos veces -- el webhook original
-- quedó reintentando más de 2 minutos y el cron de reconcileOrphanedMessages
-- lo recoge como huérfano, o dos corridas del cron buffer-flush se
-- solapan -- la segunda ejecución sobreescribe ciegamente el batch_id del
-- mensaje (mismo conversation_id, así que el lock las serializa, pero
-- serializar no es lo mismo que ser idempotente) y puede: (a) inflar
-- message_count de un batch que ya contaba este mensaje, o (b) si el primer
-- batch ya fue drenado por processNextBatch(), reasignar el mensaje a un
-- batch nuevo -- el mensaje termina respondido dos veces por la IA.
--
-- Fix: al entrar (ya bajo el lock por conversación), si el mensaje YA tiene
-- batch_id asignado, la función devuelve ese batch_id sin tocar nada más --
-- no-op idempotente. Solo procede a crear/extender un batch y linkear si el
-- mensaje todavía no estaba linkeado. El UPDATE final conserva el guard
-- "AND batch_id IS NULL" como defensa adicional.
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
BEGIN
  -- Serializa por conversación — sin esto, dos llamadas concurrentes para la
  -- misma conversation_id pueden crear 2 batches en vez de 1.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_conversation_id::text, 0)
  );

  -- Idempotencia: si el mensaje ya está linkeado (llamada repetida para el
  -- mismo message_id -- reconciliación duplicada, corridas de cron
  -- solapadas, o el webhook original que finalmente responde tras una
  -- reconciliación que ya lo linkeó), devolver el batch existente sin volver
  -- a crear/extender nada. Distingue "mensaje no existe" (error real) de
  -- "mensaje ya linkeado" (no-op seguro).
  SELECT batch_id INTO v_current_batch_id
  FROM public.messages
  WHERE id = p_message_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'upsert_batch_and_link_message: message % not found',
      p_message_id;
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

  -- 2. Link the message to the batch, in the SAME transaction. The
  -- "AND batch_id IS NULL" guard is defense in depth on top of the
  -- idempotency check above -- with both calls sharing the same
  -- conversation_id (and therefore the same advisory lock), this should
  -- never actually hit 0 rows in practice, but stays fail-closed if it does.
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
-- End of migration: 20260824000006_idempotent_upsert_batch_and_link_message
-- ============================================================
