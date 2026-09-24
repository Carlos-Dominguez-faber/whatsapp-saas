-- ============================================================
-- Piso temporal de la regla, evaluado en el claim
--
-- Apagar y prender una regla descarta los runs encolados que no despacharon.
-- El guard vive acá y no en TypeScript (executor.ts): allá solo podría
-- comparar `automation_runs.created_at` —CUÁNDO SE ESCRIBIÓ LA FILA— contra
-- el `enabled_since` vigente de la regla, con dos problemas:
--
--   1. `created_at` no es el instante del hecho. Entre que la expansión lee
--      las reglas y escribe el run pasa un round-trip (y con dos ticks
--      solapados, más). Si un manager apaga y prende la regla justo ahí, el
--      run nace con `created_at` POSTERIOR al piso nuevo y el guard lo deja
--      pasar: se ejecuta una acción disparada por un hecho anterior al piso
--      que el operador acaba de fijar. Con `send_template` eso es un WhatsApp
--      real, cobrado e irreversible.
--   2. La comparación sería en JavaScript. `Date.parse` trunca a milisegundo los
--      6 dígitos fraccionarios que Postgres sí distingue, así que dos
--      instantes separados por microsegundos se igualan — y en el borde de
--      igualdad el criterio es EJECUTAR, o sea que el truncado falla
--      siempre hacia el lado permisivo.
--
-- El invariante que impone esta migración:
--
--   Un run solo se ejecuta si el `occurred_at` de su evento es >= el
--   `enabled_since` vigente de su regla, evaluado en el instante del efecto y
--   con la precisión completa del `timestamptz`.
--
-- `occurred_at` es el instante del HECHO y es inmutable: cualquier
-- reactivación posterior queda del lado correcto de la comparación, sin
-- importar cuánto tardó la fila en escribirse. Y la comparación la hace
-- Postgres sobre `timestamptz`, así que no pierde microsegundos.
--
-- BORDE DE IGUALDAD: `occurred_at = enabled_since` EJECUTA. La condición de
-- descarte es `enabled_since > occurred_at`, estricta a propósito, y es el
-- mismo predicado que `ruleAppliesTo` evalúa en la expansión
-- (`enabled_since <= occurred_at`). Una sola definición, dos puntos de
-- evaluación.
--
-- POR QUÉ EL LOOKUP VA DESPUÉS DEL `FOR UPDATE` Y NO DENTRO DE ÉL:
-- `FOR UPDATE ... SKIP LOCKED` sin cláusula `OF` bloquea TODAS las tablas de
-- la query. Con `automation_rules` adentro, el claim se saltaría los runs cuya
-- fila de regla está bloqueada — es decir, justo mientras un manager guarda
-- esa regla, toda su cola se volvería invisible ese tick. Cuando llega el
-- momento de decidir, la fila del run YA está bloqueada, así que alcanza con
-- un lookup escalar por PK. `automation_runs.event_id` es NOT NULL con FK
-- RESTRICT y tiene índice (`idx_automation_runs_event`), y `rule_id` es NOT
-- NULL con FK CASCADE: la lectura es barata y siempre encuentra fila.
--
-- LO QUE ESTO **NO** CIERRA: queda una ventana residual entre el guard y el
-- efecto, en la que `enabled_since` todavía puede moverse, porque el claim no
-- bloquea `automation_rules`. Cerrar esa ventana exigiría fusionar el chequeo
-- con la sentencia de cada efecto; acá no se hace.
--
-- El descarte es un segundo caso de la rama que la función ya tenía para
-- `attempts >= 3`: cierra con estado terminal y un CÓDIGO en `error`, sella
-- `finished_at`, escribe la fila en `public.events` para que el panel lo vea,
-- y hace CONTINUE para que una fila descartada no corte el drenaje.
--
-- `dispatched_at` MANDA EN LAS DOS RAMAS DE DESCARTE, no solo en la de
-- intentos agotados. Un run con `dispatched_at` cierra como `outcome_unknown`
-- —el WhatsApp puede haber salido—; taparlo con `rule_reenabled` escondería
-- ese envío. El camino real: el worker muere DESPUÉS del POST a Kapso y antes
-- de cerrar el run, la fila queda `processing` con `attempts` todavía < 3, a
-- los 7 minutos el claim la vuelve a tomar y —si en el medio alguien apagó y
-- prendió la regla— cae en el piso temporal con el mensaje ya entregado. Por
-- eso las dos ramas usan el mismo criterio, y por eso `attempts >= 3` va
-- PRIMERO: un run agotado se cierra por agotado, con su propio código.
--
-- CREATE OR REPLACE sin cambio de firma: conserva los grants del bloque
-- REVOKE/GRANT de 20260903000000_automation_engine.sql. NO convertir esto en
-- DROP + CREATE.
-- ============================================================

CREATE OR REPLACE FUNCTION public.claim_next_automation_run()
RETURNS SETOF public.automation_runs
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_run       public.automation_runs;
  v_action    TEXT;
  v_reason    TEXT;
  v_status    TEXT;
  v_ev_type   TEXT;
  v_ev_level  TEXT;
  v_stale     BOOLEAN;
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

    -- Piso temporal, con el instante del HECHO y precisión de
    -- Postgres. `enabled_since` NULL (fila legada sin backfill) no excluye
    -- nada: el guard solo descarta lo que puede PROBAR que es viejo. Si el
    -- lookup no devuelve fila, v_stale queda NULL y el IF no dispara.
    SELECT ru.action_type,
           (ru.enabled_since IS NOT NULL AND ru.enabled_since > e.occurred_at)
      INTO v_action, v_stale
    FROM public.automation_events e
    JOIN public.automation_rules  ru ON ru.id = v_run.rule_id
    WHERE e.id = v_run.event_id;

    IF v_stale THEN
      -- Mismo criterio que la rama de `attempts >= 3`: un run que ya despachó
      -- puede haber mandado el WhatsApp, así que el piso temporal NO lo puede
      -- cerrar como 'skipped/rule_reenabled' — eso escondería el envío detrás
      -- de un "salteado" informativo. Solo lo que nunca despachó es un skip.
      IF v_run.dispatched_at IS NOT NULL THEN
        v_status   := 'failed';
        v_reason   := 'outcome_unknown';
        v_ev_type  := 'automation_failed';
        v_ev_level := 'error';
      ELSE
        v_status   := 'skipped';
        v_reason   := 'rule_reenabled';
        v_ev_type  := 'automation_skipped';
        v_ev_level := 'info';
      END IF;

      UPDATE public.automation_runs
         SET status      = v_status,
             error       = v_reason,
             finished_at = NOW()
       WHERE id = v_run.id;

      -- Mismo tipo, nivel y seis claves que emite finish() del ejecutor: estas
      -- filas nunca pasan por ahí y sin el evento desaparecen del panel.
      INSERT INTO public.events (workspace_id, conversation_id, type, level, payload)
      VALUES (
        v_run.workspace_id,
        v_run.conversation_id,
        v_ev_type,
        v_ev_level,
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
        RETURN;
      END IF;
      CONTINUE;
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
