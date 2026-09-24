-- Migration: 20260915000002_get_insights
-- Lectura del dashboard de análisis. Devuelve CONTEOS; los
-- porcentajes se calculan en TypeScript. Solo service_role ejecuta: el caller
-- (src/features/analytics/services/insights.ts) verifica la membresía antes.
--
-- Derivación = evento state_change a handoff_pending: los caminos que
-- derivan pasan por applyTransition (decision-engine.ts), que lo inserta.
-- Sin índice nuevo en messages; el universo recorre los entrantes
-- del workspace en el rango. Agregar messages(workspace_id, created_at)
-- WHERE direction = 'in' si get_insights pasa de ~1 s.

CREATE OR REPLACE FUNCTION public.get_insights(
  p_workspace_id UUID,
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
  p_tags TEXT[],
  p_tz TEXT
)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
WITH
universe AS (
  SELECT DISTINCT m.conversation_id
    FROM public.messages m
   WHERE m.workspace_id = p_workspace_id
     AND m.direction = 'in'
     AND m.created_at >= p_from AND m.created_at < p_to
),
prev_universe AS (
  SELECT DISTINCT m.conversation_id
    FROM public.messages m
   WHERE m.workspace_id = p_workspace_id
     AND m.direction = 'in'
     AND m.created_at >= p_from - (p_to - p_from) AND m.created_at < p_from
),
conv AS (
  SELECT u.conversation_id,
         EXISTS (
           SELECT 1 FROM public.appointments a
            WHERE a.conversation_id = u.conversation_id
              -- La FK appointments.conversation_id es simple; sin este
              -- filtro, una cita de otro tenant contaría como agendada acá.
              AND a.workspace_id = p_workspace_id
              AND a.created_at >= p_from AND a.created_at < p_to
         ) AS booked,
         EXISTS (
           SELECT 1 FROM public.events e
            WHERE e.conversation_id = u.conversation_id
              AND e.workspace_id = p_workspace_id
              AND e.type = 'state_change'
              AND e.payload->>'to' = 'handoff_pending'
              AND e.created_at >= p_from AND e.created_at < p_to
         ) AS handed_off,
         ct.tags
    FROM universe u
    JOIN public.conversations c ON c.id = u.conversation_id AND c.workspace_id = p_workspace_id
    -- La FK de conversations.contact_id solo mira contacts.id
    -- (foundation.sql:209) y un manager puede reapuntarla (policy de UPDATE,
    -- foundation.sql:679). Sin este filtro, el nombre, el teléfono y las
    -- etiquetas de un contacto de otro tenant entran acá.
    JOIN public.contacts ct ON ct.id = c.contact_id AND ct.workspace_id = p_workspace_id
),
prev_conv AS (
  SELECT pu.conversation_id,
         EXISTS (
           SELECT 1 FROM public.appointments a
            WHERE a.conversation_id = pu.conversation_id
              AND a.workspace_id = p_workspace_id
              AND a.created_at >= p_from - (p_to - p_from) AND a.created_at < p_from
         ) AS booked,
         EXISTS (
           SELECT 1 FROM public.events e
            WHERE e.conversation_id = pu.conversation_id
              AND e.workspace_id = p_workspace_id
              AND e.type = 'state_change'
              AND e.payload->>'to' = 'handoff_pending'
              AND e.created_at >= p_from - (p_to - p_from) AND e.created_at < p_from
         ) AS handed_off
    FROM prev_universe pu
    JOIN public.conversations c ON c.id = pu.conversation_id AND c.workspace_id = p_workspace_id
    JOIN public.contacts ct ON ct.id = c.contact_id AND ct.workspace_id = p_workspace_id
),
tag_list AS (
  SELECT DISTINCT unnest(COALESCE(p_tags, '{}'::text[])) AS tag
),
topics AS (
  SELECT t.id, t.name
    FROM public.insight_topics t
   WHERE t.workspace_id = p_workspace_id AND t.status = 'active'
),
-- conversation_topics tiene UNA FILA POR MENSAJE de
-- evidencia. Todo lo de abajo cuenta conversaciones DISTINTAS con al menos una
-- detección en el rango; con una fila por conversación, la primera detección
-- taparía a las siguientes y un tema recurrente desaparecería de los períodos
-- posteriores.
hits AS (
  SELECT DISTINCT ctp.topic_id, conv.conversation_id, conv.booked, conv.handed_off, conv.tags
    FROM public.conversation_topics ctp
    JOIN conv ON conv.conversation_id = ctp.conversation_id
   WHERE ctp.workspace_id = p_workspace_id
     AND ctp.detected_at >= p_from AND ctp.detected_at < p_to
),
prev_hits AS (
  SELECT ctp.topic_id, count(DISTINCT ctp.conversation_id) AS n
    FROM public.conversation_topics ctp
    -- Sobre prev_conv (filtrado por tenant en el contacto), igual que
    -- hits usa conv. Con prev_universe crudo el numerador incluiría lo que el
    -- denominador (prev_conversations) descarta: porcentajes sobre 100 %.
    JOIN prev_conv pc ON pc.conversation_id = ctp.conversation_id
   WHERE ctp.workspace_id = p_workspace_id
     AND ctp.detected_at >= p_from - (p_to - p_from) AND ctp.detected_at < p_from
   GROUP BY ctp.topic_id
)
SELECT jsonb_build_object(
  'base', (
    SELECT jsonb_build_object(
      'conversations', count(*),
      'booked', count(*) FILTER (WHERE conv.booked),
      'handed_off', count(*) FILTER (WHERE conv.handed_off),
      'tags', (
        SELECT COALESCE(jsonb_object_agg(tl.tag, (SELECT count(*) FROM conv c2 WHERE c2.tags @> ARRAY[tl.tag])), '{}'::jsonb)
          FROM tag_list tl
      )
    ) FROM conv
  ),
  -- El universo anterior se cuenta sobre prev_conv (ya filtrado por
  -- tenant en el contacto), no sobre prev_universe crudo.
  'prev_conversations', (SELECT count(*) FROM prev_conv),
  'prev_booked', (SELECT count(*) FROM prev_conv WHERE prev_conv.booked),
  'prev_handed_off', (SELECT count(*) FROM prev_conv WHERE prev_conv.handed_off),
  'topics', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', tp.id,
      'name', tp.name,
      'conversations', (SELECT count(*) FROM hits h WHERE h.topic_id = tp.id),
      'prev_conversations', COALESCE((SELECT ph.n FROM prev_hits ph WHERE ph.topic_id = tp.id), 0),
      'booked', (SELECT count(*) FROM hits h WHERE h.topic_id = tp.id AND h.booked),
      'handed_off', (SELECT count(*) FROM hits h WHERE h.topic_id = tp.id AND h.handed_off),
      'tags', (
        SELECT COALESCE(jsonb_object_agg(tl.tag, (
                 SELECT count(*) FROM hits h WHERE h.topic_id = tp.id AND h.tags @> ARRAY[tl.tag])), '{}'::jsonb)
          FROM tag_list tl
      )
    ) ORDER BY tp.name)
    FROM topics tp
  ), '[]'::jsonb),
  'trend', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('topic_id', w.topic_id, 'week', w.week, 'conversations', w.n)
                     ORDER BY w.week, w.topic_id)
      FROM (
        -- Una conversación cuenta una vez por semana, en cada semana
        -- del rango en que tuvo alguna detección.
        SELECT ctp.topic_id,
               to_char(date_trunc('week', ctp.detected_at AT TIME ZONE p_tz), 'YYYY-MM-DD') AS week,
               count(DISTINCT ctp.conversation_id) AS n
          FROM public.conversation_topics ctp
          JOIN conv ON conv.conversation_id = ctp.conversation_id
          JOIN topics tp ON tp.id = ctp.topic_id
         WHERE ctp.workspace_id = p_workspace_id
           AND ctp.detected_at >= p_from AND ctp.detected_at < p_to
         GROUP BY ctp.topic_id, 2
      ) w
  ), '[]'::jsonb),
  -- Conversaciones del universo con texto que no
  -- llegó entero al LLM (tope de 60 mensajes o cuerpo recortado a 800
  -- caracteres) con fecha dentro del rango. Límite declarado; la UI lo avisa.
  'partial_conversations', (
    SELECT count(*)
      FROM conv
      JOIN public.conversation_classification cc
        ON cc.conversation_id = conv.conversation_id AND cc.workspace_id = p_workspace_id
     WHERE cc.partial_from < p_to AND cc.partial_until >= p_from
  ),
  -- Misma elegibilidad que select_conversations_to_classify
  -- (20260915000001_classify_topics_rpcs.sql, paso 2) salvo el lease: una
  -- reclamada sigue pendiente. Lo que el cron nunca va a tomar (fuera de los
  -- 30 días, o en cuarentena sin entrante posterior al último intento) no se
  -- reporta como pendiente. Si cambia allá, cambia acá.
  'oldest_pending', (
    SELECT min(c.last_message_at)
      FROM public.conversations c
      LEFT JOIN public.conversation_classification cc ON cc.conversation_id = c.id
     WHERE c.workspace_id = p_workspace_id
       AND EXISTS (SELECT 1 FROM topics)
       AND c.last_message_at <  now() - INTERVAL '1 hour'
       AND c.last_message_at >= now() - INTERVAL '30 days'
       AND c.last_message_at > COALESCE(cc.classified_until, '-infinity'::timestamptz)
       AND (cc.quarantined_at IS NULL OR EXISTS (
             SELECT 1 FROM public.messages m
              WHERE m.conversation_id = c.id
                AND m.direction = 'in'
                AND m.created_at > COALESCE(cc.last_attempt_at, cc.quarantined_at)))
  )
);
$$;

CREATE OR REPLACE FUNCTION public.get_insight_evidence(
  p_workspace_id UUID,
  p_topic_id UUID,
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
  p_outcome TEXT,
  p_tag TEXT,
  p_limit INT,
  p_offset INT
)
RETURNS TABLE (conversation_id UUID, contact_name TEXT, contact_phone TEXT, detected_at TIMESTAMPTZ, evidence_body TEXT)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  -- Una fila por CONVERSACIÓN (su detección más reciente dentro del
  -- rango), aunque tenga varias detecciones del tema en el período.
  SELECT d.conversation_id, d.name, d.phone, d.detected_at, d.body
  FROM (
  SELECT DISTINCT ON (ctp.conversation_id)
         ctp.conversation_id, ct.name, ct.phone, ctp.detected_at, msg.body
    FROM public.conversation_topics ctp
    JOIN public.insight_topics t ON t.id = ctp.topic_id AND t.workspace_id = p_workspace_id AND t.status = 'active'
    JOIN public.conversations c ON c.id = ctp.conversation_id AND c.workspace_id = p_workspace_id
    -- Mismo filtro de tenant que en get_insights. Sin él, reapuntar
    -- contact_id a un contacto ajeno devuelve su nombre y su teléfono acá.
    JOIN public.contacts ct ON ct.id = c.contact_id AND ct.workspace_id = p_workspace_id
    -- El cuerpo se lee en vivo (un mensaje multimedia llega NULL). Borrar
    -- el mensaje borra la detección (ON DELETE CASCADE).
    LEFT JOIN public.messages msg ON msg.id = ctp.evidence_message_id AND msg.workspace_id = p_workspace_id
   WHERE ctp.workspace_id = p_workspace_id
     AND ctp.topic_id = p_topic_id
     AND ctp.detected_at >= p_from AND ctp.detected_at < p_to
     AND EXISTS (
       SELECT 1 FROM public.messages m
        WHERE m.conversation_id = ctp.conversation_id
          AND m.workspace_id = p_workspace_id
          AND m.direction = 'in'
          AND m.created_at >= p_from AND m.created_at < p_to
     )
     AND CASE p_outcome
       WHEN 'booked' THEN EXISTS (
         SELECT 1 FROM public.appointments a
          WHERE a.conversation_id = ctp.conversation_id
            AND a.workspace_id = p_workspace_id
            AND a.created_at >= p_from AND a.created_at < p_to)
       WHEN 'handed_off' THEN EXISTS (
         SELECT 1 FROM public.events e
          WHERE e.conversation_id = ctp.conversation_id
            AND e.workspace_id = p_workspace_id
            AND e.type = 'state_change'
            AND e.payload->>'to' = 'handoff_pending'
            AND e.created_at >= p_from AND e.created_at < p_to)
       WHEN 'tag' THEN p_tag IS NOT NULL AND ct.tags @> ARRAY[p_tag]
       ELSE TRUE
     END
   ORDER BY ctp.conversation_id, ctp.detected_at DESC
  ) d
   ORDER BY d.detected_at DESC, d.conversation_id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$$;

CREATE OR REPLACE FUNCTION public.get_workspace_tags(p_workspace_id UUID)
RETURNS TABLE (tag TEXT)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT DISTINCT unnest(c.tags) AS tag
    FROM public.contacts c
   WHERE c.workspace_id = p_workspace_id
   ORDER BY 1
   LIMIT 200;
$$;

REVOKE ALL ON FUNCTION public.get_insights(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_insight_evidence(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, INT, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_workspace_tags(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_insights(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_insight_evidence(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, INT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_workspace_tags(UUID) TO service_role;
