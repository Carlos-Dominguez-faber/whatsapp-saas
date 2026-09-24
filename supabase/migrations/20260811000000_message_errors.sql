-- ============================================================================
-- message_errors: el detalle técnico de un envío fallido de WhatsApp.
--
-- Antes esto vivía en `messages.meta.wa_error` (código de Meta, texto en inglés,
-- fbtrace_id, status HTTP) y llegaba entero al navegador por dos vías: el
-- `select("*")` del inbox y el canal Realtime, que replica la fila completa
-- porque `messages` tiene REPLICA IDENTITY FULL. Eso filtra detalle interno al
-- cliente. Acá queda aparte, en una tabla que el cliente no puede leer.
--
-- Lo que SÍ ve el operador sigue donde estaba: `messages.error_message`, el
-- texto en español. Esta tabla es solo para depurar del lado del servidor.
-- ============================================================================

CREATE TABLE IF NOT EXISTS message_errors (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  message_id    UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  code          INTEGER,                          -- código numérico de Meta; NULL si el payload no traía
  detail        TEXT,                             -- texto crudo en inglés (details/title). NUNCA para el cliente
  source        TEXT NOT NULL                     -- de dónde se extrajo el error
                CHECK (source IN ('response', 'webhook', 'kapso', 'unknown')),
  http_status   INTEGER,
  fbtrace_id    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---- Anti-replay: una fila por mensaje, no una por reproducción ----
-- La firma HMAC de Kapso no lleva timestamp, así que un mismo evento `failed`
-- firmado se puede reenviar N veces y sin unicidad escribiría N filas idénticas.
-- Resolverlo con un SELECT previo reintroduciría la carrera; la unicidad la
-- garantiza la base y el insert usa ON CONFLICT DO NOTHING.
--
-- La clave es solo `message_id`: un mensaje falla por un motivo, y el primero
-- que se registra es el que vale. Si llegaran dos `failed` con códigos
-- distintos para el mismo mensaje, el segundo se descarta — aceptado a cambio
-- de que la clave no dependa de comparar `detail` (TEXT sin tope, con NULLs).
-- Reemplaza al índice no único que había acá: un UNIQUE ya sirve para buscar.
CREATE UNIQUE INDEX IF NOT EXISTS uq_message_errors_message ON message_errors(message_id);
CREATE INDEX IF NOT EXISTS idx_message_errors_workspace ON message_errors(workspace_id, created_at DESC);

-- ---- RLS: activada y SIN NINGUNA POLÍTICA — esto es deliberado ----
-- Sin políticas, `anon` y `authenticated` no leen ni escriben nada acá: ni por
-- consulta ni por Realtime. El service role (webhooks y dispatch) escribe por
-- bypass de RLS, no por política, así que NO hace falta ninguna para que la app
-- funcione.
--
-- NO agregar políticas de SELECT "para que el admin lo vea": el sentido de esta
-- tabla es que el detalle técnico nunca salga del servidor. Si algún día hay que
-- exponerlo, se hace con una función SECURITY DEFINER que devuelva algo
-- saneado, no abriendo la tabla.
--
-- Tampoco se agrega a `supabase_realtime`: publicarla reintroduciría la fuga.
ALTER TABLE message_errors ENABLE ROW LEVEL SECURITY;

-- ---- Sin limpieza de `messages.meta` — a propósito ----
-- Acá había un `UPDATE messages SET meta = meta - 'wa_error'` sobre toda la
-- tabla. Se quitó: `wa_error` se introdujo y se sacó dentro de esta misma tanda
-- de cambios y nunca estuvo desplegado (no aparece en ningún commit), así que
-- en cualquier base real ese WHERE no matchea ni una fila y solo deja un scan
-- completo de `messages` dentro de la migración. No hay nada que limpiar.
