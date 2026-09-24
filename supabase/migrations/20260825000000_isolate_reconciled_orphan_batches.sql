-- ============================================================
-- Migration: 20260825000000_isolate_reconciled_orphan_batches
-- Agente WhatsApp — bug observado en producción: un contacto
-- saludó ("Hola") y el agente respondió retomando una pregunta de 3 días
-- antes sobre una cita, en vez de saludar de vuelta.
--
-- Causa raíz: upsert_batch_and_link_message() (20260824000007) busca "el
-- batch buffering más reciente de la conversación" filtrando SOLO por
-- status='buffering', sin mirar flush_at ni de dónde viene la llamada. Eso
-- permite dos fusiones indebidas:
--
--   1. reconcileOrphanedMessages() revive un mensaje huérfano de días de
--      antigüedad creando un batch nuevo; si un mensaje real llega antes de
--      que el cron lo reclame, se le pega a ese batch y le vuelve a
--      extender flush_at, reabriendo la ventana.
--   2. Al revés: un mensaje nuevo crea su propio batch (ventana normal de
--      30s) y el reconciliador, buscando el huérfano de esa misma
--      conversación en ese ratito, lo mete en ese batch recién creado.
--
-- Un primer intento de fix (silenceMs=0 en la llamada del reconciliador)
-- NO cierra ninguno de los dos casos — solo encoge la ventana del caso 1
-- sin eliminarla, y no toca el caso 2 en absoluto.
--
-- Fix real, dos cambios en la misma función:
--   a) Nuevo parámetro p_force_new_batch: cuando es true (solo lo usa el
--      reconciliador), se salta por completo la búsqueda de "batch
--      existente" y siempre crea uno nuevo, dedicado a ese único mensaje.
--      Un huérfano reconciliado, por definición, es temporalmente ajeno a
--      lo que esté buffering ahora mismo para esa conversación — nunca
--      debe unírsele. Cierra el caso 2.
--   b) El match normal (p_force_new_batch=false, el camino del webhook en
--      tiempo real) ahora exige además flush_at > NOW(): un batch que ya
--      venció su propia ventana de silencio (a punto de ser reclamado por
--      claim_next_batch(), sea del reconciliador o uno real que el cron no
--      alcanzó a procesar) no debe seguir absorbiendo contenido nuevo en
--      silencio. Cierra el caso 1 sin afectar el debounce normal (los
--      mensajes reales legítimos siempre llegan bien antes de que venza su
--      propio flush_at — es el propósito de la ventana de silencio).
-- ============================================================

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

  IF NOT p_force_new_batch THEN
    -- 1. Look for an active buffering batch for this conversation that
    --    hasn't already reached its own flush deadline.
    SELECT id INTO v_existing_id
    FROM public.message_batches
    WHERE workspace_id = p_workspace_id
      AND conversation_id = p_conversation_id
      AND status = 'buffering'
      AND flush_at > NOW()
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
    -- No existing batch to join, lost the race to claim_next_batch(), or
    -- p_force_new_batch requested standalone isolation: start fresh.
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

REVOKE ALL ON FUNCTION public.upsert_batch_and_link_message(uuid, uuid, uuid, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_batch_and_link_message(uuid, uuid, uuid, integer, boolean) TO service_role;

-- ============================================================
-- End of migration: 20260825000000_isolate_reconciled_orphan_batches
-- ============================================================
