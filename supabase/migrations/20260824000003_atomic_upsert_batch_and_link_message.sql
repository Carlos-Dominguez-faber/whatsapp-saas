-- ============================================================
-- Migration: 20260824000003_atomic_upsert_batch_and_link_message
-- Agente WhatsApp — Atomic batch upsert + message link
--
-- upsertBatch() extendía/creaba el batch y linkeaba el mensaje como DOS
-- escrituras PostgREST separadas. El .select("id") de una tarea anterior
-- cierra la ventana SELECT→UPDATE original, pero no la ventana entre
-- "extend/create exitoso" y "mensaje linkeado": si esa segunda escritura
-- tarda más que la ventana de silencio recién reseteada, claim_next_batch()
-- puede reclamar y consolidar el batch antes de que el link llegue, y el
-- mensaje se pierde igual.
--
-- Esta función hace las tres cosas (buscar, extender-o-crear, linkear) en
-- UNA transacción de Postgres: el lock de fila que toma el UPDATE de
-- extensión se sostiene hasta que la misma transacción también linkea el
-- mensaje, así que claim_next_batch() no puede interponerse entre esos dos
-- pasos. SECURITY INVOKER (default, sin DEFINER): mismo razonamiento que
-- sum_daily_llm_tokens (20260824000001) — service_role ya tiene acceso directo
-- a message_batches/messages, no hace falta escalar privilegios.
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
BEGIN
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
    -- Extend: push flush_at forward, increment count. Referencing the
    -- column directly in SET (not a variable read earlier) avoids a lost
    -- update if two calls for the same conversation race each other.
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

  -- 2. Link the message to the batch, in the SAME transaction — this is
  -- the fix: no external process can claim the batch between "extended/
  -- created" and "message linked" the way it could when these were two
  -- separate PostgREST calls.
  UPDATE public.messages
  SET batch_id = v_batch_id
  WHERE id = p_message_id;

  RETURN v_batch_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_batch_and_link_message(uuid, uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_batch_and_link_message(uuid, uuid, uuid, integer) TO service_role;

-- ============================================================
-- End of migration: 20260824000003_atomic_upsert_batch_and_link_message
-- ============================================================
