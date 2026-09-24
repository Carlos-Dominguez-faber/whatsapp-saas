-- ============================================================
-- Migration: 20260908000000_appointment_upcoming_reminders
-- Motor de automatizaciones — recordatorios de cita.
-- El evaluador por tiempo (scan-time.ts) solo inserta eventos. Aplicar esta
-- migración ANTES de desplegar el código, nunca al revés: ampliar un CHECK es
-- compatible hacia atrás, pero el código desplegado sin esta migración hace
-- que la ruta del cron responda 500 cada 60 s en el primer tick con una regla
-- appointment_upcoming, hasta que se aplique.
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- 1. Trigger nuevo: appointment_upcoming
--
-- Amplía los dos CHECK que ya listan los tipos válidos, mismo patrón que las
-- listas originales de 20260903000000_automation_engine.sql (event_type) y
-- 20260609000002_automation_rules.sql (trigger_type).
-- ──────────────────────────────────────────────────────────
ALTER TABLE public.automation_events
  DROP CONSTRAINT automation_events_event_type_check;
ALTER TABLE public.automation_events
  ADD CONSTRAINT automation_events_event_type_check
  CHECK (event_type IN (
    'first_message', 'inbound_message', 'handoff_requested', 'lead_qualified',
    'appointment_upcoming'  -- recordatorios de cita, evaluador por tiempo (scan-time.ts)
  ));

ALTER TABLE public.automation_rules
  DROP CONSTRAINT automation_rules_trigger_type_check;
ALTER TABLE public.automation_rules
  ADD CONSTRAINT automation_rules_trigger_type_check
  CHECK (trigger_type IN (
    'first_message', 'inactivity_24h', 'window_closing', 'handoff_requested',
    'lead_qualified', 'keyword_match',
    'appointment_upcoming'  -- ver arriba
  ));

-- ──────────────────────────────────────────────────────────
-- 2. automation_events.rule_id — solo lo llenan los triggers POR TIEMPO
--
-- NULLABLE A PROPÓSITO. Los cuatro triggers de emisión POR EVENTO
-- (trg_messages_automation_event, trg_conversations_automation_event,
-- trg_contacts_automation_event — 20260903000000_automation_engine.sql, sección 5)
-- NO escriben esta columna, y su camino no cambia ni una línea. La única
-- fuente es `scanTimeTriggers()`: no hay trigger de Postgres para triggers
-- por tiempo (el evaluador es TypeScript sin estado), así que puebla
-- `rule_id` a mano con el id de la regla que generó el evento.
--
-- Por qué existe la columna: dos reglas `appointment_upcoming` del mismo
-- workspace con distinto `hours_before` (p.ej. 24h y 2h) comparten
-- trigger_type. Sin poder distinguir de CUÁL regla salió el evento,
-- expand.ts las matchearía a las DOS — un recordatorio de 24h también
-- dispararía el de 2h y viceversa, el doble de mensajes de los que pide
-- cada regla. El
-- guard en expand.ts es CONDICIONAL por el mismo motivo que la columna es
-- nullable: `if (event.rule_id && rule.id !== event.rule_id) continue;`.
-- Con `rule_id` NULL (los 4 triggers viejos) el guard queda inerte y el
-- evento sigue matcheando por trigger_type, exactamente como antes de esta
-- migración. NO volverla NOT NULL "por prolijidad" — rompe los 4 triggers
-- viejos, que insertan sin esta columna.
--
-- ON DELETE CASCADE, y NO SET NULL. La regla se puede borrar físicamente
-- (DELETE /api/workspace/[id]/automations no es soft-delete). Con SET NULL, un evento pendiente cuya regla se borró
-- volvería a NULL y reabriría el mismo bug de arriba: matchearía por
-- trigger_type contra CUALQUIER otra regla appointment_upcoming activa del
-- workspace, con el hours_before que no le corresponde — silencioso, sin
-- error en ningún lado. Con CASCADE, borrar la regla borra también sus
-- eventos pendientes: sin la regla que lo generó no hay ninguna expansión
-- correcta posible, así que no queda nada mejor que hacer con esa fila que
-- borrarla. Es el mismo criterio que ya usa `automation_runs.rule_id`
-- (ON DELETE CASCADE, 20260903000000_automation_engine.sql) para el
-- mismo problema un paso más adelante en el pipeline. Un evento YA expandido
-- (con sus runs ya creados) no depende de esto para conservar su historial:
-- los runs cuelgan de `rule_id` con su propio CASCADE, que es una FK
-- distinta y no se toca acá.
-- ──────────────────────────────────────────────────────────
ALTER TABLE public.automation_events
  ADD COLUMN IF NOT EXISTS rule_id UUID REFERENCES public.automation_rules(id) ON DELETE CASCADE;

-- Índice de la FK: sin él, cada DELETE de una regla (el CASCADE de arriba)
-- es un seq scan sobre automation_events para encontrar sus eventos
-- pendientes. Parcial porque la inmensa mayoría de las filas —las de los 4
-- triggers por evento— tienen rule_id NULL y nunca participan de ese borrado.
CREATE INDEX IF NOT EXISTS idx_automation_events_rule
  ON public.automation_events (rule_id)
  WHERE rule_id IS NOT NULL;

-- ============================================================
-- End of migration: 20260908000000_appointment_upcoming_reminders
-- ============================================================
