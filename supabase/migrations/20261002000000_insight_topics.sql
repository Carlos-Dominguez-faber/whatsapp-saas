-- Migration: 20261002000000_insight_topics
-- Dashboard de análisis: temas, detecciones y estado de clasificación.
--
-- El estado de clasificación vive en conversation_classification y NO en
-- columnas de conversations: esa tabla tiene trigger updated_at, está en
-- supabase_realtime y los miembros tienen policy FOR UPDATE. Escribirla cada
-- noche reordenaría el inbox y un agente podría falsear el estado.

-- Defensa en profundidad de aislamiento de tenant (además de la RPC): sin esto, nada en el esquema impide insertar una fila con
-- workspace_id del tenant A y topic_id/conversation_id del tenant B.
-- UNIQUE(workspace_id, id) en cada tabla padre habilita las FK compuestas
-- (workspace_id, <fk>) de las tablas hijas más abajo — esa combinación es lo
-- que exige que el workspace de la fila hija coincida con el del padre.
--
-- En conversations (tabla preexistente, con datos) es aditivo y seguro:
-- id ya es PK (único en toda la tabla), así que UNIQUE(workspace_id, id) no
-- puede violarse con datos existentes; solo agrega un índice.
-- main ya la crea en 20260926000002_tenant_consistent_foreign_keys; la guarda
-- la vuelve un no-op ahí y la crea en una instalación que no la tenga.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.conversations'::regclass
       AND conname = 'uq_conversations_workspace_id'
  ) THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT uq_conversations_workspace_id UNIQUE (workspace_id, id);
  END IF;
END
$$;

-- ── insight_topics ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.insight_topics (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name               TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  description        TEXT NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 500),
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  -- 'expired': el reprocesamiento terminó SIN procesar el histórico
  -- porque la ventana de 30 días se venció (piso > techo en next_backfill_batch).
  -- No es lo mismo que 'done'; lo decide advance_topic_backfill, no el caller.
  backfill_status    TEXT NOT NULL DEFAULT 'pending' CHECK (backfill_status IN ('pending', 'done', 'expired')),
  backfill_cursor_at TIMESTAMPTZ,
  backfill_cursor_id UUID,
  backfill_attempts  INT NOT NULL DEFAULT 0,
  -- Lease del reprocesamiento, mismo patrón que
  -- conversation_classification.claimed_until. Lo mueven claim_topic_backfill,
  -- release_topic_backfill y el cierre de advance_topic_backfill.
  backfill_claimed_until TIMESTAMPTZ,
  -- Earliest moment this topic's detections are complete from. The nightly
  -- run covers what customers write after the topic exists, so it starts at
  -- created_at; a finished backfill moves it back to the start of the window
  -- it went through (advance_topic_backfill). get_insights measures a topic
  -- only from here on: before it, "no detections" means "not analysed", and
  -- counting it as 0 % would dilute shares and invent deltas.
  covered_from       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by         UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_insight_topics_workspace_id UNIQUE (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS idx_insight_topics_ws_status
  ON public.insight_topics (workspace_id, status);

-- An install that ran #13's own migrations (20260915000000..02) already has
-- the table without covered_from. Its topics get the same value they would
-- have had here: created_at, or the backfill window when it finished.
ALTER TABLE public.insight_topics ADD COLUMN IF NOT EXISTS covered_from TIMESTAMPTZ;
-- #13's backfill covered from its window's floor when it finished, which
-- rose with the clock: GREATEST(created_at, finish) - 30 days. The finish
-- isn't stored; the topic's updated_at is at or after it (the closing update
-- set it), so it gives a floor that is never earlier than the truth.
UPDATE public.insight_topics
   SET covered_from = CASE WHEN backfill_status = 'done'
                           THEN LEAST(created_at, GREATEST(created_at, updated_at) - INTERVAL '30 days')
                           ELSE created_at END
 WHERE covered_from IS NULL;
ALTER TABLE public.insight_topics ALTER COLUMN covered_from SET DEFAULT now();
ALTER TABLE public.insight_topics ALTER COLUMN covered_from SET NOT NULL;

DROP TRIGGER IF EXISTS trg_insight_topics_updated_at ON public.insight_topics;
CREATE TRIGGER trg_insight_topics_updated_at
  BEFORE UPDATE ON public.insight_topics
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- The name two topics can't share: case, accents and spaces aside ("Precio",
-- "precio", "Precío" — typed with a precomposed í or with i + a combining
-- accent — are one topic). NFC first, so both spellings of an accent become
-- the same character; non-breaking and other Unicode spaces count as spaces.
-- ñ stays: año is not ano.
CREATE OR REPLACE FUNCTION public.insight_topic_key(p_name TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT lower(translate(
           btrim(regexp_replace(
             translate(normalize(p_name, NFC), U&'\00A0\2007\202F\2009\200A', '     '),
             '\s+', ' ', 'g')),
           'ÁÉÍÓÚÜÀÈÌÒÙáéíóúüàèìòù', 'AEIOUUAEIOUaeiouuaeiou'));
$$;

-- Máx. 10 temas activos, sin dos activos con el mismo nombre (insight_topic_key),
-- y un archivado no se reactiva. El advisory lock por workspace serializa dos
-- altas concurrentes: sin él, ambas cuentan 9 y quedan 11, o ambas ven el nombre
-- libre. Duplicates an install already has (from #13) stay: only new writes are
-- checked, so the upgrade never aborts on them.
CREATE OR REPLACE FUNCTION public.enforce_insight_topics_rules()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_active INT;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'archived' AND NEW.status = 'active' THEN
    RAISE EXCEPTION 'insight_topics_no_reactivate' USING ERRCODE = 'P0001';
  END IF;

  -- Nothing to check for an archived topic, nor for an active one that keeps
  -- its workspace and its name (the backfill's cursor updates, for one).
  IF NEW.status <> 'active'
     OR (TG_OP = 'UPDATE' AND OLD.status = 'active' AND NEW.workspace_id = OLD.workspace_id
         AND public.insight_topic_key(NEW.name) = public.insight_topic_key(OLD.name)) THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('insight_topics:' || NEW.workspace_id::text, 0));

  IF EXISTS (
    SELECT 1 FROM public.insight_topics t
     WHERE t.workspace_id = NEW.workspace_id
       AND t.status = 'active'
       AND t.id <> NEW.id
       AND public.insight_topic_key(t.name) = public.insight_topic_key(NEW.name)
  ) THEN
    RAISE EXCEPTION 'insight_topics_duplicate' USING ERRCODE = 'P0001';
  END IF;

  -- Un tema que YA estaba activo se salta el conteo, salvo que cambie
  -- de workspace: mover un activo de A a B suma uno a B sin pasar por el tope.
  IF TG_OP = 'INSERT' OR OLD.status <> 'active' OR NEW.workspace_id <> OLD.workspace_id THEN
    SELECT count(*) INTO v_active
      FROM public.insight_topics
     WHERE workspace_id = NEW.workspace_id AND status = 'active';

    IF v_active >= 10 THEN
      RAISE EXCEPTION 'insight_topics_cap' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Sin cláusula `OF status`: con ella, un UPDATE que no nombra
-- `status` —p. ej. SET workspace_id— no dispararía el trigger y dejaría 11
-- activos. La función sale antes del lock en los UPDATE que no afectan el tope,
-- así que dispararla en todos (avance del cursor incluido) cuesta poco.
DROP TRIGGER IF EXISTS trg_insight_topics_rules ON public.insight_topics;
CREATE TRIGGER trg_insight_topics_rules
  BEFORE INSERT OR UPDATE ON public.insight_topics
  FOR EACH ROW EXECUTE FUNCTION public.enforce_insight_topics_rules();

-- ── conversation_topics ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.conversation_topics (
  conversation_id     UUID NOT NULL,
  topic_id            UUID NOT NULL,
  workspace_id        UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- Referencia, nunca copia del texto. NOT NULL y ON DELETE CASCADE: es parte
  -- de la PK, así que no puede quedar NULL. Borrar el mensaje borra la
  -- detección que se apoyaba en él (derecho de supresión de datos
  -- personales); con SET NULL la PK lo impediría.
  evidence_message_id UUID NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  -- created_at del mensaje de evidencia, no de la corrida.
  detected_at         TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- UNA DETECCIÓN POR MENSAJE. Las conversaciones son
  -- de por vida por contacto; con la PK (conversation_id, topic_id) la primera
  -- detección taparía para siempre a las siguientes y el tema desaparecería de
  -- los períodos posteriores. El dashboard cuenta conversaciones DISTINTAS con
  -- alguna detección en el rango (get_insights).
  PRIMARY KEY (conversation_id, topic_id, evidence_message_id),
  -- FK compuesta: exige que el workspace del tema y el de la conversación
  -- coincidan con el workspace_id de esta fila, no solo que topic_id y
  -- conversation_id existan. Sustituye a las FK simples de una sola columna.
  CONSTRAINT fk_conversation_topics_topic
    FOREIGN KEY (workspace_id, topic_id)
    REFERENCES public.insight_topics (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_conversation_topics_conversation
    FOREIGN KEY (workspace_id, conversation_id)
    REFERENCES public.conversations (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_conversation_topics_ws_topic_detected
  ON public.conversation_topics (workspace_id, topic_id, detected_at);

-- ── conversation_classification ────────────────────────────
CREATE TABLE IF NOT EXISTS public.conversation_classification (
  conversation_id  UUID PRIMARY KEY,
  workspace_id     UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  classified_until TIMESTAMPTZ,
  attempts         INT NOT NULL DEFAULT 0,
  error            TEXT CHECK (error IS NULL OR error ~ '^[a-z0-9_]{1,40}$'),
  quarantined_at   TIMESTAMPTZ,
  -- Lease: mientras
  -- claimed_until > now() la fila está tomada por otra corrida y no se
  -- vuelve a seleccionar. Una corrida muerta libera sola al vencer.
  claimed_until    TIMESTAMPTZ,
  -- Momento del último intento. La cuarentena se libera SOLO si hay un mensaje
  -- entrante posterior a este valor: mirar quarantined_at no alcanza, porque
  -- dos fallos concurrentes se reinician la cuenta entre ellos.
  last_attempt_at  TIMESTAMPTZ,
  -- Cobertura parcial DECLARADA. Envolvente de las
  -- fechas de los mensajes cuyo texto no llegó entero al LLM (omitidos por el
  -- tope de 60 o con el cuerpo recortado a 800 caracteres). Solo crece; NULL =
  -- nunca hubo recorte. Lo escribe save_conversation_topics y lo cuenta
  -- get_insights (`partial_conversations`).
  partial_from     TIMESTAMPTZ,
  partial_until    TIMESTAMPTZ,
  -- The newest topic of the catalog the last nightly classification ran with:
  -- every active topic created up to here was in it. The backfill of a topic
  -- created later than this skips nothing; one created earlier already read
  -- this conversation and skips it (next_backfill_batch).
  catalog_at       TIMESTAMPTZ,
  -- Topics whose backfill read this conversation (it was read before they
  -- existed). With catalog_at, it tells whether a conversation was analysed
  -- FOR a given topic (get_insights), not just analysed.
  backfill_topics  UUID[] NOT NULL DEFAULT '{}',
  -- Transient failures in a row (5xx, network, timeout): each doubles the
  -- wait before the next try (defer_classification). Back to 0 on success.
  transient_failures INT NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- FK compuesta: mismo motivo que en conversation_topics más arriba.
  CONSTRAINT fk_conversation_classification_conversation
    FOREIGN KEY (workspace_id, conversation_id)
    REFERENCES public.conversations (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_conversation_classification_ws
  ON public.conversation_classification (workspace_id, claimed_until);
-- #13's table has no catalog_at: its rows stay NULL (catalog unknown), so a
-- backfill still reads them, as #13 did.
ALTER TABLE public.conversation_classification ADD COLUMN IF NOT EXISTS catalog_at TIMESTAMPTZ;
ALTER TABLE public.conversation_classification ADD COLUMN IF NOT EXISTS backfill_topics UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE public.conversation_classification ADD COLUMN IF NOT EXISTS transient_failures INT NOT NULL DEFAULT 0;

-- ── RLS y privilegios ──────────────────────────────────────
-- Escritura solo service_role: sin policies de escritura para miembros.
ALTER TABLE public.insight_topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_classification ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ws members read insight topics" ON public.insight_topics;
CREATE POLICY "ws members read insight topics" ON public.insight_topics
  FOR SELECT USING (workspace_id IN (SELECT auth_workspace_ids()));

DROP POLICY IF EXISTS "ws members read conversation topics" ON public.conversation_topics;
CREATE POLICY "ws members read conversation topics" ON public.conversation_topics
  FOR SELECT USING (workspace_id IN (SELECT auth_workspace_ids()));

-- Los privilegios por defecto de Supabase otorgan ALL; revocar solo los
-- verbos de escritura dejaría REFERENCES y TRIGGER. Se revoca todo y se devuelve
-- únicamente el SELECT que la RLS filtra por membresía.
REVOKE ALL ON public.insight_topics FROM anon, authenticated;
REVOKE ALL ON public.conversation_topics FROM anon, authenticated;
GRANT SELECT ON public.insight_topics TO authenticated;
GRANT SELECT ON public.conversation_topics TO authenticated;
REVOKE ALL ON public.conversation_classification FROM anon, authenticated;

-- ── Upgrade from #13's own migrations ──────────────────────
-- No-ops on a fresh install. An install that ran #13 (20260915000000..02):
--
-- * Topics are now detected on the CUSTOMER's messages only (see
--   save_conversation_topics). Detections #13 stored on the agent's or a
--   person's replies would keep counting under the new rule, so they go.
-- * Classification spend is its own event type now ('topic_classification'),
--   outside the bot's daily budget (see reserve_classification_tokens). #13
--   logged it as 'llm_usage'; moving those rows keeps today's classification
--   spend inside its own cap, and out of the bot's budget and of the
--   per-conversation LLM metrics.
DELETE FROM public.conversation_topics ct
 USING public.messages m
 WHERE m.id = ct.evidence_message_id
   AND m.direction <> 'in';

-- The containment test uses idx_events_payload_gin instead of scanning every
-- llm_usage row.
UPDATE public.events
   SET type = 'topic_classification'
 WHERE payload @> '{"purpose": "topic_classification"}'
   AND type = 'llm_usage';
