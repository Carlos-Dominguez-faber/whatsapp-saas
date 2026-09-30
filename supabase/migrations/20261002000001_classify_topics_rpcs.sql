-- Migration: 20261002000001_classify_topics_rpcs
-- RPCs del cron de clasificación. Solo service_role las ejecuta.
--
-- CON lease. El intervalo de pg_cron (5 min) NO garantiza que no haya
-- dos corridas simultáneas: un reintento de net.http_get, una corrida manual o
-- un redeploy bastan para que dos peticiones autorizadas entren a la vez. Dos
-- corridas sobre la misma conversación pagan dos llamadas al LLM y rompen el
-- límite de 3 intentos por la vía de la cuarentena. Se usa el patrón
-- FOR UPDATE ... SKIP LOCKED + columna de lease.
--
-- Ventana de 30 días y orden DESCENDENTE: se prioriza lo de ayer y se excluye
-- el histórico de más de 30 días; sin el corte, la
-- primera noche —con conversation_classification vacía— gastaría los 300k en
-- conversaciones de hace un año, de la más vieja a la más nueva, sin llegar a
-- ayer. Misma constante que el reprocesamiento.

-- ELIGIBILITY IS THE CUSTOMER'S LAST MESSAGE. A conversation is (re)classified
-- when the customer wrote something new, not when anything happened in it:
-- conversations.last_message_at also moves on every reply, template and
-- automation reminder, and classifying on it paid the LLM again for text the
-- customer never wrote. `last_inbound_at` below is the newest inbound message,
-- read through idx_messages_conversation; conversations.last_message_at only
-- pre-filters (a conversation with an inbound in the last 30 days had its
-- last_message_at moved then).
--
-- p_now defaults to now(). The nightly run never passes it; it lets a
-- simulation drive the real SQL through several nights.
--
-- #13 shipped (INT, UUID[], INT) returning last_message_at; the return type
-- changed, so both older signatures go first.
DROP FUNCTION IF EXISTS public.select_conversations_to_classify(INT, UUID[]);
DROP FUNCTION IF EXISTS public.select_conversations_to_classify(INT, UUID[], INT);

CREATE OR REPLACE FUNCTION public.select_conversations_to_classify(
  p_limit INT,
  p_skip_workspaces UUID[] DEFAULT '{}',
  p_lease_seconds INT DEFAULT 120,
  p_now TIMESTAMPTZ DEFAULT now()
)
RETURNS TABLE (conversation_id UUID, workspace_id UUID, contact_id UUID, last_inbound_at TIMESTAMPTZ)
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
-- Los parámetros OUT de RETURNS TABLE (conversation_id, workspace_id, ...) son
-- variables plpgsql y chocan con las columnas homónimas: sin esto, el
-- `ON CONFLICT (conversation_id)` de abajo falla con "column reference is
-- ambiguous". Dentro de la función nunca se les asigna nada, así que resolver
-- siempre a la columna es lo correcto.
#variable_conflict use_column
DECLARE
  v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 1), 1), 100);
  v_lease INTERVAL := make_interval(secs => LEAST(GREATEST(COALESCE(p_lease_seconds, 120), 0), 600));
  v_skip  UUID[]   := COALESCE(p_skip_workspaces, '{}');
  v_now   TIMESTAMPTZ := COALESCE(p_now, now());
BEGIN
  -- Paso 1: sembrar la fila de estado de las candidatas. El lease vive en
  -- conversation_classification, y FOR UPDATE necesita una fila que bloquear.
  -- Va en su propio statement: dentro de un solo statement la CTE del UPDATE
  -- no vería las filas insertadas por la CTE del INSERT (mismo snapshot).
  -- CRÍTICA-1: el LIMIT se gasta SOLO en conversaciones sin fila. Sin el
  -- NOT EXISTS, las v_limit más recientes ya sembradas se volvían a elegir en
  -- cada corrida, el ON CONFLICT las descartaba y la v_limit+1 nunca entraba.
  -- Las ya sembradas (reintentos, cuarentena liberada, mensajes nuevos) no
  -- dependen de este paso: el paso 2 las encuentra leyendo la tabla de estado.
  INSERT INTO public.conversation_classification (conversation_id, workspace_id, attempts, updated_at)
  SELECT c.id, c.workspace_id, 0, now()
    FROM public.conversations c
    CROSS JOIN LATERAL (
      SELECT m.created_at AS at
        FROM public.messages m
       WHERE m.conversation_id = c.id
         AND m.direction = 'in'
       ORDER BY m.created_at DESC
       LIMIT 1
    ) li
   WHERE c.last_message_at >= v_now - INTERVAL '30 days'
     AND li.at <  v_now - INTERVAL '1 hour'
     AND li.at >= v_now - INTERVAL '30 days'
     AND NOT (c.workspace_id = ANY (v_skip))
     AND NOT EXISTS (SELECT 1 FROM public.conversation_classification cc
                      WHERE cc.conversation_id = c.id)
     AND EXISTS (SELECT 1 FROM public.insight_topics t
                  WHERE t.workspace_id = c.workspace_id AND t.status = 'active')
   ORDER BY li.at DESC, c.id DESC
   LIMIT v_limit
  ON CONFLICT (conversation_id) DO NOTHING;

  -- Paso 2: reclamar. SKIP LOCKED deja que dos corridas simultáneas se
  -- repartan el trabajo en vez de pelearlo; claimed_until hace que la segunda
  -- ni siquiera vea lo que la primera está procesando.
  -- La elegibilidad de abajo (cortes de 1 h y 30 días sobre el último
  -- ENTRANTE, classified_until y liberación de cuarentena) está DUPLICADA en
  -- `oldest_pending` de get_insights (20261002000002_get_insights.sql).
  -- Cambiar una sin la otra hace que el dashboard reporte pendientes que el
  -- cron nunca va a tomar.
  RETURN QUERY
  WITH claimable AS (
    SELECT cc.conversation_id AS id, li.at AS last_in
      FROM public.conversation_classification cc
      JOIN public.conversations c ON c.id = cc.conversation_id
      CROSS JOIN LATERAL (
        SELECT m.created_at AS at
          FROM public.messages m
         WHERE m.conversation_id = c.id
           AND m.direction = 'in'
         ORDER BY m.created_at DESC
         LIMIT 1
      ) li
     WHERE c.last_message_at >= v_now - INTERVAL '30 days'
       AND li.at <  v_now - INTERVAL '1 hour'
       AND li.at >= v_now - INTERVAL '30 days'
       AND li.at >  COALESCE(cc.classified_until, '-infinity'::timestamptz)
       AND (cc.claimed_until IS NULL OR cc.claimed_until <= v_now)
       -- Cuarentena liberable: solo si llegó un ENTRANTE después del último
       -- intento. Mirar quarantined_at no alcanza.
       AND (cc.quarantined_at IS NULL
            OR li.at > COALESCE(cc.last_attempt_at, cc.quarantined_at))
       AND NOT (c.workspace_id = ANY (v_skip))
       AND EXISTS (SELECT 1 FROM public.insight_topics t
                    WHERE t.workspace_id = c.workspace_id AND t.status = 'active')
     ORDER BY li.at DESC, c.id DESC
     LIMIT v_limit
     FOR UPDATE OF cc SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.conversation_classification cc2
       SET claimed_until = v_now + v_lease,
           updated_at    = now()
      FROM claimable k
     WHERE cc2.conversation_id = k.id
    RETURNING cc2.conversation_id AS id
  )
  -- last_inbound_at is what the caller passes back as classified_until: the
  -- run covers the customer's messages up to it.
  SELECT c.id, c.workspace_id, c.contact_id, k.last_in
    FROM claimed cl
    JOIN claimable k ON k.id = cl.id
    JOIN public.conversations c ON c.id = cl.id
   ORDER BY k.last_in DESC, c.id DESC;
END;
$$;

-- p_window_from = created_at del mensaje más viejo que vio el LLM;
-- p_truncated_at = created_at de los mensajes cuyo cuerpo se recortó;
-- p_catalog = the topic ids the nightly run sent (catalog_at, below). The
-- backfill passes none. #13 shipped the version without p_catalog.
DROP FUNCTION IF EXISTS public.save_conversation_topics(UUID, UUID, JSONB, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ[]);

CREATE OR REPLACE FUNCTION public.save_conversation_topics(
  p_workspace_id UUID,
  p_conversation_id UUID,
  p_matches JSONB,
  p_classified_until TIMESTAMPTZ,
  p_window_from TIMESTAMPTZ DEFAULT NULL,
  p_truncated_at TIMESTAMPTZ[] DEFAULT NULL,
  p_catalog UUID[] DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_inserted INT;
  v_prev     TIMESTAMPTZ;
  v_pfrom    TIMESTAMPTZ;
  v_puntil   TIMESTAMPTZ;
  v_catalog  TIMESTAMPTZ;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.conversations
     WHERE id = p_conversation_id AND workspace_id = p_workspace_id
  ) THEN
    RAISE EXCEPTION 'conversation_not_in_workspace' USING ERRCODE = 'P0001';
  END IF;

  -- ¿Quedó texto SIN analizar? Solo cuenta lo que no se había
  -- analizado antes: en la fase 1, lo posterior al classified_until previo
  -- (el prompt trae contexto viejo que ya se vio entero o ya se marcó); en el
  -- reprocesamiento (p_classified_until NULL) todo, porque el tema es nuevo.
  IF p_classified_until IS NOT NULL THEN
    SELECT cc.classified_until INTO v_prev
      FROM public.conversation_classification cc
     WHERE cc.conversation_id = p_conversation_id;
  END IF;
  -- Only the customer's messages: they are the only ones a topic can be
  -- detected on, so only their text left out makes the analysis partial.
  IF p_window_from IS NOT NULL THEN
    SELECT min(msg.created_at), max(msg.created_at) INTO v_pfrom, v_puntil
      FROM public.messages msg
     WHERE msg.conversation_id = p_conversation_id
       AND msg.workspace_id = p_workspace_id
       AND msg.direction = 'in'
       AND msg.created_at < p_window_from
       AND msg.created_at > COALESCE(v_prev, '-infinity'::timestamptz);
  END IF;
  SELECT LEAST(v_pfrom, min(x)), GREATEST(v_puntil, max(x)) INTO v_pfrom, v_puntil
    FROM unnest(COALESCE(p_truncated_at, '{}'::timestamptz[])) AS x
   WHERE x > COALESCE(v_prev, '-infinity'::timestamptz);

  WITH m AS (
    SELECT (x->>'topic_id')::uuid AS topic_id, (x->>'message_id')::uuid AS message_id
      FROM jsonb_array_elements(COALESCE(p_matches, '[]'::jsonb)) AS x
  ),
  ins AS (
    INSERT INTO public.conversation_topics
      (conversation_id, topic_id, workspace_id, evidence_message_id, detected_at)
    -- Una fila por (tema, mensaje). Una cita ya guardada en una
    -- corrida anterior (el prompt incluye mensajes ya analizados) no duplica.
    SELECT DISTINCT p_conversation_id, m.topic_id, p_workspace_id, msg.id, msg.created_at
      FROM m
      JOIN public.insight_topics t
        ON t.id = m.topic_id AND t.workspace_id = p_workspace_id AND t.status = 'active'
      -- Evidence is always something the CUSTOMER wrote. The prompt only
      -- numbers their lines, and this join drops anything else a caller
      -- passes: a topic the bot or a person brought up is not what the
      -- customer asked about.
      JOIN public.messages msg
        ON msg.id = m.message_id
       AND msg.conversation_id = p_conversation_id
       AND msg.workspace_id = p_workspace_id
       AND msg.direction = 'in'
    ON CONFLICT (conversation_id, topic_id, evidence_message_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM ins;

  -- Topics are only ever created (never reactivated), so "every active topic
  -- created up to the newest one sent" is exactly the catalog that was sent.
  SELECT max(t.created_at) INTO v_catalog
    FROM public.insight_topics t
   WHERE t.id = ANY (COALESCE(p_catalog, '{}'::uuid[]))
     AND t.workspace_id = p_workspace_id;

  IF p_classified_until IS NOT NULL THEN
    INSERT INTO public.conversation_classification AS cc
      (conversation_id, workspace_id, classified_until, attempts, error, quarantined_at, claimed_until, last_attempt_at,
       partial_from, partial_until, catalog_at, updated_at)
    VALUES (p_conversation_id, p_workspace_id, p_classified_until, 0, NULL, NULL, NULL, now(), v_pfrom, v_puntil, v_catalog, now())
    ON CONFLICT (conversation_id) DO UPDATE SET
      classified_until = GREATEST(cc.classified_until, EXCLUDED.classified_until),
      catalog_at = GREATEST(cc.catalog_at, EXCLUDED.catalog_at),
      partial_from = LEAST(cc.partial_from, EXCLUDED.partial_from),
      partial_until = GREATEST(cc.partial_until, EXCLUDED.partial_until),
      attempts = 0,
      error = NULL,
      quarantined_at = NULL,
      -- Éxito: se suelta el lease en el acto, no se espera a que venza.
      claimed_until = NULL,
      last_attempt_at = now(),
      updated_at = now();
  ELSIF v_pfrom IS NOT NULL THEN
    -- Reprocesamiento: solo la marca de cobertura; el estado de la fase 1
    -- (classified_until, intentos, lease) no es suyo.
    INSERT INTO public.conversation_classification AS cc
      (conversation_id, workspace_id, partial_from, partial_until, updated_at)
    VALUES (p_conversation_id, p_workspace_id, v_pfrom, v_puntil, now())
    ON CONFLICT (conversation_id) DO UPDATE SET
      partial_from = LEAST(cc.partial_from, EXCLUDED.partial_from),
      partial_until = GREATEST(cc.partial_until, EXCLUDED.partial_until),
      updated_at = now();
  END IF;

  RETURN v_inserted;
END;
$$;

-- A failure also sets the conversation's next try: its lease becomes a
-- backoff of 1 h per attempt. Releasing it (as #13 did) let the same run pick
-- it again right away, so one bad conversation burned its 3 attempts in
-- seconds and went into quarantine without a second chance. p_now: see
-- select_conversations_to_classify. #13 shipped (UUID, UUID, TEXT).
DROP FUNCTION IF EXISTS public.record_classification_failure(UUID, UUID, TEXT);

CREATE OR REPLACE FUNCTION public.record_classification_failure(
  p_workspace_id UUID,
  p_conversation_id UUID,
  p_code TEXT,
  p_now TIMESTAMPTZ DEFAULT now()
)
RETURNS INT
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_attempts INT;
  v_released BOOLEAN;
  v_now      TIMESTAMPTZ := COALESCE(p_now, now());
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.conversations
     WHERE id = p_conversation_id AND workspace_id = p_workspace_id
  ) THEN
    RAISE EXCEPTION 'conversation_not_in_workspace' USING ERRCODE = 'P0001';
  END IF;

  -- La liberación de la cuarentena se decide DENTRO de la transacción y
  -- sobre la fila bloqueada, no fuera. `quarantined_at IS NOT NULL` no alcanza:
  -- con dos fallos concurrentes, el segundo vería la cuarentena que puso el
  -- primero y reiniciaría la cuenta a 1 sin que hubiera llegado ningún mensaje,
  -- rompiendo el límite de 3 intentos. La condición real es "hay un mensaje
  -- ENTRANTE posterior al último intento".
  SELECT cc.quarantined_at IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM public.messages m
            WHERE m.conversation_id = p_conversation_id
              AND m.direction = 'in'
              AND m.created_at > COALESCE(cc.last_attempt_at, cc.quarantined_at)
         )
    INTO v_released
    FROM public.conversation_classification cc
   WHERE cc.conversation_id = p_conversation_id
     FOR UPDATE;
  v_released := COALESCE(v_released, false);

  INSERT INTO public.conversation_classification AS cc
    (conversation_id, workspace_id, attempts, error, claimed_until, last_attempt_at, updated_at)
  VALUES (p_conversation_id, p_workspace_id, 1, p_code, v_now + INTERVAL '1 hour', v_now, now())
  ON CONFLICT (conversation_id) DO UPDATE SET
    attempts = CASE WHEN v_released THEN 1 ELSE cc.attempts + 1 END,
    error = EXCLUDED.error,
    quarantined_at = CASE WHEN v_released THEN NULL ELSE cc.quarantined_at END,
    -- Next try in 1 h per attempt, never in the same run.
    claimed_until = v_now + make_interval(hours => CASE WHEN v_released THEN 1 ELSE cc.attempts + 1 END),
    last_attempt_at = v_now,
    updated_at = now()
  RETURNING attempts INTO v_attempts;

  IF v_attempts >= 3 THEN
    UPDATE public.conversation_classification
       SET quarantined_at = v_now
     WHERE conversation_id = p_conversation_id;
  END IF;

  RETURN v_attempts;
END;
$$;

-- The backfill walks the conversations whose customer last wrote in the 30
-- days before the topic existed; the nightly run covers everything they write
-- after that, with the topic already in the catalog. Both sides split on the
-- LAST INBOUND message, so a reply or a reminder sent after the topic was
-- created can't move a conversation out of the backfill without the nightly
-- run picking it up (it only runs on new customer messages).
-- #13 shipped (UUID, INT) returning last_message_at.
DROP FUNCTION IF EXISTS public.next_backfill_batch(UUID, INT);

CREATE OR REPLACE FUNCTION public.next_backfill_batch(
  p_topic_id UUID,
  p_limit INT,
  p_now TIMESTAMPTZ DEFAULT now()
)
RETURNS TABLE (conversation_id UUID, workspace_id UUID, contact_id UUID, last_inbound_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT c.id, c.workspace_id, c.contact_id, li.at
  FROM public.insight_topics t
  JOIN public.conversations c ON c.workspace_id = t.workspace_id
  CROSS JOIN LATERAL (
    SELECT m.created_at AS at
      FROM public.messages m
     WHERE m.conversation_id = c.id
       AND m.direction = 'in'
     ORDER BY m.created_at DESC
     LIMIT 1
  ) li
  -- Only what the nightly run already read WITHOUT this topic. A conversation
  -- it read with the topic in the catalog was covered then (paying again
  -- bought nothing); one still waiting for it (never read, a new customer
  -- message, backing off, quarantined) will be read with the whole current
  -- catalog, this topic included.
  JOIN public.conversation_classification cc ON cc.conversation_id = c.id
  WHERE t.id = p_topic_id
    AND t.status = 'active'
    AND t.backfill_status = 'pending'
    AND cc.classified_until >= li.at
    AND COALESCE(cc.catalog_at, '-infinity'::timestamptz) < t.created_at
    -- Pre-filter only (see select_conversations_to_classify).
    AND c.last_message_at >= GREATEST(t.created_at, COALESCE(p_now, now())) - INTERVAL '30 days'
    -- Mismo corte de 30 días que la fase normal. El GREATEST evita que un
    -- tema viejo que quedó `pending` reprocese histórico ya fuera de alcance.
    -- Si cambia este piso, cambiar también la rama 'expired' de
    -- advance_topic_backfill, que deduce de él si la ventana venció, y el
    -- covered_from que escribe al terminar.
    AND li.at >= GREATEST(t.created_at - INTERVAL '30 days', COALESCE(p_now, now()) - INTERVAL '30 days')
    AND li.at <= t.created_at
    -- Cursor DESCENDENTE: lo más reciente primero, igual que la fase normal.
    AND (li.at, c.id) < (
      COALESCE(t.backfill_cursor_at, 'infinity'::timestamptz),
      COALESCE(t.backfill_cursor_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)
    )
  ORDER BY li.at DESC, c.id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 100);
$$;

-- Devuelve el backfill_status resultante para que el caller distinga
-- "terminado" de "ventana vencida". Cambió el tipo de retorno (era VOID):
-- CREATE OR REPLACE no puede cambiarlo, de ahí el DROP.
-- p_now: same as in next_backfill_batch.
DROP FUNCTION IF EXISTS public.advance_topic_backfill(UUID, TIMESTAMPTZ, UUID, BOOLEAN);

CREATE OR REPLACE FUNCTION public.advance_topic_backfill(
  p_topic_id UUID,
  p_cursor_at TIMESTAMPTZ,
  p_cursor_id UUID,
  p_done BOOLEAN,
  p_now TIMESTAMPTZ DEFAULT now()
)
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = ''
AS $$
-- Cursor MONOTÓNICO. El recorrido es descendente, así que el
-- cursor solo se mueve si la tupla nueva es ESTRICTAMENTE menor que la actual.
-- Con un COALESCE a ciegas, una corrida rezagada (lease vencido, o
-- una petición que el servidor ejecuta después de que el cliente la abortó)
-- retrocedería el cursor y el tramo se volvería a pagar. La fila se lee con
-- FOR UPDATE: dos avances concurrentes comparan contra el último confirmado,
-- no contra el snapshot de antes del lock.
DECLARE
  v_at     TIMESTAMPTZ;
  v_id     UUID;
  v_moves  BOOLEAN;
  v_status TEXT;
  v_now    TIMESTAMPTZ := COALESCE(p_now, now());
BEGIN
  SELECT t.backfill_cursor_at, t.backfill_cursor_id INTO v_at, v_id
    FROM public.insight_topics t
   WHERE t.id = p_topic_id
     FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Mismo centinela que next_backfill_batch para "sin cursor todavía".
  v_moves := p_cursor_at IS NOT NULL AND p_cursor_id IS NOT NULL
         AND (p_cursor_at, p_cursor_id) < (
               COALESCE(v_at, 'infinity'::timestamptz),
               COALESCE(v_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid));

  UPDATE public.insight_topics t
     SET backfill_cursor_at = CASE WHEN v_moves THEN p_cursor_at ELSE t.backfill_cursor_at END,
         backfill_cursor_id = CASE WHEN v_moves THEN p_cursor_id ELSE t.backfill_cursor_id END,
         -- Un avance que no avanza no borra los fallos que otra corrida contó.
         backfill_attempts  = CASE WHEN v_moves OR p_done IS TRUE THEN 0 ELSE t.backfill_attempts END,
         -- Cerrar el tema suelta el lease en el mismo UPDATE.
         backfill_claimed_until = CASE WHEN p_done IS TRUE THEN NULL ELSE t.backfill_claimed_until END,
         backfill_status    = CASE
           WHEN p_done IS NOT TRUE THEN t.backfill_status
           -- Piso > techo en next_backfill_batch: GREATEST(created_at - 30 d,
           -- now() - 30 d) > created_at  <=>  created_at < now() - 30 d. El lote
           -- salió vacío porque la ventana se venció, no porque se terminó.
           -- El vencimiento es deliberado (el dashboard no mira más de 30 días);
           -- lo que no puede pasar es llamarlo 'done'. Mismo 30 d que arriba.
           WHEN t.created_at < v_now - INTERVAL '30 days' THEN 'expired'
           ELSE 'done'
         END,
         -- A finished backfill went through every conversation whose customer
         -- last wrote from the window's floor NOW on (the floor rises with
         -- the clock, and the walk is newest first, so what fell below it was
         -- never classified): the topic is complete from that floor. An
         -- expired one covers nothing before created_at.
         covered_from = CASE
           WHEN p_done IS TRUE AND t.created_at >= v_now - INTERVAL '30 days'
             THEN LEAST(t.covered_from,
                        GREATEST(t.created_at - INTERVAL '30 days', v_now - INTERVAL '30 days'))
           ELSE t.covered_from
         END
   WHERE t.id = p_topic_id
  RETURNING t.backfill_status INTO v_status;
  RETURN v_status;
END;
$$;

-- Lease por tema para el reprocesamiento, con la forma del de
-- select_conversations_to_classify. Sin él, dos corridas solapadas pedirían el
-- mismo lote y pagarían dos veces las mismas llamadas. Una corrida procesa un
-- tema solo si esto devuelve true; si otra lo tiene, lo salta y sigue
-- paginando. El UPDATE es atómico: la segunda sesión espera el lock de la
-- fila y re-evalúa el WHERE contra el lease ya escrito.
-- No lleva token de propiedad: basta con que el lease (LEASE_SECONDS = 120)
-- dure más que la corrida (RUN_BUDGET_MS = 50 s, maxDuration = 60 s). Un
-- avance rezagado lo cubre el cursor monotónico de advance_topic_backfill.
CREATE OR REPLACE FUNCTION public.claim_topic_backfill(p_topic_id UUID, p_lease_seconds INT DEFAULT 120)
RETURNS BOOLEAN
LANGUAGE sql
SET search_path = ''
AS $$
  WITH claimed AS (
    UPDATE public.insight_topics t
       SET backfill_claimed_until = now() + make_interval(
             secs => LEAST(GREATEST(COALESCE(p_lease_seconds, 120), 0), 600))
     WHERE t.id = p_topic_id
       AND t.status = 'active'
       AND t.backfill_status = 'pending'
       AND (t.backfill_claimed_until IS NULL OR t.backfill_claimed_until <= now())
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$;

CREATE OR REPLACE FUNCTION public.release_topic_backfill(p_topic_id UUID)
RETURNS VOID
LANGUAGE sql
SET search_path = ''
AS $$
  UPDATE public.insight_topics
     SET backfill_claimed_until = NULL
   WHERE id = p_topic_id;
$$;

-- Sin guarda de cursor ni de lease a propósito: bajo el lease, una sola
-- corrida procesa el tema, y el contador es por tema. Un incremento rezagado
-- solo podría adelantar un salto, y ese salto pasa por advance_topic_backfill,
-- que no deja retroceder el cursor. El cierre done/expired tampoco necesita
-- guarda: un lote vacío significa que el cursor ya pasó todo lo que hay en la
-- ventana, y como el cursor solo baja y el techo (created_at) es fijo, sigue
-- siendo cierto aunque llegue tarde.
CREATE OR REPLACE FUNCTION public.record_backfill_failure(p_topic_id UUID)
RETURNS INT
LANGUAGE sql
SET search_path = ''
AS $$
  UPDATE public.insight_topics
     SET backfill_attempts = backfill_attempts + 1
   WHERE id = p_topic_id
  RETURNING backfill_attempts;
$$;

-- El tope diario de la clasificación es DURO.
-- Consultar el consumo y recién después de la llamada insertar el
-- consumo no alcanza: dos corridas con trabajo disjunto verían 299.999 y
-- autorizarían cada una su llamada (319.999), un INSERT caído dejaría el
-- gasto fuera de la cuenta en cada corrida, y un timeout sin `usage` no se
-- contaría nunca. Mismo patrón que reserve_llm_turn: bajo un
-- lock por workspace, en UNA llamada, se suma el día y, si el techo estimado
-- cabe, se inserta la fila con ese techo. settle_classification_tokens
-- la liquida después con el consumo real; si nunca se liquida (corte, caída),
-- queda la estimación, que es un techo. NULL = no cabe.
-- El lock no se sostiene durante la llamada al LLM: dura esta transacción.
--
-- ITS OWN BUDGET. The cap counts classification spend only, and that spend
-- is logged as type 'topic_classification', which sum_daily_llm_tokens (the
-- bot's daily budget) does not add up. Sharing one sum made each side starve
-- the other: a busy bot left no room to classify, and a night of
-- classification pushed the next day's bot toward its degrade threshold. The
-- workspace's worst-case day is the bot's cap plus this one. Nor does it
-- count as an agent turn: no contact_id, and not an 'llm_usage' row.
CREATE OR REPLACE FUNCTION public.reserve_classification_tokens(
  p_workspace_id UUID,
  p_conversation_id UUID,
  p_estimate INT,
  p_cap BIGINT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id   UUID;
  v_used BIGINT;
BEGIN
  -- Una estimación nula o no positiva reservaría sin contar nada.
  IF p_estimate IS NULL OR p_estimate <= 0 OR p_cap IS NULL THEN
    RAISE EXCEPTION 'invalid_reservation' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.conversations
     WHERE id = p_conversation_id AND workspace_id = p_workspace_id
  ) THEN
    RAISE EXCEPTION 'conversation_not_in_workspace' USING ERRCODE = 'P0001';
  END IF;

  -- Espacio de claves propio: no compite con reserve_llm_turn (workspace:contacto).
  PERFORM pg_advisory_xact_lock(hashtextextended('classify_budget:' || p_workspace_id::text, 0));

  -- The UTC day, like the bot's budget; the same guard on total_tokens as
  -- sum_daily_llm_tokens, so one malformed row can't break the sum.
  SELECT COALESCE(SUM(
           CASE WHEN e.payload->>'total_tokens' ~ '^[0-9]{1,12}$'
                THEN (e.payload->>'total_tokens')::bigint
                ELSE 0 END), 0)
    INTO v_used
    FROM public.events e
   WHERE e.workspace_id = p_workspace_id
     AND e.type = 'topic_classification'
     AND e.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

  IF v_used + p_estimate > p_cap THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.events (type, level, workspace_id, conversation_id, payload)
  VALUES ('topic_classification', 'info', p_workspace_id, p_conversation_id,
          jsonb_build_object(
            'purpose', 'topic_classification',
            'reserved', true,
            'estimated_tokens', p_estimate,
            'total_tokens', p_estimate))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Liquida UNA vez (reserved pasa a false) y solo una reserva de clasificación
-- del mismo workspace. Los negativos se llevan a 0: un total negativo no
-- calza con el ^[0-9]{1,12}$ de la suma, y la fila pasaría a contar 0
-- en vez de su estimación.
CREATE OR REPLACE FUNCTION public.settle_classification_tokens(
  p_reservation_id UUID,
  p_workspace_id UUID,
  p_model TEXT,
  p_prompt_tokens INT,
  p_completion_tokens INT
)
RETURNS BOOLEAN
LANGUAGE sql
SET search_path = ''
AS $$
  WITH v AS (
    SELECT GREATEST(COALESCE(p_prompt_tokens, 0), 0) AS pt,
           GREATEST(COALESCE(p_completion_tokens, 0), 0) AS ct
  ),
  settled AS (
    UPDATE public.events e
       SET payload = e.payload || jsonb_build_object(
             'model', p_model,
             'prompt_tokens', v.pt,
             'completion_tokens', v.ct,
             'total_tokens', v.pt + v.ct,
             'reserved', false)
      FROM v
     WHERE e.id = p_reservation_id
       AND e.workspace_id = p_workspace_id
       AND e.type = 'topic_classification'
       AND e.payload->>'reserved' = 'true'
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM settled);
$$;

REVOKE ALL ON FUNCTION public.select_conversations_to_classify(INT, UUID[], INT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_conversation_topics(UUID, UUID, JSONB, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ[], UUID[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_classification_failure(UUID, UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.next_backfill_batch(UUID, INT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.advance_topic_backfill(UUID, TIMESTAMPTZ, UUID, BOOLEAN, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_backfill_failure(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_topic_backfill(UUID, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_topic_backfill(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reserve_classification_tokens(UUID, UUID, INT, BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_classification_tokens(UUID, UUID, TEXT, INT, INT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.select_conversations_to_classify(INT, UUID[], INT, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.save_conversation_topics(UUID, UUID, JSONB, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ[], UUID[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_classification_failure(UUID, UUID, TEXT, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.next_backfill_batch(UUID, INT, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.advance_topic_backfill(UUID, TIMESTAMPTZ, UUID, BOOLEAN, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_backfill_failure(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_topic_backfill(UUID, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_topic_backfill(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_classification_tokens(UUID, UUID, INT, BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_classification_tokens(UUID, UUID, TEXT, INT, INT) TO service_role;
