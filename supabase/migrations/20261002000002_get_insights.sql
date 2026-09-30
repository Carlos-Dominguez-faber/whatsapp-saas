-- Migration: 20261002000002_get_insights
-- Lectura del dashboard de análisis. Devuelve CONTEOS; los
-- porcentajes se calculan en TypeScript. Solo service_role ejecuta: el caller
-- (src/features/analytics/services/insights.ts) verifica la membresía antes.
--
-- Derivación = evento state_change a handoff_pending: los caminos que
-- derivan pasan por applyTransition (decision-engine.ts), que lo inserta.
-- Sin índice nuevo en messages; el universo recorre los entrantes
-- del workspace en el rango. Agregar messages(workspace_id, created_at)
-- WHERE direction = 'in' si get_insights pasa de ~1 s.

-- COVERAGE. A topic's detections are complete only from its covered_from
-- (see insight_topics): before it, nothing was analysed for that topic. And a
-- conversation counts only once it has been ANALYSED: the nightly run has read
-- it up to its last customer message in the period (classified_until). So a
-- topic's share is "of the analysed conversations whose customer wrote from
-- covered_from on, how many brought it up" — a conversation still waiting, in
-- quarantine or too old to be read is neither a hit nor a miss (counting it as
-- a miss showed 40 % when 4 of the 10 asked and 6 were still unread). The
-- previous-period delta only exists when that period is covered too.
-- `analysis` says how many conversations of the period are analysed, and why
-- the rest aren't. The summary cards (conversations, bookings, handoffs)
-- don't depend on classification and keep the whole range. p_prev_from: the
-- previous period's start, computed on calendar days in the business's zone
-- (subtracting the range as an interval drifts an hour across a DST change);
-- NULL falls back to the interval.
DROP FUNCTION IF EXISTS public.get_insights(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], TEXT);

CREATE OR REPLACE FUNCTION public.get_insights(
  p_workspace_id UUID,
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
  p_tags TEXT[],
  p_tz TEXT,
  p_prev_from TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
WITH
bounds AS (
  SELECT COALESCE(p_prev_from, p_from - (p_to - p_from)) AS prev_from
),
-- Each conversation whose customer wrote in the range, with the last time
-- they did (a topic covered from mid-range counts the ones that wrote after).
universe AS (
  SELECT m.conversation_id, max(m.created_at) AS last_in
    FROM public.messages m
   WHERE m.workspace_id = p_workspace_id
     AND m.direction = 'in'
     AND m.created_at >= p_from AND m.created_at < p_to
   GROUP BY m.conversation_id
),
prev_universe AS (
  SELECT m.conversation_id, max(m.created_at) AS last_in
    FROM public.messages m, bounds b
   WHERE m.workspace_id = p_workspace_id
     AND m.direction = 'in'
     AND m.created_at >= b.prev_from AND m.created_at < p_from
   GROUP BY m.conversation_id
),
conv AS (
  SELECT u.conversation_id,
         u.last_in,
         COALESCE(cc.classified_until >= u.last_in, false) AS analyzed,
         cc.quarantined_at IS NOT NULL AS quarantined,
         cc.catalog_at,
         COALESCE(cc.backfill_topics, '{}'::uuid[]) AS backfill_topics,
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
    LEFT JOIN public.conversation_classification cc
      ON cc.conversation_id = u.conversation_id AND cc.workspace_id = p_workspace_id
),
prev_conv AS (
  SELECT pu.conversation_id,
         COALESCE(cc.classified_until >= pu.last_in, false) AS analyzed,
         cc.catalog_at,
         COALESCE(cc.backfill_topics, '{}'::uuid[]) AS backfill_topics,
         EXISTS (
           SELECT 1 FROM public.appointments a, bounds b
            WHERE a.conversation_id = pu.conversation_id
              AND a.workspace_id = p_workspace_id
              AND a.created_at >= b.prev_from AND a.created_at < p_from
         ) AS booked,
         EXISTS (
           SELECT 1 FROM public.events e, bounds b
            WHERE e.conversation_id = pu.conversation_id
              AND e.workspace_id = p_workspace_id
              AND e.type = 'state_change'
              AND e.payload->>'to' = 'handoff_pending'
              AND e.created_at >= b.prev_from AND e.created_at < p_from
         ) AS handed_off
    FROM prev_universe pu
    JOIN public.conversations c ON c.id = pu.conversation_id AND c.workspace_id = p_workspace_id
    JOIN public.contacts ct ON ct.id = c.contact_id AND ct.workspace_id = p_workspace_id
    LEFT JOIN public.conversation_classification cc
      ON cc.conversation_id = pu.conversation_id AND cc.workspace_id = p_workspace_id
),
tag_list AS (
  SELECT DISTINCT unnest(COALESCE(p_tags, '{}'::text[])) AS tag
),
topics AS (
  SELECT t.id,
         t.name,
         t.created_at,
         t.covered_from,
         -- Where this topic's measurement starts inside the range.
         GREATEST(p_from, t.covered_from) AS cov_from,
         -- The previous period is comparable only if it was covered too.
         t.covered_from <= (SELECT prev_from FROM bounds) AS prev_covered
    FROM public.insight_topics t
   WHERE t.workspace_id = p_workspace_id AND t.status = 'active'
),
-- conversation_topics tiene UNA FILA POR MENSAJE de
-- evidencia. Todo lo de abajo cuenta conversaciones DISTINTAS con al menos una
-- detección en el rango; con una fila por conversación, la primera detección
-- taparía a las siguientes y un tema recurrente desaparecería de los períodos
-- posteriores. Only analysed conversations: the same set as the denominator.
-- Analysed FOR a topic: read up to the customer's last message of the period
-- (analyzed) with that topic in the catalog (catalog_at, set by the nightly
-- run), or by the topic's own backfill (backfill_topics). A conversation the
-- backfill left out and the nightly run never read again doesn't dilute the
-- topic: it isn't in its denominator. Rows #13 wrote have no catalog: they
-- count as before.
for_topic AS (
  SELECT tp.id AS topic_id, conv.*
    FROM topics tp
    JOIN conv ON conv.analyzed
             AND conv.last_in >= tp.cov_from
             AND (conv.catalog_at IS NULL OR conv.catalog_at >= tp.created_at
                  OR tp.id = ANY (conv.backfill_topics))
),
hits AS (
  SELECT DISTINCT ctp.topic_id, conv.conversation_id, conv.booked, conv.handed_off, conv.tags
    FROM public.conversation_topics ctp
    JOIN topics tp ON tp.id = ctp.topic_id
    JOIN for_topic conv ON conv.conversation_id = ctp.conversation_id AND conv.topic_id = tp.id
   WHERE ctp.workspace_id = p_workspace_id
     AND ctp.detected_at >= tp.cov_from AND ctp.detected_at < p_to
),
prev_hits AS (
  SELECT ctp.topic_id, count(DISTINCT ctp.conversation_id) AS n
    FROM public.conversation_topics ctp
    JOIN topics tp ON tp.id = ctp.topic_id AND tp.prev_covered
    -- Sobre prev_conv (filtrado por tenant en el contacto), igual que
    -- hits usa conv. Con prev_universe crudo el numerador incluiría lo que el
    -- denominador (prev_conversations) descarta: porcentajes sobre 100 %.
    JOIN prev_conv pc ON pc.conversation_id = ctp.conversation_id AND pc.analyzed
                     AND (pc.catalog_at IS NULL OR pc.catalog_at >= tp.created_at
                          OR tp.id = ANY (pc.backfill_topics))
   WHERE ctp.workspace_id = p_workspace_id
     AND ctp.detected_at >= (SELECT prev_from FROM bounds) AND ctp.detected_at < p_from
   GROUP BY ctp.topic_id
),
-- The customer's newest message overall, for the conversations of the range
-- that aren't analysed: it decides whether the nightly run will still read
-- them (within its 30 days) or never will.
unread AS (
  SELECT conv.conversation_id, conv.quarantined, li.at AS newest_in
    FROM conv
    CROSS JOIN LATERAL (
      SELECT m.created_at AS at
        FROM public.messages m
       WHERE m.conversation_id = conv.conversation_id
         AND m.direction = 'in'
       ORDER BY m.created_at DESC
       LIMIT 1
    ) li
   WHERE NOT conv.analyzed
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
  -- The customer's first message ever in this workspace: a previous period
  -- that starts before it has no comparable data.
  'data_from', (
    SELECT min(m.created_at) FROM public.messages m
     WHERE m.workspace_id = p_workspace_id AND m.direction = 'in'
  ),
  -- Why the rest isn't being read, if the run says so: the workspace's
  -- OpenRouter key fails ('key') or it reached its daily cap ('cap'). Current
  -- when noted in the last 2 hours with no paid classification since
  -- (note_classification_blocked writes at most one an hour while it lasts).
  'blocked', (
    SELECT b.payload->>'reason'
      FROM public.events b
     WHERE b.workspace_id = p_workspace_id
       AND b.type = 'topic_classification_blocked'
       AND b.created_at > now() - INTERVAL '2 hours'
       AND NOT EXISTS (
         SELECT 1 FROM public.events ok
          WHERE ok.workspace_id = p_workspace_id
            AND ok.type = 'topic_classification'
            AND ok.created_at > b.created_at
            AND ok.payload->>'reserved' = 'false'
            AND ok.payload->>'total_tokens' ~ '^[1-9][0-9]{0,11}$')
     ORDER BY b.created_at DESC
     LIMIT 1
  ),
  'analysis', jsonb_build_object(
    'conversations', (SELECT count(*) FROM conv),
    'analyzed', (SELECT count(*) FROM conv WHERE conv.analyzed),
    -- Failed three times: set aside until the customer writes again.
    'failed', (SELECT count(*) FROM unread WHERE unread.quarantined),
    -- Past the nightly run's 30 days: they will never be read.
    'too_old', (SELECT count(*) FROM unread
                 WHERE NOT unread.quarantined AND unread.newest_in < now() - INTERVAL '30 days'),
    -- Still in line (or the customer wrote in the last hour).
    'pending', (SELECT count(*) FROM unread
                 WHERE NOT unread.quarantined AND unread.newest_in >= now() - INTERVAL '30 days')
  ),
  'topics', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', tp.id,
      'name', tp.name,
      'covered_from', CASE WHEN tp.covered_from > p_from THEN tp.covered_from END,
      -- The topic's denominator: analysed conversations whose customer wrote
      -- while it was covered; `in_coverage` also counts the unread ones.
      'universe', (SELECT count(*) FROM for_topic ft WHERE ft.topic_id = tp.id),
      'in_coverage', (SELECT count(*) FROM conv WHERE conv.last_in >= tp.cov_from),
      'conversations', (SELECT count(*) FROM hits h WHERE h.topic_id = tp.id),
      -- NULL, not 0, when the previous period wasn't covered: no delta.
      'prev_universe', CASE WHEN tp.prev_covered
                         THEN (SELECT count(*) FROM prev_conv
                                WHERE prev_conv.analyzed
                                  AND (prev_conv.catalog_at IS NULL OR prev_conv.catalog_at >= tp.created_at
                                       OR tp.id = ANY (prev_conv.backfill_topics)))
                       END,
      'prev_conversations', CASE WHEN tp.prev_covered
                              THEN COALESCE((SELECT ph.n FROM prev_hits ph WHERE ph.topic_id = tp.id), 0)
                            END,
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
          JOIN topics tp ON tp.id = ctp.topic_id
          JOIN for_topic conv ON conv.conversation_id = ctp.conversation_id AND conv.topic_id = tp.id
         WHERE ctp.workspace_id = p_workspace_id
           AND ctp.detected_at >= tp.cov_from AND ctp.detected_at < p_to
         GROUP BY ctp.topic_id, 2
      ) w
  ), '[]'::jsonb),
  -- Conversaciones analizadas del universo con texto del cliente que no
  -- llegó entero al LLM (tope de 60 mensajes o cuerpo recortado a 800
  -- caracteres) con fecha dentro del rango. Límite declarado; la UI lo avisa.
  'partial_conversations', (
    SELECT count(*)
      FROM conv
      JOIN public.conversation_classification cc
        ON cc.conversation_id = conv.conversation_id AND cc.workspace_id = p_workspace_id
     WHERE conv.analyzed AND cc.partial_from < p_to AND cc.partial_until >= p_from
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
     -- The cell counted from the topic's coverage on, and only analysed
     -- conversations (get_insights); the list behind it holds the same ones.
     AND ctp.detected_at >= GREATEST(p_from, t.covered_from) AND ctp.detected_at < p_to
     AND EXISTS (
       SELECT 1 FROM public.conversation_classification cc
        WHERE cc.conversation_id = ctp.conversation_id
          AND cc.workspace_id = p_workspace_id
          AND (cc.catalog_at IS NULL OR cc.catalog_at >= t.created_at OR t.id = ANY (cc.backfill_topics))
          AND cc.classified_until >= (
            SELECT max(m2.created_at) FROM public.messages m2
             WHERE m2.conversation_id = ctp.conversation_id
               AND m2.workspace_id = p_workspace_id
               AND m2.direction = 'in'
               AND m2.created_at >= p_from AND m2.created_at < p_to))
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

REVOKE ALL ON FUNCTION public.get_insights(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_insight_evidence(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, INT, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_workspace_tags(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_insights(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], TEXT, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_insight_evidence(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, INT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_workspace_tags(UUID) TO service_role;
