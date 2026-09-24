-- ============================================================
-- Migration: 20260824000004_lock_and_verify_upsert_batch_and_link_message
-- Agente WhatsApp — Per-conversation lock + link verification
--
-- upsert_batch_and_link_message() (20260824000003) cerró la ventana de
-- carrera con claim_next_batch(), pero quedaban dos huecos:
--
-- 1. Sin lock por conversación: dos llamadas concurrentes para la MISMA
--    conversation_id (dos mensajes casi simultáneos) pueden ambas ver "no
--    hay batch buffering" bajo READ COMMITTED y cada una INSERTar su propio
--    batch — un turno lógico se parte en dos respuestas de IA distintas.
--    Mismo patrón de fix que reserve_llm_turn() (20260823000000) y
--    claim_next_batch() (20260608000002): pg_advisory_xact_lock serializa
--    por conversación, liberado solo al terminar la transacción de esta
--    función — nunca se sostiene durante el round-trip al LLM.
--
-- 2. El UPDATE messages final no verificaba ROW_COUNT: si afectaba 0 filas
--    (p_message_id no existe), la función igual devolvía un batch_id como
--    si el link hubiera funcionado. Ahora RAISE EXCEPTION si el link afecta
--    0 filas — la transacción entera hace rollback (incluye el batch
--    creado/extendido más arriba, cero efectos secundarios), la RPC
--    devuelve error, y upsertBatch() ya sabe lanzar sobre eso.
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
BEGIN
  -- Serializa por conversación — sin esto, dos llamadas concurrentes para la
  -- misma conversation_id pueden crear 2 batches en vez de 1.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_conversation_id::text, 0)
  );

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
  WHERE id = p_message_id;

  GET DIAGNOSTICS v_linked_rows = ROW_COUNT;
  IF v_linked_rows = 0 THEN
    RAISE EXCEPTION
      'upsert_batch_and_link_message: message % not found, batch % not linked',
      p_message_id, v_batch_id;
  END IF;

  RETURN v_batch_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_batch_and_link_message(uuid, uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_batch_and_link_message(uuid, uuid, uuid, integer) TO service_role;

-- ============================================================
-- End of migration: 20260824000004_lock_and_verify_upsert_batch_and_link_message
-- ============================================================
