-- ============================================================
-- Migration: 20260903000000_automation_engine
-- Motor de automatizaciones — outbox transaccional: la captura del evento
-- ocurre en la misma transacción que la escritura origen, y la expansión y
-- ejecución las hace el cron /api/cron/automations.
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- 1. Versiones de ocurrencia
--
-- La ocurrencia se identifica por VERSIÓN, nunca por updated_at:
-- trg_contacts_updated_at (20260608000000_foundation.sql:199-201) renueva
-- updated_at con CUALQUIER update — incluida la etiqueta que escribe la propia
-- automatización. Con updated_at en la clave, `lead_qualified -> add_tag` es un
-- bucle infinito con cobro por vuelta.
-- ──────────────────────────────────────────────────────────
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS stage_version INT NOT NULL DEFAULT 0;

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS state_version INT NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.bump_contact_stage_version()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.stage IS DISTINCT FROM OLD.stage THEN
    NEW.stage_version := OLD.stage_version + 1;
  ELSE
    NEW.stage_version := OLD.stage_version;  -- no movible a mano
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.bump_conversation_state_version()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    NEW.state_version := OLD.state_version + 1;
  ELSE
    NEW.state_version := OLD.state_version;  -- no movible a mano
  END IF;
  RETURN NEW;
END;
$$;

-- SIN `OF stage` / `OF state`, por el mismo motivo que
-- trg_automation_rules_enabled_since (sección 2): estas dos columnas SON la clave de
-- idempotencia del motor — van como `occurrence` en handoff_requested y
-- lead_qualified. Las policies que gobiernan estas tablas no están acotadas por
-- columna ("ws operators write contacts" FOR ALL y "ws agents update
-- conversations" FOR UPDATE, 20260608000000_foundation.sql:661-663 y :679-681),
-- así que con `OF <campo>` un miembro del workspace podía hacer PATCH
-- {"state_version": 1} sin mencionar `state`, saltarse el trigger y dejar la
-- versión en un valor ya usado. El siguiente handoff real emitía un evento cuyo
-- UNIQUE (event_type, subject_id, occurrence) ya existía, el ON CONFLICT DO
-- NOTHING lo tragaba y la automatización no disparaba, sin rastro.
--
-- Corriendo en TODO UPDATE, la rama ELSE restaura OLD y la columna deja de ser
-- escribible desde PostgREST. El cuerpo es una asignación pura — sin I/O, sin
-- consultas — porque contacts y conversations son tablas calientes.
--
-- Va BEFORE para que el trigger AFTER de emisión ya lea la versión nueva en NEW.
-- No cubre INSERT a propósito: en un INSERT no hay OLD, y el valor inicial que
-- traiga la fila solo corre el contador hacia adelante sobre un sujeto que
-- todavía no tiene ningún evento — no puede colisionar con uno existente.
DROP TRIGGER IF EXISTS trg_contacts_stage_version ON public.contacts;
CREATE TRIGGER trg_contacts_stage_version
  BEFORE UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.bump_contact_stage_version();

DROP TRIGGER IF EXISTS trg_conversations_state_version ON public.conversations;
CREATE TRIGGER trg_conversations_state_version
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.bump_conversation_state_version();

-- ──────────────────────────────────────────────────────────
-- 2. automation_rules.enabled_since
--
-- Piso temporal de la regla. Se mueve SOLO cuando la regla pasa a habilitada,
-- y ese reloj es el de Postgres — el mismo que llena
-- automation_events.occurred_at. Solo comparar dos marcas del MISMO reloj es
-- confiable; un reloj del cliente no lo es.
--
-- clock_timestamp() y NO NOW(). NOW() (= transaction_timestamp()) es fijo
-- durante toda la transacción: deshabilitar y reactivar dentro del mismo BEGIN
-- dejaba enabled_since IDÉNTICO, y en una transacción larga quedaba anterior a
-- eventos ya commiteados por otras sesiones. clock_timestamp() lee el reloj en
-- el instante de la sentencia. En la práctica todos los escritores de
-- automation_rules.enabled son sentencias autocommit de PostgREST (la ruta de
-- API y las server actions de automation-actions.ts), así que la ventana real
-- es la duración de un UPDATE.
--
-- Consecuencia deliberada: renombrar la regla, cambiar la
-- plantilla o cambiar la acción NO toca enabled_since y por lo tanto NO
-- invalida runs ya expandidos.
-- ──────────────────────────────────────────────────────────
ALTER TABLE public.automation_rules
  ADD COLUMN IF NOT EXISTS enabled_since TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.set_automation_rule_enabled_since()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.enabled_since := CASE WHEN NEW.enabled THEN clock_timestamp() ELSE NULL END;
    RETURN NEW;
  END IF;

  IF NEW.enabled AND NOT OLD.enabled THEN
    NEW.enabled_since := clock_timestamp();  -- reactivada: nunca dispara hacia atrás
  ELSIF NOT NEW.enabled THEN
    NEW.enabled_since := NULL;           -- deshabilitada: deja de ser candidata
  ELSE
    NEW.enabled_since := OLD.enabled_since;  -- seguía habilitada: no se mueve
  END IF;
  RETURN NEW;
END;
$$;

-- Backfill: las reglas ya habilitadas valen desde que se crearon. Sin esto,
-- enabled_since queda NULL y ruleAppliesTo() (expand.ts) las descarta todas, con
-- lo que el motor arranca sin disparar nada.
--
-- ORDEN: el backfill va ANTES del CREATE TRIGGER. El trigger ya no lleva
-- `OF enabled`, así que corre en cualquier UPDATE de la tabla y su rama ELSE
-- restauraría OLD.enabled_since (NULL) sobre este mismo UPDATE, dejándolo en
-- nada. No reordenar.
UPDATE public.automation_rules
   SET enabled_since = created_at
 WHERE enabled AND enabled_since IS NULL;

-- SIN `OF enabled`: el trigger corre en TODO UPDATE de automation_rules. Con
-- `OF enabled` solo se evaluaba cuando la columna aparecía en el SET, y la
-- policy "ws admins manage automations" (20260609000002_automation_rules.sql)
-- es FOR ALL: un admin del workspace podía hacer PATCH
-- {"enabled_since": "2020-01-01"} sin tocar `enabled`, saltarse el trigger y
-- dejar que el motor reejecutara todo el histórico de eventos del tenant, con
-- costo real por envío. Corriendo siempre, la rama ELSE (misma que preserva el
-- valor al renombrar) restaura OLD.enabled_since y la columna deja de ser
-- escribible desde PostgREST. El INSERT no cambia: el `OF` nunca aplicó a
-- INSERT.
--
-- AL DÍA (20260904000000_automation_rules_write_service_role_only): esa policy
-- FOR ALL ya no existe, así que el PATCH directo a PostgREST tampoco. El
-- trigger sin `OF` sigue igual y a propósito — es defensa en profundidad y la
-- clave de idempotencia del motor, no un residuo de la policy vieja. No
-- devolverle el `OF`.
DROP TRIGGER IF EXISTS trg_automation_rules_enabled_since ON public.automation_rules;
CREATE TRIGGER trg_automation_rules_enabled_since
  BEFORE INSERT OR UPDATE ON public.automation_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_automation_rule_enabled_since();

-- Índice del EXISTS de los tres triggers de emisión: es la única consulta que
-- corre DENTRO de la transacción del mensaje entrante, así que tiene que ser
-- un index scan y no un seq scan sobre las reglas del tenant.
CREATE INDEX IF NOT EXISTS idx_automation_rules_enabled_type
  ON public.automation_rules (workspace_id, trigger_type)
  WHERE enabled;

-- ──────────────────────────────────────────────────────────
-- 3. automation_events — outbox transaccional
--
-- Lo escriben SOLO los triggers de emisión, en la misma transacción que la
-- escritura origen. Lo lee y lo marca expandido el paso TypeScript
-- expandAutomationEvents() (expand.ts).
--
-- occurrence es TEXT y no INT porque los cuatro tipos la construyen distinto:
-- '1' para los que ocurren una vez por sujeto, y la versión para los que pueden
-- repetirse. UNIQUE (event_type, subject_id, occurrence) es toda la
-- idempotencia de la captura: un wamid repetido, un UPDATE que reescribe el
-- mismo estado o dos writers concurrentes no fabrican un segundo evento.
--
-- expanded_at es NULL mientras el evento espera expansión. El índice parcial
-- WHERE expanded_at IS NULL mantiene la lectura del cron proporcional a lo
-- PENDIENTE y no al histórico (la tabla no se purga).
--
-- El índice lleva workspace_id DELANTE de id porque la expansión no lee una
-- cola global: lista los workspaces con pendientes y después lee la cola DE
-- CADA UNO. Con (id) solo, ese segundo paso sería un filtro sobre el índice
-- global en vez de un rango.
--
-- expand_attempts / expand_error son el tope de reintentos de la expansión.
-- Un evento venenoso (uno cuyo upsert de runs falla siempre) volvería a
-- encabezar la cola de su workspace en cada tick y la dejaría atascada para
-- siempre. Al tercer intento fallido se cierra con expand_error y deja de
-- leerse: lo saca de la cola el CONTADOR (expand_attempts >=
-- MAX_EXPAND_ATTEMPTS), no expanded_at, que se queda NULL a propósito
-- para que la fila quede en cuarentena
-- revisable y no se confunda con un evento expandido con éxito. expand_error
-- guarda un CÓDIGO, no el mensaje de PostgREST: la tabla la leen los
-- miembros del workspace.
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.automation_events (
  id              BIGSERIAL PRIMARY KEY,
  workspace_id    UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL CHECK (event_type IN (
                    'first_message','inbound_message','handoff_requested','lead_qualified')),
  subject_id      UUID NOT NULL,
  occurrence      TEXT NOT NULL,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  contact_id      UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  message_id      UUID REFERENCES public.messages(id) ON DELETE SET NULL,
  -- clock_timestamp() y no NOW(). Dentro de una transacción que escribe
  -- varias filas, NOW() las sella todas con el mismo instante y el orden
  -- respecto de automation_rules.enabled_since deja de ser observable.
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expanded_at     TIMESTAMPTZ,
  expand_attempts INT NOT NULL DEFAULT 0,
  expand_error    TEXT,
  UNIQUE (event_type, subject_id, occurrence)
);

CREATE INDEX IF NOT EXISTS idx_automation_events_pending
  ON public.automation_events (workspace_id, id)
  WHERE expanded_at IS NULL;

-- Índices de las FK ON DELETE SET NULL. Postgres NO los crea solo, y sin ellos
-- cada borrado de una conversación, un contacto o un mensaje hace un seq scan
-- sobre una tabla que no se purga nunca. Borrar datos personales puede ser una
-- obligación legal, así que ese camino tiene que seguir siendo barato cuando
-- la tabla pese.
-- workspace_id necesita su PROPIO índice: idx_automation_events_pending es
-- PARCIAL (WHERE expanded_at IS NULL) y deja fuera justo a la mayoría de las
-- filas — las ya expandidas, que no se purgan nunca. Sin este índice,
-- tanto el CASCADE del borrado de un workspace como el DELETE ... WHERE
-- workspace_id = $1 del borrado de datos personales son seq scans
-- sobre la tabla más grande del motor. El caso simétrico de automation_runs ya
-- lo cubre idx_automation_runs_ws_claimed, que no es parcial.
CREATE INDEX IF NOT EXISTS idx_automation_events_workspace
  ON public.automation_events (workspace_id);
CREATE INDEX IF NOT EXISTS idx_automation_events_conversation
  ON public.automation_events (conversation_id);
CREATE INDEX IF NOT EXISTS idx_automation_events_contact
  ON public.automation_events (contact_id);
CREATE INDEX IF NOT EXISTS idx_automation_events_message
  ON public.automation_events (message_id);

ALTER TABLE public.automation_events ENABLE ROW LEVEL SECURITY;

-- Lectura para miembros del workspace (el panel muestra la traza). Sin policy
-- de escritura a propósito: escriben los triggers (SECURITY DEFINER) y el cron
-- (service_role, que salta RLS).
DROP POLICY IF EXISTS "ws members read automation_events" ON public.automation_events;
CREATE POLICY "ws members read automation_events" ON public.automation_events
  FOR SELECT USING (workspace_id IN (SELECT auth_workspace_ids()));

-- ──────────────────────────────────────────────────────────
-- 4. automation_runs — cola de ejecución
--
-- Una fila = una regla que le toca a un evento. La identidad es
-- UNIQUE (rule_id, event_id): eso es lo que hace idempotente a la expansión
-- entre dos instancias del cron solapadas, sin lock.
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.automation_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  rule_id         UUID NOT NULL REFERENCES public.automation_rules(id) ON DELETE CASCADE,
  -- RESTRICT y no CASCADE: automation_runs NO se cascadea desde eventos; con
  -- CASCADE, una futura purga de automation_events borraría el historial de
  -- ejecución en silencio. Con RESTRICT, esa purga tiene que decidir
  -- explícitamente qué hace con los runs.
  event_id        BIGINT NOT NULL REFERENCES public.automation_events(id) ON DELETE RESTRICT,
  trigger_type    TEXT NOT NULL,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  contact_id      UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','done','failed','skipped')),
  attempts        INT NOT NULL DEFAULT 0,
  error           TEXT,
  -- Backoff entre reintentos. Un error transitorio devuelve la fila a 'pending'
  -- con not_before = now() + 2^attempts minutos; sin esta columna el mismo tick
  -- la re-reclamaría en el acto y quemaría los 3 intentos contra un servicio
  -- que sigue caído.
  not_before      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Token de lease: lo devuelve el claim y va en el WHERE de cada escritura.
  claimed_at      TIMESTAMPTZ,
  -- Efecto externo (Kapso) ya iniciado. El UNIQUE protege la FILA, no el
  -- EFECTO: sin esta columna, un worker que muere entre el envío y el cierre
  -- deja la fila reclamable y el reintento vuelve a mandar el WhatsApp.
  dispatched_at   TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (rule_id, event_id)
);

-- Camino caliente del reclamo: "lo que todavía puede correr".
CREATE INDEX IF NOT EXISTS idx_automation_runs_claimable
  ON public.automation_runs (status, not_before)
  WHERE status IN ('pending','processing');

-- El ORDER BY del reclamo pregunta MAX(claimed_at) por workspace. Sin este
-- índice, ese MAX es un seq scan por cada candidato evaluado.
CREATE INDEX IF NOT EXISTS idx_automation_runs_ws_claimed
  ON public.automation_runs (workspace_id, claimed_at DESC);

-- Lectura del panel por workspace.
CREATE INDEX IF NOT EXISTS idx_automation_runs_workspace
  ON public.automation_runs (workspace_id, created_at DESC);

-- Índices de las FK restantes, por el mismo motivo que en automation_events.
-- rule_id ya queda cubierto por el prefijo del UNIQUE (rule_id, event_id);
-- event_id NO, porque va en segunda posición — y su FK es ON DELETE RESTRICT,
-- que obliga a mirar esta tabla en cada borrado de evento.
CREATE INDEX IF NOT EXISTS idx_automation_runs_event
  ON public.automation_runs (event_id);
CREATE INDEX IF NOT EXISTS idx_automation_runs_conversation
  ON public.automation_runs (conversation_id);
CREATE INDEX IF NOT EXISTS idx_automation_runs_contact
  ON public.automation_runs (contact_id);

ALTER TABLE public.automation_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ws members read automation_runs" ON public.automation_runs;
CREATE POLICY "ws members read automation_runs" ON public.automation_runs
  FOR SELECT USING (workspace_id IN (SELECT auth_workspace_ids()));

-- ──────────────────────────────────────────────────────────
-- 5. Triggers de emisión
--
-- Los tres son SECURITY DEFINER SET search_path = '' y los tres llevan el mismo
-- guard de excepción. SECURITY DEFINER porque `stage` también lo escriben rutas
-- con sesión de usuario bajo RLS (api/contacts/[id]/route.ts:68) y
-- automation_events no tiene policy de escritura.
--
-- El guard EXCEPTION es una decisión explícita, no un descuido: un bug del
-- trigger NO PUEDE bloquear la entrada de un mensaje ni un handoff. El precio,
-- solo en ese caso, es que la automatización se pierde con aviso en el log de
-- Postgres. En el camino normal la captura sigue siendo atómica con la
-- escritura origen.
--
-- OTHERS no cubre cancelaciones ni timeouts; en ese caso la sentencia
-- completa aborta, que es lo esperado. El cuerpo del trigger es un EXISTS
-- indexado + un INSERT con ON CONFLICT DO NOTHING y no espera locks largos.
-- Tragar un query_canceled convertiría un statement_timeout o un
-- pg_cancel_backend en un éxito parcial: el UPDATE de negocio revertido y el
-- operador creyendo que pasó. Por eso NO se agrega WHEN QUERY_CANCELED.
--
-- La lógica de reglas NO entra al trigger: solo un EXISTS indexado sobre
-- automation_rules por (workspace_id, trigger_type) WHERE enabled. El matcher
-- de keywords y la evaluación de enabled_since viven en TypeScript, donde hay
-- suite de tests.
-- ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.emit_automation_event_on_message()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_conv_created_at TIMESTAMPTZ;
  v_contact_id      UUID;
BEGIN
  SELECT c.created_at, c.contact_id
    INTO v_conv_created_at, v_contact_id
    FROM public.conversations c
   WHERE c.id = NEW.conversation_id;

  IF v_conv_created_at IS NULL THEN
    RETURN NULL;   -- conversación borrada en la misma transacción: nada que emitir
  END IF;

  -- first_message: es la PRIMERA vez que el contacto escribe en esta
  -- conversación, o sea que no hay ningún entrante anterior. No se mira cuándo
  -- nació la conversación: una abierta por un envío saliente (plantilla o
  -- campaña) y contestada media hora después es literalmente el primer mensaje
  -- del contacto, y una ventana temporal la dejaba fuera.
  --
  -- El NOT EXISTS recorre idx_messages_conversation (conversation_id,
  -- created_at DESC) y excluye la propia fila: el trigger es AFTER INSERT, así
  -- que NEW ya está en la tabla.
  --
  -- ORDEN DE LOS DOS CONJUNTOS: primero el EXISTS sobre automation_rules y
  -- DESPUÉS el NOT EXISTS sobre messages. El AND evalúa a la izquierda primero,
  -- así que con el orden inverso TODO mensaje entrante de TODO workspace pagaba
  -- el scan sobre messages dentro de su propia transacción, incluso en tenants
  -- sin ninguna regla first_message. El EXISTS de reglas es el filtro barato
  -- (índice parcial idx_automation_rules_enabled_type) y el selectivo.
  --
  -- El UNIQUE (first_message, conversation_id, '1') NO reemplaza al chequeo
  -- sobre messages: al desplegar, una conversación histórica cuyo contacto ya
  -- escribió no tiene evento previo, y sin el NOT EXISTS su siguiente entrante
  -- emitiría un first_message falso. El UNIQUE sigue haciendo falta para el caso
  -- contrario: dos entrantes insertados en la MISMA transacción, donde ninguno
  -- ve al otro.
  IF EXISTS (
       SELECT 1 FROM public.automation_rules r
        WHERE r.workspace_id = NEW.workspace_id
          AND r.enabled
          AND r.trigger_type = 'first_message'
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.messages m
        WHERE m.conversation_id = NEW.conversation_id
          AND m.direction = 'in'
          AND m.id <> NEW.id
     )
  THEN
    INSERT INTO public.automation_events
      (workspace_id, event_type, subject_id, occurrence,
       conversation_id, contact_id, message_id, occurred_at)
    VALUES
      (NEW.workspace_id, 'first_message', NEW.conversation_id, '1',
       NEW.conversation_id, v_contact_id, NEW.id, NEW.created_at)
    ON CONFLICT (event_type, subject_id, occurrence) DO NOTHING;
  END IF;

  -- inbound_message: un evento por mensaje entrante, y SOLO si el workspace
  -- tiene alguna regla keyword_match habilitada. Sin ese EXISTS, cada mensaje
  -- de cada tenant escribiría una fila que nadie consume.
  IF EXISTS (
       SELECT 1 FROM public.automation_rules r
        WHERE r.workspace_id = NEW.workspace_id
          AND r.enabled
          AND r.trigger_type = 'keyword_match'
     )
  THEN
    INSERT INTO public.automation_events
      (workspace_id, event_type, subject_id, occurrence,
       conversation_id, contact_id, message_id, occurred_at)
    VALUES
      (NEW.workspace_id, 'inbound_message', NEW.id, '1',
       NEW.conversation_id, v_contact_id, NEW.id, NEW.created_at)
    ON CONFLICT (event_type, subject_id, occurrence) DO NOTHING;
  END IF;

  RETURN NULL;
-- OTHERS no cubre cancelaciones ni timeouts; en ese caso la sentencia
-- completa aborta, que es lo esperado. El cuerpo del trigger es un EXISTS
-- indexado + un INSERT con ON CONFLICT DO NOTHING y no espera locks largos.
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'automation_event_failed: %', SQLERRM;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.emit_automation_event_on_state()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM public.automation_rules r
        WHERE r.workspace_id = NEW.workspace_id
          AND r.enabled
          AND r.trigger_type = 'handoff_requested'
     )
  THEN
    -- occurred_at NO se pasa. Lo pone el DEFAULT clock_timestamp() de la
    -- columna. Con NOW() explícito (= transaction_timestamp()) el evento
    -- quedaría sellado con el inicio de la transacción mientras enabled_since
    -- usa clock_timestamp(): dos relojes distintos, y un evento podría
    -- quedar por debajo de un enabled_since posterior y perderse en silencio
    -- en la expansión.
    INSERT INTO public.automation_events
      (workspace_id, event_type, subject_id, occurrence,
       conversation_id, contact_id, message_id)
    VALUES
      (NEW.workspace_id, 'handoff_requested', NEW.id, NEW.state_version::text,
       NEW.id, NEW.contact_id, NULL)
    ON CONFLICT (event_type, subject_id, occurrence) DO NOTHING;
  END IF;

  RETURN NULL;
-- OTHERS no cubre cancelaciones ni timeouts; en ese caso la sentencia
-- completa aborta, que es lo esperado. El cuerpo del trigger es un EXISTS
-- indexado + un INSERT con ON CONFLICT DO NOTHING y no espera locks largos.
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'automation_event_failed: %', SQLERRM;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.emit_automation_event_on_stage()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM public.automation_rules r
        WHERE r.workspace_id = NEW.workspace_id
          AND r.enabled
          AND r.trigger_type = 'lead_qualified'
     )
  THEN
    -- conversation_id NULL a propósito: un contacto puede tener varias
    -- conversaciones y elegir una acá sería adivinar. La resuelve el ejecutor
    -- (executor.ts), que toma la más reciente del contacto.
    -- occurred_at NO se pasa; lo pone el DEFAULT clock_timestamp(). Mismo
    -- motivo que en emit_automation_event_on_state: NOW() mezclaría relojes con
    -- automation_rules.enabled_since.
    INSERT INTO public.automation_events
      (workspace_id, event_type, subject_id, occurrence,
       conversation_id, contact_id, message_id)
    VALUES
      (NEW.workspace_id, 'lead_qualified', NEW.id, NEW.stage_version::text,
       NULL, NEW.id, NULL)
    ON CONFLICT (event_type, subject_id, occurrence) DO NOTHING;
  END IF;

  RETURN NULL;
-- OTHERS no cubre cancelaciones ni timeouts; en ese caso la sentencia
-- completa aborta, que es lo esperado. El cuerpo del trigger es un EXISTS
-- indexado + un INSERT con ON CONFLICT DO NOTHING y no espera locks largos.
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'automation_event_failed: %', SQLERRM;
  RETURN NULL;
END;
$$;

-- El WHEN va en la DEFINICIÓN del trigger, no dentro de la función: así
-- Postgres ni siquiera entra a plpgsql para el 99% de las filas (todo mensaje
-- saliente, todo UPDATE que no cambia el campo).
--
-- ON CONFLICT DO NOTHING en el upsert de messages (normalizer.ts:133-148) hace
-- que un wamid repetido NO dispare este trigger: Postgres no ejecuta triggers
-- AFTER INSERT para filas omitidas por el conflicto.
DROP TRIGGER IF EXISTS trg_messages_automation_event ON public.messages;
CREATE TRIGGER trg_messages_automation_event
  AFTER INSERT ON public.messages
  FOR EACH ROW
  WHEN (NEW.direction = 'in')
  EXECUTE FUNCTION public.emit_automation_event_on_message();

DROP TRIGGER IF EXISTS trg_conversations_automation_event ON public.conversations;
CREATE TRIGGER trg_conversations_automation_event
  AFTER UPDATE OF state ON public.conversations
  FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state AND NEW.state = 'handoff_pending')
  EXECUTE FUNCTION public.emit_automation_event_on_state();

DROP TRIGGER IF EXISTS trg_contacts_automation_event ON public.contacts;
CREATE TRIGGER trg_contacts_automation_event
  AFTER UPDATE OF stage ON public.contacts
  FOR EACH ROW
  WHEN (OLD.stage IS DISTINCT FROM NEW.stage AND NEW.stage = 'qualified')
  EXECUTE FUNCTION public.emit_automation_event_on_stage();

-- ──────────────────────────────────────────────────────────
-- 6. claim_next_automation_run() — reclamo con lease
--
-- Calcada de claim_next_batch() (20260608000002_buffer_rpc.sql):
-- SECURITY DEFINER + SET search_path = '' + FOR UPDATE SKIP LOCKED, el único
-- modo correcto de que dos workers del cron no tomen la misma fila.
--
-- Elegibles:
--   a) status = 'pending' con not_before <= NOW()   (respeta el backoff)
--   b) status = 'processing' con claimed_at de hace más de 7 min (worker muerto)
--
-- SIETE minutos: maxDuration de la ruta del cron es 60 s, así que el
-- lease queda muy por encima del techo de vida de un worker. Un lease cercano
-- al maxDuration trata como "atascado" a un worker que todavía está vivo ante
-- cualquier drift de reloj (mismo criterio que
-- 20260902000000_claim_next_batch_counts_stale_retries.sql).
-- No bajarlo sin bajar antes maxDuration.
--
-- SIN cursor por parámetro. El round-robin no vive en un cursor que se
-- pierde entre ticks: vive en los DATOS. Se ordena por el workspace cuyo
-- reclamo más antiguo sea el más viejo (MAX(claimed_at) ASC NULLS FIRST), así
-- que cada reclamo manda al workspace servido al final de la cola y eso
-- sobrevive al tope de 20 por tick, al tick siguiente y a varias instancias
-- corriendo a la vez.
--
-- Si la fila elegible ya acumuló 3 intentos se marca 'failed' y el bucle SIGUE
-- CON LA SIGUIENTE: devolver vacío ahí sería un bug de drenaje, porque
-- drainAutomationRuns corta apenas la RPC no devuelve nada y una sola fila
-- agotada al frente dejaría sin ejecutar toda la cola de atrás. Tope duro de 50
-- descartes por llamada; el tick siguiente retoma.
--
-- Al descartar hace dos cosas más:
--   a) el error NO siempre es 'max_attempts'. Con dispatched_at el efecto
--      externo salió y su resultado es desconocido: eso es 'outcome_unknown'.
--   b) escribe el evento automation_failed, porque estas filas nunca pasan por
--      finish() del ejecutor y sin esto desaparecen del panel.
-- ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.claim_next_automation_run()
RETURNS SETOF public.automation_runs
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_run       public.automation_runs;
  v_action    TEXT;
  v_reason    TEXT;
  v_discarded INT := 0;
BEGIN
  LOOP
    SELECT r.*
      INTO v_run
    FROM public.automation_runs r
    WHERE (r.status = 'pending' AND r.not_before <= NOW())
       OR (r.status = 'processing' AND r.claimed_at < NOW() - INTERVAL '7 minutes')
    ORDER BY (
               SELECT MAX(r2.claimed_at)
                 FROM public.automation_runs r2
                WHERE r2.workspace_id = r.workspace_id
             ) ASC NULLS FIRST,
             r.created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    -- Cola vacía, todo en backoff, o todo tomado por otro worker.
    IF v_run.id IS NULL THEN
      RETURN;
    END IF;

    IF v_run.attempts >= 3 THEN
      v_reason := CASE
                    WHEN v_run.dispatched_at IS NOT NULL THEN 'outcome_unknown'
                    ELSE 'max_attempts'
                  END;

      UPDATE public.automation_runs
         SET status      = 'failed',
             error       = v_reason,
             finished_at = NOW()
       WHERE id = v_run.id;

      SELECT r.action_type INTO v_action
        FROM public.automation_rules r
       WHERE r.id = v_run.rule_id;

      INSERT INTO public.events (workspace_id, conversation_id, type, level, payload)
      VALUES (
        v_run.workspace_id,
        v_run.conversation_id,
        'automation_failed',
        'error',
        jsonb_build_object(
          'rule_id',      v_run.rule_id,
          'run_id',       v_run.id,
          'event_id',     v_run.event_id,
          'trigger_type', v_run.trigger_type,
          'action_type',  v_action,
          'reason',       v_reason
        )
      );

      v_discarded := v_discarded + 1;
      IF v_discarded >= 50 THEN
        RETURN;   -- suficiente limpieza por llamada
      END IF;
      CONTINUE;   -- ← la clave: no cortar el drenaje por una fila agotada
    END IF;

    RETURN QUERY
    UPDATE public.automation_runs
       SET status     = 'processing',
           attempts   = v_run.attempts + 1,
           claimed_at = NOW()
     WHERE id = v_run.id
    RETURNING public.automation_runs.*;
    RETURN;
  END LOOP;
END;
$$;

-- ──────────────────────────────────────────────────────────
-- 7. append_contact_tags(workspace, contact, tags[])
--
-- Agrega etiquetas en UN solo UPDATE atómico e idempotente. Un
-- read-modify-write sobre contacts.tags (el post_action del setter en
-- buffer.ts, auto-tagging.ts, la acción add_tag del motor) pierde datos: dos
-- escrituras concurrentes leen el mismo array y la última borra la etiqueta de
-- la otra. Por eso esos escritores pasan por esta RPC.
--
-- Acepta un ARRAY porque auto-tagging escribe hasta 3 etiquetas de una vez.
--
-- Las salidas se llaman contact_found / tags_added, NO found / added:
-- `found` es la variable implícita de PL/pgSQL que se usa dos líneas más abajo
-- (`IF NOT FOUND`), y con el OUT param llamándose igual el IF leería el OUT
-- param (siempre NULL) en vez del estado del SELECT.
--
-- El filtro por workspace_id va en el WHERE porque la función es SECURITY
-- DEFINER (salta RLS) y su llamador es un motor desatendido.
-- ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.append_contact_tags(
  p_workspace_id UUID,
  p_contact_id   UUID,
  p_tags         TEXT[]
)
RETURNS TABLE (contact_found BOOLEAN, tags_added INT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_before TEXT[];
  v_after  TEXT[];
  v_clean  TEXT[];
BEGIN
  -- FOR UPDATE: bloquea la fila hasta el COMMIT, así que dos llamadas
  -- concurrentes se serializan y ninguna calcula tags_added sobre un array
  -- viejo.
  SELECT c.tags
    INTO v_before
    FROM public.contacts c
   WHERE c.id = p_contact_id
     AND c.workspace_id = p_workspace_id
     FOR UPDATE;

  IF NOT FOUND THEN
    contact_found := FALSE; tags_added := 0; RETURN NEXT; RETURN;
  END IF;

  v_before := COALESCE(v_before, ARRAY[]::TEXT[]);

  -- Recorta, descarta vacías y deduplica la entrada antes de comparar.
  SELECT COALESCE(array_agg(DISTINCT btrim(t)), ARRAY[]::TEXT[])
    INTO v_clean
    FROM unnest(COALESCE(p_tags, ARRAY[]::TEXT[])) AS t
   WHERE length(btrim(t)) > 0;

  IF cardinality(v_clean) = 0 THEN
    contact_found := TRUE; tags_added := 0; RETURN NEXT; RETURN;
  END IF;

  v_after := v_before || ARRAY(
    SELECT t FROM unnest(v_clean) AS t WHERE NOT (v_before @> ARRAY[t])
  );

  IF cardinality(v_after) > cardinality(v_before) THEN
    UPDATE public.contacts
       SET tags = v_after
     WHERE id = p_contact_id
       AND workspace_id = p_workspace_id;
  END IF;

  contact_found := TRUE;
  tags_added    := cardinality(v_after) - cardinality(v_before);
  RETURN NEXT;
END;
$$;

-- ──────────────────────────────────────────────────────────
-- 7b. mark_automation_run_dispatched(run)
--
-- Marca el efecto externo como iniciado Y comprueba el opt-in del contacto EN
-- LA MISMA SENTENCIA. En dos pasos (el ejecutor lee contacts.opt_in, después
-- marca dispatched_at y recién después hace el POST a Kapso), un opt-out que
-- entrara entre la lectura y el POST no lo vería nadie y el WhatsApp saldría
-- igual.
--
-- El opt-in se mira sobre el contacto DE LA CONVERSACIÓN del run, no sobre
-- run.contact_id: es el mismo criterio del ejecutor (el contacto del run
-- puede ser el sujeto del evento, la conversación es a quién se le escribe).
--
-- Devuelve TEXT y no BOOLEAN porque el ejecutor necesita distinguir tres
-- desenlaces que terminan en estados distintos:
--   'ok'                 -> siga, mande el mensaje
--   'opted_out'          -> skipped: opted_out       (no es un error)
--   'already_dispatched' -> failed: outcome_unknown  (el efecto ya salió una vez)
--   'not_found'          -> outcome: lost (la fila ya no está en 'processing':
--                           otro worker la cerró — done/failed/skipped — o ya no
--                           existe; no se escribe nada más sobre ella)
--
-- 'not_found' NO significa "se venció el lease". Un run cuyo lease venció y fue
-- re-reclamado sigue en status='processing', así que el worker viejo recibe 'ok'
-- o 'already_dispatched', nunca 'not_found'. El at-most-once del efecto externo
-- lo garantiza `dispatched_at IS NULL` en el WHERE del UPDATE, no el lease.
--
-- La ventana que QUEDA es la del POST mismo (la red): un opt-out que llega
-- mientras el request está en vuelo se atiende en el envío siguiente. Se acepta
-- declarada; cerrarla exigiría un two-phase commit con Kapso, que no existe.
-- ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mark_automation_run_dispatched(p_run_id UUID)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_updated  INT;
  v_status   TEXT;
  v_disp     TIMESTAMPTZ;
  v_has_conv BOOLEAN;
BEGIN
  UPDATE public.automation_runs r
     SET dispatched_at = clock_timestamp()
    FROM public.conversations c
    JOIN public.contacts ct ON ct.id = c.contact_id
   WHERE r.id = p_run_id
     AND r.status = 'processing'
     AND r.dispatched_at IS NULL
     AND c.id = r.conversation_id
     AND c.workspace_id = r.workspace_id
     AND ct.opt_in IS TRUE;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 1 THEN
    RETURN 'ok';
  END IF;

  -- No se actualizó: hay que decir POR QUÉ, no un 'false' que colapsa
  -- "ya salió" con "el contacto no quiere" y con "la fila ya no existe".
  SELECT r.status, r.dispatched_at INTO v_status, v_disp
    FROM public.automation_runs r
   WHERE r.id = p_run_id;

  IF v_status IS NULL OR v_status <> 'processing' THEN
    RETURN 'not_found';
  END IF;
  IF v_disp IS NOT NULL THEN
    RETURN 'already_dispatched';
  END IF;

  -- Queda una sola causa posible además del opt-out: que el JOIN no encuentre
  -- conversación o contacto (conversation_id NULL, conversación borrada, o de
  -- otro workspace). NO se reporta como 'opted_out' — eso sería mentir sobre
  -- el consentimiento del contacto; es un run que ya no se puede despachar.
  SELECT EXISTS (
           SELECT 1
             FROM public.automation_runs r
             JOIN public.conversations c
               ON c.id = r.conversation_id
              AND c.workspace_id = r.workspace_id
             JOIN public.contacts ct ON ct.id = c.contact_id
            WHERE r.id = p_run_id
         )
    INTO v_has_conv;

  IF NOT v_has_conv THEN
    RETURN 'not_found';
  END IF;
  RETURN 'opted_out';
END;
$$;

-- ──────────────────────────────────────────────────────────
-- 8. Grants de las tres RPC
--
-- Patrón COMPLETO del árbol, que son dos revocaciones y no una:
--   * REVOKE ... FROM anon, authenticated  (20260608000008_sec02_function_hardening.sql:11-13)
--     quita un grant DIRECTO a esos roles.
--   * REVOKE ALL ... FROM PUBLIC           (20260824000000_harden_security_definer_grants.sql:21-24)
--     quita el EXECUTE que Postgres le da a PUBLIC al crear la función, del que
--     anon/authenticated heredan.
-- Revocar solo PUBLIC deja vivo el grant directo; revocar solo los roles deja
-- vivo el heredado. Con cualquiera de los dos abierto, la anon key reclama
-- ejecuciones ajenas o escribe etiquetas en contactos de otro tenant.
--
-- Las funciones de trigger NO se grantean: Postgres no exige EXECUTE sobre una
-- función de trigger para disparar el trigger.
-- ──────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.claim_next_automation_run()                  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.append_contact_tags(UUID, UUID, TEXT[])      FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_automation_run_dispatched(UUID)         FROM PUBLIC;

REVOKE ALL ON FUNCTION public.claim_next_automation_run()                  FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.append_contact_tags(UUID, UUID, TEXT[])      FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_automation_run_dispatched(UUID)         FROM anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_next_automation_run()               TO service_role;
GRANT EXECUTE ON FUNCTION public.append_contact_tags(UUID, UUID, TEXT[])   TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_automation_run_dispatched(UUID)      TO service_role;

-- ============================================================
-- End of migration: 20260903000000_automation_engine
-- ============================================================
