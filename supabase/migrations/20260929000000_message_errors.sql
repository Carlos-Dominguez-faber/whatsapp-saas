-- ============================================================================
-- Migration: 20260929000000_message_errors
-- El detalle técnico de un envío fallido de WhatsApp, fuera del alcance del
-- navegador.
--
-- Lo que ve el operador vive en `messages.error_message`: un texto en español,
-- sin datos del proveedor. El código de Meta, el texto en inglés, el status HTTP
-- y el fbtrace_id van aquí, a una tabla que el cliente no puede leer: `messages`
-- se lee con `select("*")` desde el inbox y viaja entera por Realtime
-- (REPLICA IDENTITY FULL), así que su `meta` no sirve para esto.
--
-- Idempotente: las instalaciones que aplicaron el PR #9 (20260811000000, que
-- `setup.mjs db-push` marca como revertida) ya tienen la tabla. Para esas se
-- rehace el CHECK de `source`, que ahí aceptaba 'kapso' en lugar de 'provider'.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.message_errors (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  message_id    UUID NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  code          INTEGER,  -- código numérico de Meta; NULL si el payload no traía
  detail        TEXT,     -- texto crudo en inglés. NUNCA para el cliente
  source        TEXT NOT NULL,
  http_status   INTEGER,
  fbtrace_id    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.message_errors
  DROP CONSTRAINT IF EXISTS message_errors_source_check;
ALTER TABLE public.message_errors
  ADD CONSTRAINT message_errors_source_check
  CHECK (source IN ('response', 'webhook', 'provider', 'kapso', 'unknown'));

-- Una fila por mensaje: el mismo evento `failed` se puede reenviar (la firma de
-- Kapso no lleva timestamp) y el insert usa ON CONFLICT DO NOTHING contra esto.
CREATE UNIQUE INDEX IF NOT EXISTS uq_message_errors_message
  ON public.message_errors(message_id);
CREATE INDEX IF NOT EXISTS idx_message_errors_workspace
  ON public.message_errors(workspace_id, created_at DESC);

-- RLS activada y SIN políticas, a propósito: anon y authenticated no leen ni
-- escriben nada aquí, ni por consulta ni por Realtime. Los webhooks y dispatch
-- escriben con el service role. No agregar políticas "para que el admin lo vea";
-- si algún día hay que exponerlo, que sea con una función que devuelva algo
-- saneado. Tampoco va a `supabase_realtime`.
ALTER TABLE public.message_errors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.message_errors FROM anon, authenticated;
GRANT ALL ON TABLE public.message_errors TO service_role;

-- ============================================================================
-- End of migration: 20260929000000_message_errors
-- ============================================================================
