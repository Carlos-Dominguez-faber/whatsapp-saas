-- ============================================================
-- Migration: 20260902000000_claim_next_batch_counts_stale_retries
-- Agente WhatsApp — claim_next_batch counts stale-lease retries.
--
-- Causa raíz: claim_next_batch() (20260608000002) re-reclama un batch en
-- 'processing' cuyo lease venció SIN tocar meta.retry_count. Ese contador solo
-- sube en el catch de processNextBatch() (buffer.ts). Si la función serverless
-- muere entre dispatchText() y markBatchProcessed() —por ejemplo al agotar
-- maxDuration en un turno largo— el batch queda 'processing', el reclaim lo
-- devuelve al worker con retry_count intacto, y el cliente recibe la MISMA
-- respuesta una y otra vez pagando un turno de LLM completo cada vez.
-- MAX_BATCH_RETRIES nunca se alcanza por este camino.
--
-- Fix, tres cambios en la misma función:
--   1. Antes de reclamar, los batches stale que ya agotaron sus reintentos
--      (retry_count >= 3, mismo tope que MAX_BATCH_RETRIES en buffer.ts —
--      cambiar ambos a la vez) pasan a 'cancelled' y dejan un evento
--      batch_dead_letter, igual que hace el catch de TS.
--   2. Al reclamar un batch stale, retry_count sube en 1 y last_error deja
--      rastro. Un batch 'buffering' normal no cambia.
--   3. El lease de staleness pasa de 5 a 7 minutos. Con 5 min el lease era
--      EXACTAMENTE igual a maxDuration = 300s de las rutas del cron
--      (src/app/api/cron/buffer-flush/route.ts y
--      src/app/api/internal/buffer/process/route.ts): cero margen. Cualquier
--      drift de reloj entre el runtime de Vercel y Postgres, o cualquier
--      demora de drenaje/cierre de la función más allá de los 300s
--      declarados, dejaba que el cron (corre cada minuto) tratara como stale
--      un batch que un worker vivo todavía estaba procesando — segundo
--      reclamo, segundo turno de LLM y mensaje DUPLICADO al cliente. El lease
--      debe quedar siempre por encima de maxDuration con margen; si algún día
--      sube maxDuration, este INTERVAL sube antes y por más.
--
-- Efecto: un batch atascado se reintenta como máximo 3 veces por este camino
-- y después se apaga solo, visible en events.
-- ============================================================

CREATE OR REPLACE FUNCTION claim_next_batch()
RETURNS SETOF public.message_batches
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- 1. Dead-letter stale batches that already burned their retries.
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

  -- 2. Claim one ready (or stale) batch, counting the retry when it is stale.
  RETURN QUERY
  WITH candidate AS (
    SELECT id, status AS prev_status FROM public.message_batches
    WHERE status IN ('buffering', 'processing')
      AND (
        -- Ready buffering batches whose silence window has elapsed
        (status = 'buffering' AND flush_at < NOW())
        OR
        -- Reclaim stale processing batches (lease > 7 min = stuck worker).
        -- 7 > maxDuration (300s = 5 min) a propósito: el margen evita robarle
        -- el batch a un worker vivo por drift de reloj o drenaje tardío.
        (status = 'processing' AND updated_at < NOW() - INTERVAL '7 minutes')
      )
    ORDER BY flush_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.message_batches AS b
    SET status = 'processing',
        updated_at = NOW(),
        meta = CASE
          WHEN candidate.prev_status = 'processing' THEN
            COALESCE(b.meta, '{}'::jsonb) || jsonb_build_object(
              'retry_count', COALESCE((b.meta->>'retry_count')::int, 0) + 1,
              'last_error', 'stale lease reclaimed by claim_next_batch'
            )
          ELSE b.meta
        END
  FROM candidate
  WHERE b.id = candidate.id
  RETURNING b.*;
END;
$$;

-- ============================================================
-- End of migration: 20260902000000_claim_next_batch_counts_stale_retries
-- ============================================================
