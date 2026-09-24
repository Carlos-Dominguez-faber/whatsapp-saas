-- ============================================================
-- Migration: 20260824000005_index_orphaned_inbound_messages
-- Agente WhatsApp — Index for orphaned inbound messages
--
-- Soporta la consulta de reconcileOrphanedMessages() (buffer.ts): mensajes
-- entrantes con batch_id NULL de más de N minutos. El índice existente
-- idx_messages_batch es WHERE batch_id IS NOT NULL — no sirve para esta
-- consulta. batch_id IS NULL debería ser una minoría diminuta de filas
-- (solo el caso huérfano), así que el índice parcial es chico igual que
-- idx_batches_flush (20260608000000).
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_messages_orphaned
  ON public.messages(created_at)
  WHERE batch_id IS NULL AND direction = 'in';

-- ============================================================
-- End of migration: 20260824000005_index_orphaned_inbound_messages
-- ============================================================
