-- Migration: 20260915000001_classify_topics_rpcs
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

-- La firma cambió (se agregó p_lease_seconds): sin este DROP, CREATE OR REPLACE
-- dejaría las dos versiones como sobrecargas.
DROP FUNCTION IF EXISTS public.select_conversations_to_classify(INT, UUID[]);

CREATE OR REPLACE FUNCTION public.select_conversations_to_classify(
  p_limit INT,
  p_skip_workspaces UUID[] DEFAULT '{}',
  p_lease_seconds INT DEFAULT 120
)
RETURNS TABLE (conversation_id UUID, workspace_id UUID, contact_id UUID, last_message_at TIMESTAMPTZ)
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
   WHERE c.last_message_at IS NOT NULL
     AND c.last_message_at <  now() - INTERVAL '1 hour'
     AND c.last_message_at >= now() - INTERVAL '30 days'
     AND NOT (c.workspace_id = ANY (v_skip))
     AND NOT EXISTS (SELECT 1 FROM public.conversation_classification cc
                      WHERE cc.conversation_id = c.id)
     AND EXISTS (SELECT 1 FROM public.insight_topics t
                  WHERE t.workspace_id = c.workspace_id AND t.status = 'active')
   ORDER BY c.last_message_at DESC, c.id DESC
   LIMIT v_limit
  ON CONFLICT (conversation_id) DO NOTHING;

  -- Paso 2: reclamar. SKIP LOCKED deja que dos corridas simultáneas se
  -- repartan el trabajo en vez de pelearlo; claimed_until hace que la segunda
  -- ni siquiera vea lo que la primera está procesando.
  -- La elegibilidad de abajo (cortes de 1 h y 30 días, classified_until
  -- y liberación de cuarentena) está DUPLICADA en `oldest_pending` de
  -- get_insights (20260915000002_get_insights.sql). Cambiar una sin la otra
  -- hace que el dashboard reporte pendientes que el cron nunca va a tomar.
  RETURN QUERY
  WITH claimable AS (
    SELECT cc.conversation_id AS id
      FROM public.conversation_classification cc
      JOIN public.conversations c ON c.id = cc.conversation_id
     WHERE c.last_message_at IS NOT NULL
       AND c.last_message_at <  now() - INTERVAL '1 hour'
       AND c.last_message_at >= now() - INTERVAL '30 days'
       AND c.last_message_at >  COALESCE(cc.classified_until, '-infinity'::timestamptz)
       AND (cc.claimed_until IS NULL OR cc.claimed_until <= now())
       -- Cuarentena liberable: solo si llegó un ENTRANTE después del último
       -- intento. Mirar quarantined_at no alcanza.
       AND (cc.quarantined_at IS NULL OR EXISTS (
             SELECT 1 FROM public.messages m
              WHERE m.conversation_id = c.id
                AND m.direction = 'in'
                AND m.created_at > COALESCE(cc.last_attempt_at, cc.quarantined_at)))
       AND NOT (c.workspace_id = ANY (v_skip))
       AND EXISTS (SELECT 1 FROM public.insight_topics t
                    WHERE t.workspace_id = c.workspace_id AND t.status = 'active')
     ORDER BY c.last_message_at DESC, c.id DESC
     LIMIT v_limit
     FOR UPDATE OF cc SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.conversation_classification cc2
       SET claimed_until = now() + v_lease,
           updated_at    = now()
      FROM claimable k
     WHERE cc2.conversation_id = k.id
    RETURNING cc2.conversation_id AS id
  )
  SELECT c.id, c.workspace_id, c.contact_id, c.last_message_at
    FROM claimed cl
    JOIN public.conversations c ON c.id = cl.id
   ORDER BY c.last_message_at DESC, c.id DESC;
END;
$$;

-- p_window_from = created_at del mensaje más viejo que vio el LLM;
-- p_truncated_at = created_at de los mensajes cuyo cuerpo se recortó.
CREATE OR REPLACE FUNCTION public.save_conversation_topics(
  p_workspace_id UUID,
  p_conversation_id UUID,
  p_matches JSONB,
  p_classified_until TIMESTAMPTZ,
  p_window_from TIMESTAMPTZ DEFAULT NULL,
  p_truncated_at TIMESTAMPTZ[] DEFAULT NULL
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
  IF p_window_from IS NOT NULL THEN
    SELECT min(msg.created_at), max(msg.created_at) INTO v_pfrom, v_puntil
      FROM public.messages msg
     WHERE msg.conversation_id = p_conversation_id
       AND msg.workspace_id = p_workspace_id
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
      JOIN public.messages msg
        ON msg.id = m.message_id
       AND msg.conversation_id = p_conversation_id
       AND msg.workspace_id = p_workspace_id
    ON CONFLICT (conversation_id, topic_id, evidence_message_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM ins;

  IF p_classified_until IS NOT NULL THEN
    INSERT INTO public.conversation_classification AS cc
      (conversation_id, workspace_id, classified_until, attempts, error, quarantined_at, claimed_until, last_attempt_at,
       partial_from, partial_until, updated_at)
    VALUES (p_conversation_id, p_workspace_id, p_classified_until, 0, NULL, NULL, NULL, now(), v_pfrom, v_puntil, now())
    ON CONFLICT (conversation_id) DO UPDATE SET
      classified_until = GREATEST(cc.classified_until, EXCLUDED.classified_until),
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

CREATE OR REPLACE FUNCTION public.record_classification_failure(
  p_workspace_id UUID,
  p_conversation_id UUID,
  p_code TEXT
)
RETURNS INT
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_attempts INT;
  v_released BOOLEAN;
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
  VALUES (p_conversation_id, p_workspace_id, 1, p_code, NULL, now(), now())
  ON CONFLICT (conversation_id) DO UPDATE SET
    attempts = CASE WHEN v_released THEN 1 ELSE cc.attempts + 1 END,
    error = EXCLUDED.error,
    quarantined_at = CASE WHEN v_released THEN NULL ELSE cc.quarantined_at END,
    -- Fallo: se suelta el lease para que la próxima corrida pueda reintentar.
    claimed_until = NULL,
    last_attempt_at = now(),
    updated_at = now()
  RETURNING attempts INTO v_attempts;

  IF v_attempts >= 3 THEN
    UPDATE public.conversation_classification
       SET quarantined_at = now()
     WHERE conversation_id = p_conversation_id;
  END IF;

  RETURN v_attempts;
END;
$$;

CREATE OR REPLACE FUNCTION public.next_backfill_batch(p_topic_id UUID, p_limit INT)
RETURNS TABLE (conversation_id UUID, workspace_id UUID, contact_id UUID, last_message_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT c.id, c.workspace_id, c.contact_id, c.last_message_at
  FROM public.insight_topics t
  JOIN public.conversations c ON c.workspace_id = t.workspace_id
  WHERE t.id = p_topic_id
    AND t.status = 'active'
    AND t.backfill_status = 'pending'
    -- Mismo corte de 30 días que la fase normal. El GREATEST evita que un
    -- tema viejo que quedó `pending` reprocese histórico ya fuera de alcance.
    -- Si cambia este piso, cambiar también la rama 'expired' de
    -- advance_topic_backfill, que deduce de él si la ventana venció.
    AND c.last_message_at >= GREATEST(t.created_at - INTERVAL '30 days', now() - INTERVAL '30 days')
    AND c.last_message_at <= t.created_at
    -- Cursor DESCENDENTE: lo más reciente primero, igual que la fase normal.
    AND (c.last_message_at, c.id) < (
      COALESCE(t.backfill_cursor_at, 'infinity'::timestamptz),
      COALESCE(t.backfill_cursor_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)
    )
  ORDER BY c.last_message_at DESC, c.id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 100);
$$;

-- Devuelve el backfill_status resultante para que el caller distinga
-- "terminado" de "ventana vencida". Cambió el tipo de retorno (era VOID):
-- CREATE OR REPLACE no puede cambiarlo, de ahí el DROP.
DROP FUNCTION IF EXISTS public.advance_topic_backfill(UUID, TIMESTAMPTZ, UUID, BOOLEAN);

CREATE OR REPLACE FUNCTION public.advance_topic_backfill(
  p_topic_id UUID,
  p_cursor_at TIMESTAMPTZ,
  p_cursor_id UUID,
  p_done BOOLEAN
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
           WHEN t.created_at < now() - INTERVAL '30 days' THEN 'expired'
           ELSE 'done'
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
-- Consultar sum_daily_llm_tokens y recién después de la llamada insertar el
-- consumo no alcanza: dos corridas con trabajo disjunto verían 299.999 y
-- autorizarían cada una su llamada (319.999), un INSERT caído dejaría el
-- gasto fuera de la cuenta en cada corrida, y un timeout sin `usage` no se
-- contaría nunca. Mismo patrón que reserve_llm_turn: bajo un
-- lock por workspace, en UNA llamada, se suma el día y, si el techo estimado
-- cabe, se inserta la fila de llm_usage con ese techo. settle_classification_tokens
-- la liquida después con el consumo real; si nunca se liquida (corte, caída),
-- queda la estimación, que es un techo. NULL = no cabe.
-- El lock no se sostiene durante la llamada al LLM: dura esta transacción.
-- Sin contact_id en el payload a propósito: así la clasificación no consume
-- el tope por contacto del bot.
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
  v_id UUID;
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

  -- Mismo día UTC y misma suma que el resto del presupuesto de LLM.
  IF public.sum_daily_llm_tokens(p_workspace_id, date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
     + p_estimate > p_cap THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.events (type, level, workspace_id, conversation_id, payload)
  VALUES ('llm_usage', 'info', p_workspace_id, p_conversation_id,
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
-- calza con el ^[0-9]+$ de sum_daily_llm_tokens, y la fila pasaría a contar 0
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
       AND e.type = 'llm_usage'
       AND e.payload->>'purpose' = 'topic_classification'
       AND e.payload->>'reserved' = 'true'
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM settled);
$$;

REVOKE ALL ON FUNCTION public.select_conversations_to_classify(INT, UUID[], INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_conversation_topics(UUID, UUID, JSONB, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_classification_failure(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.next_backfill_batch(UUID, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.advance_topic_backfill(UUID, TIMESTAMPTZ, UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_backfill_failure(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_topic_backfill(UUID, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_topic_backfill(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reserve_classification_tokens(UUID, UUID, INT, BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_classification_tokens(UUID, UUID, TEXT, INT, INT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.select_conversations_to_classify(INT, UUID[], INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.save_conversation_topics(UUID, UUID, JSONB, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_classification_failure(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.next_backfill_batch(UUID, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.advance_topic_backfill(UUID, TIMESTAMPTZ, UUID, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_backfill_failure(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_topic_backfill(UUID, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_topic_backfill(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_classification_tokens(UUID, UUID, INT, BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_classification_tokens(UUID, UUID, TEXT, INT, INT) TO service_role;
