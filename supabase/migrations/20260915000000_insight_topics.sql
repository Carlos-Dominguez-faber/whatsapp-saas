-- Migration: 20260915000000_insight_topics
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
ALTER TABLE public.conversations
  ADD CONSTRAINT uq_conversations_workspace_id UNIQUE (workspace_id, id);

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
  created_by         UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_insight_topics_workspace_id UNIQUE (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS idx_insight_topics_ws_status
  ON public.insight_topics (workspace_id, status);

DROP TRIGGER IF EXISTS trg_insight_topics_updated_at ON public.insight_topics;
CREATE TRIGGER trg_insight_topics_updated_at
  BEFORE UPDATE ON public.insight_topics
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Máx. 10 temas activos y un archivado no se reactiva. El advisory lock por workspace
-- serializa dos altas concurrentes: sin él, ambas cuentan 9 y quedan 11.
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

  -- Un tema que YA estaba activo se salta el conteo, salvo que cambie
  -- de workspace: mover un activo de A a B suma uno a B sin pasar por el tope.
  IF NEW.status <> 'active'
     OR (TG_OP = 'UPDATE' AND OLD.status = 'active' AND NEW.workspace_id = OLD.workspace_id) THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('insight_topics:' || NEW.workspace_id::text, 0));

  SELECT count(*) INTO v_active
    FROM public.insight_topics
   WHERE workspace_id = NEW.workspace_id AND status = 'active';

  IF v_active >= 10 THEN
    RAISE EXCEPTION 'insight_topics_cap' USING ERRCODE = 'P0001';
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
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- FK compuesta: mismo motivo que en conversation_topics más arriba.
  CONSTRAINT fk_conversation_classification_conversation
    FOREIGN KEY (workspace_id, conversation_id)
    REFERENCES public.conversations (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_conversation_classification_ws
  ON public.conversation_classification (workspace_id, claimed_until);

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
