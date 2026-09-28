-- ============================================================
-- Migration: 20261001000000_automation_engine
--
-- The automation engine (community PR #16, by Francisco Velásquez), in one
-- migration on top of main. Automation rules existed before this but nothing
-- ran them; from here on they run unattended, including WhatsApp template
-- sends that cost money and reach real people. So:
--
--   * Every rule that was enabled before the engine existed is switched OFF
--     (paused_reason = 'upgrade'); the Automations tab asks the team to review
--     and re-enable them explicitly.
--   * Captured events expire (per-type TTL), a reminder for an appointment
--     that already passed is discarded, sends have a cooldown (per contact, or
--     per appointment for reminders) and a per-workspace daily cap, and no
--     automation or template reaches a phone that opted out (kept per phone
--     in contact_opt_outs, applied from the STOP message itself). Only a
--     manager or admin can opt a contact back in, or delete a contact, and
--     every manual change leaves an event.
--   * Every reference is workspace-consistent (composite FKs), and every RPC
--     is callable by service_role only.
--
-- Idempotent, including over a database that already ran #16's own
-- migrations (20260903000000, 20260904000000, 20260904000002,
-- 20260908000000); setup.mjs marks those versions as reverted. There, only
-- rules someone enabled under #16's engine stay on.
--
-- Needs Postgres 15+ for ON DELETE SET NULL (column).
-- ============================================================

DO $$
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION 'This migration needs Postgres 15+ (ON DELETE SET NULL (column)). Upgrade it in Supabase → Settings → Infrastructure, then run db push again.';
  END IF;
END
$$;

-- ──────────────────────────────────────────────────────────
-- 1. Occurrence versions (the engine's idempotency keys)
--
-- An occurrence is identified by a VERSION, never by updated_at: any update
-- renews updated_at, including the tag an automation itself writes, so
-- `lead_qualified -> add_tag` would loop forever. The BEFORE triggers run on
-- EVERY update (no `OF column`) so the version can't be written directly.
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
    NEW.stage_version := OLD.stage_version;
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
    NEW.state_version := OLD.state_version;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_contacts_stage_version ON public.contacts;
CREATE TRIGGER trg_contacts_stage_version
  BEFORE UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.bump_contact_stage_version();

DROP TRIGGER IF EXISTS trg_conversations_state_version ON public.conversations;
CREATE TRIGGER trg_conversations_state_version
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.bump_conversation_state_version();

-- ──────────────────────────────────────────────────────────
-- 1b. An explicit opt-out stands
--
-- A contact who asked to stop (an explicit STOP, or a manual opt-out in the
-- CRM) gets no automation and no template. The suppression lives in its own
-- table, keyed by the phone, so no edit of the contact row undoes it: not the
-- inbound upsert that opts writers in, not deleting and re-creating the
-- contact, not moving the phone to another contact. contacts.opted_out_at /
-- opt_in mirror it for the inbox. Only a manager or admin clears it from a
-- user session; the server clears it when the contact sends START. Replies
-- inside the 24h window the contact opens are not affected.
-- ──────────────────────────────────────────────────────────
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS opted_out_at TIMESTAMPTZ;

-- The digits of a phone: the same key however it was written.
CREATE OR REPLACE FUNCTION public.contact_phone_key(p_phone TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
SET search_path = ''
AS $$
  SELECT nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), '');
$$;

CREATE TABLE IF NOT EXISTS public.contact_opt_outs (
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  phone_key    TEXT NOT NULL,
  opted_out_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- 'keyword' (the contact wrote STOP), 'manual' (someone in the CRM),
  -- 'backfill' (opted out by hand before this migration)
  source       TEXT NOT NULL,
  PRIMARY KEY (workspace_id, phone_key)
);

ALTER TABLE public.contact_opt_outs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ws members read contact_opt_outs" ON public.contact_opt_outs;
CREATE POLICY "ws members read contact_opt_outs" ON public.contact_opt_outs
  FOR SELECT USING (workspace_id IN (SELECT auth_workspace_ids()));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.contact_opt_outs FROM anon, authenticated;

-- A contact someone opted out by hand before this migration (opt_in turned
-- false after it had been true) is an explicit opt-out too. Idempotent: once
-- stamped, opted_out_at is no longer NULL. Each one is recorded as an event.
DO $$
DECLARE
  v_count INT;
BEGIN
  WITH stamped AS (
    UPDATE public.contacts
       SET opted_out_at = updated_at
     WHERE opt_in = false
       AND opted_out_at IS NULL
       AND opt_in_at IS NOT NULL
    RETURNING id, workspace_id
  )
  INSERT INTO public.events (workspace_id, type, level, payload)
  SELECT workspace_id, 'contact_opt_in_changed', 'info',
         jsonb_build_object('contact_id', id, 'opt_in', false, 'source', 'backfill')
    FROM stamped;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'contacts: % manual opt-out(s) from before the automation engine now count as explicit', v_count;
END
$$;

INSERT INTO public.contact_opt_outs (workspace_id, phone_key, opted_out_at, source)
SELECT DISTINCT ON (c.workspace_id, public.contact_phone_key(c.phone))
       c.workspace_id, public.contact_phone_key(c.phone), c.opted_out_at, 'backfill'
  FROM public.contacts c
 WHERE c.opted_out_at IS NOT NULL
   AND public.contact_phone_key(c.phone) IS NOT NULL
 ORDER BY c.workspace_id, public.contact_phone_key(c.phone), c.opted_out_at
ON CONFLICT (workspace_id, phone_key) DO NOTHING;

-- Keeps contacts in step with the suppression, on every insert and update:
--   * a suppressed phone makes its contact opted out (a new contact, a
--     re-created one, or one the phone was moved to);
--   * a new opted_out_at records the suppression;
--   * clearing opted_out_at clears it, and from a user session only a manager
--     or admin may (the role PostgREST switched to; SECURITY DEFINER changes
--     current_user, not this setting, and server writes pass);
--   * every opt-in change from a user session leaves an event with the user.
CREATE OR REPLACE FUNCTION public.sync_contact_opt_out()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_session    BOOLEAN := coalesce(current_setting('role', true), 'none') IN ('authenticated', 'anon');
  v_key        TEXT := public.contact_phone_key(NEW.phone);
  v_suppressed TIMESTAMPTZ;
  v_clearing   BOOLEAN := TG_OP = 'UPDATE' AND OLD.opted_out_at IS NOT NULL AND NEW.opted_out_at IS NULL;
BEGIN
  IF v_clearing THEN
    IF v_session
       AND NOT public.auth_has_role(NEW.workspace_id, ARRAY['admin', 'manager']::public.workspace_role[])
       AND NOT public.is_super_admin()
    THEN
      RAISE EXCEPTION 'only a workspace admin or manager can opt a contact back in after an opt-out'
        USING ERRCODE = '42501';
    END IF;
    DELETE FROM public.contact_opt_outs o
     WHERE o.workspace_id = NEW.workspace_id
       AND o.phone_key IN (v_key, public.contact_phone_key(OLD.phone));
  ELSE
    SELECT o.opted_out_at INTO v_suppressed
      FROM public.contact_opt_outs o
     WHERE o.workspace_id = NEW.workspace_id
       AND o.phone_key = v_key;

    IF NEW.opted_out_at IS NOT NULL AND v_suppressed IS NULL AND v_key IS NOT NULL
       AND (TG_OP = 'INSERT' OR OLD.opted_out_at IS NULL)
    THEN
      INSERT INTO public.contact_opt_outs (workspace_id, phone_key, opted_out_at, source)
      VALUES (NEW.workspace_id, v_key, NEW.opted_out_at,
              CASE WHEN v_session THEN 'manual' ELSE 'keyword' END)
      ON CONFLICT (workspace_id, phone_key) DO NOTHING;
    END IF;

    IF v_suppressed IS NOT NULL THEN
      NEW.opted_out_at := coalesce(NEW.opted_out_at, v_suppressed);
    END IF;
    IF NEW.opted_out_at IS NOT NULL THEN
      NEW.opt_in := false;
    END IF;
  END IF;

  IF v_session AND TG_OP = 'UPDATE'
     AND (NEW.opt_in IS DISTINCT FROM OLD.opt_in OR NEW.opted_out_at IS DISTINCT FROM OLD.opted_out_at)
  THEN
    INSERT INTO public.events (workspace_id, type, level, payload)
    VALUES (
      NEW.workspace_id,
      'contact_opt_in_changed',
      'info',
      jsonb_build_object(
        'contact_id',      NEW.id,
        'user_id',         auth.uid(),
        'opt_in',          NEW.opt_in,
        'previous_opt_in', OLD.opt_in,
        'opt_out_cleared', v_clearing,
        'source',          'manual'
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_contacts_keep_opt_out ON public.contacts;
DROP TRIGGER IF EXISTS trg_contacts_opt_in_guard ON public.contacts;
DROP FUNCTION IF EXISTS public.keep_contact_opt_out();
DROP FUNCTION IF EXISTS public.guard_contact_opt_in_change();
DROP TRIGGER IF EXISTS trg_contacts_opt_out ON public.contacts;
CREATE TRIGGER trg_contacts_opt_out
  BEFORE INSERT OR UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.sync_contact_opt_out();

-- Deleting a contact takes a manager or admin (nothing in the app lets an
-- agent do it). Agents keep creating and editing contacts.
DROP POLICY IF EXISTS "ws operators write contacts" ON public.contacts;
DROP POLICY IF EXISTS "ws operators insert contacts" ON public.contacts;
DROP POLICY IF EXISTS "ws operators update contacts" ON public.contacts;
DROP POLICY IF EXISTS "ws managers delete contacts" ON public.contacts;
CREATE POLICY "ws operators insert contacts" ON public.contacts
  FOR INSERT WITH CHECK (
    workspace_id IN (SELECT auth_workspace_ids())
    AND auth_has_role(workspace_id, ARRAY['admin','manager','agent']::workspace_role[])
  );
CREATE POLICY "ws operators update contacts" ON public.contacts
  FOR UPDATE USING (
    workspace_id IN (SELECT auth_workspace_ids())
    AND auth_has_role(workspace_id, ARRAY['admin','manager','agent']::workspace_role[])
  ) WITH CHECK (
    workspace_id IN (SELECT auth_workspace_ids())
    AND auth_has_role(workspace_id, ARRAY['admin','manager','agent']::workspace_role[])
  );
CREATE POLICY "ws managers delete contacts" ON public.contacts
  FOR DELETE USING (
    workspace_id IN (SELECT auth_workspace_ids())
    AND auth_has_role(workspace_id, ARRAY['admin','manager']::workspace_role[])
  );

-- STOP / START from the contact, applied in the same statement that stores
-- their message: a failure fails the insert, so the webhook answers non-2xx
-- and the provider delivers it again, and a redelivery (same wamid, not
-- inserted) never re-applies an old STOP over a later START. Only an
-- explicit, whole message counts, after lowercasing and dropping accents and
-- punctuation; bare "baja", "alta" or "alto" are ordinary answers.
CREATE OR REPLACE FUNCTION public.opt_out_intent(p_text TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
SET search_path = ''
AS $$
  WITH clean AS (
    SELECT btrim(regexp_replace(
             regexp_replace(
               translate(lower(coalesce(p_text, '')), 'áàâäãéèêëíìîïóòôöõúùûüñç', 'aaaaaeeeeiiiiooooouuuunc'),
               '[^a-z0-9]+', ' ', 'g'),
             ' +', ' ', 'g')) AS t
  )
  SELECT CASE
           WHEN length(t) > 40 THEN NULL
           WHEN t IN ('stop', 'unsubscribe', 'darme de baja', 'no mas mensajes',
                      'no quiero recibir mensajes', 'stop promotions', 'detener promociones')
             THEN 'stop'
           WHEN t IN ('start', 'suscribirme', 'reanudar mensajes') THEN 'start'
         END
    FROM clean;
$$;

CREATE OR REPLACE FUNCTION public.apply_inbound_opt_out()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_intent  TEXT := public.opt_out_intent(NEW.body);
  v_contact public.contacts;
BEGIN
  IF v_intent IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT ct.* INTO v_contact
    FROM public.conversations c
    JOIN public.contacts ct
      ON ct.id = c.contact_id
     AND ct.workspace_id = c.workspace_id
   WHERE c.id = NEW.conversation_id
     AND c.workspace_id = NEW.workspace_id;
  IF v_contact.id IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_intent = 'stop' THEN
    INSERT INTO public.contact_opt_outs (workspace_id, phone_key, opted_out_at, source)
    SELECT NEW.workspace_id, public.contact_phone_key(v_contact.phone), clock_timestamp(), 'keyword'
     WHERE public.contact_phone_key(v_contact.phone) IS NOT NULL
    ON CONFLICT (workspace_id, phone_key) DO NOTHING;
    UPDATE public.contacts
       SET opt_in = false,
           opted_out_at = coalesce(opted_out_at, clock_timestamp())
     WHERE id = v_contact.id
       AND workspace_id = NEW.workspace_id;
  ELSE
    UPDATE public.contacts
       SET opt_in = true,
           opt_in_at = clock_timestamp(),
           opted_out_at = NULL
     WHERE id = v_contact.id
       AND workspace_id = NEW.workspace_id;
    DELETE FROM public.contact_opt_outs o
     WHERE o.workspace_id = NEW.workspace_id
       AND o.phone_key = public.contact_phone_key(v_contact.phone);
  END IF;

  INSERT INTO public.events (workspace_id, conversation_id, type, level, payload)
  VALUES (NEW.workspace_id, NEW.conversation_id, 'contact_opt_in_changed', 'info',
          jsonb_build_object('contact_id', v_contact.id, 'opt_in', v_intent = 'start',
                             'source', 'keyword', 'message_id', NEW.id));
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_messages_opt_out ON public.messages;
CREATE TRIGGER trg_messages_opt_out
  AFTER INSERT ON public.messages
  FOR EACH ROW
  WHEN (NEW.direction = 'in' AND NEW.type = 'text')
  EXECUTE FUNCTION public.apply_inbound_opt_out();

-- ──────────────────────────────────────────────────────────
-- 2. automation_rules
-- ──────────────────────────────────────────────────────────

-- appointment_upcoming (reminders) joins the trigger types.
ALTER TABLE public.automation_rules
  DROP CONSTRAINT IF EXISTS automation_rules_trigger_type_check;
ALTER TABLE public.automation_rules
  ADD CONSTRAINT automation_rules_trigger_type_check
  CHECK (trigger_type IN (
    'first_message', 'inactivity_24h', 'window_closing', 'handoff_requested',
    'lead_qualified', 'keyword_match', 'appointment_upcoming'
  ));

-- enabled_since: the rule's time floor, on Postgres' clock (the same one that
-- stamps automation_events.occurred_at). It moves only when the rule becomes
-- enabled, so a re-enabled rule never fires on events from before.
ALTER TABLE public.automation_rules
  ADD COLUMN IF NOT EXISTS enabled_since TIMESTAMPTZ;

-- paused_reason: why the system switched a rule off, for the tab to explain
-- ('upgrade' = off since the engine arrived; 'template_paused' = Meta paused
-- its template). Cleared when someone enables the rule again.
ALTER TABLE public.automation_rules
  ADD COLUMN IF NOT EXISTS paused_reason TEXT;

-- Rules enabled before the engine existed never ran: switch them off rather
-- than let them start sending on their own. On a database that already ran
-- #16, its migration backfilled enabled_since = created_at for those same
-- legacy rules, so they are switched off too; rules someone enabled under #16's
-- engine (enabled_since stamped by the trigger's clock_timestamp()) are left
-- alone. This runs BEFORE the trigger below exists (on a fresh upgrade), and
-- the trigger would do the same (disabled → enabled_since NULL) anyway.
UPDATE public.automation_rules
   SET enabled = false,
       paused_reason = 'upgrade'
 WHERE enabled
   AND (enabled_since IS NULL OR enabled_since = created_at);

CREATE OR REPLACE FUNCTION public.set_automation_rule_enabled_since()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.enabled_since := CASE WHEN NEW.enabled THEN clock_timestamp() ELSE NULL END;
    IF NEW.enabled THEN NEW.paused_reason := NULL; END IF;
    RETURN NEW;
  END IF;

  IF NEW.enabled AND NOT OLD.enabled THEN
    NEW.enabled_since := clock_timestamp();  -- re-enabled: never fires backwards
    NEW.paused_reason := NULL;               -- someone reviewed it
  ELSIF NOT NEW.enabled THEN
    NEW.enabled_since := NULL;
  ELSE
    NEW.enabled_since := OLD.enabled_since;  -- still enabled: doesn't move
  END IF;
  RETURN NEW;
END;
$$;

-- No `OF enabled`: runs on every update, so enabled_since can't be written
-- directly (defence in depth; writes are service_role-only anyway, below).
DROP TRIGGER IF EXISTS trg_automation_rules_enabled_since ON public.automation_rules;
CREATE TRIGGER trg_automation_rules_enabled_since
  BEFORE INSERT OR UPDATE ON public.automation_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_automation_rule_enabled_since();

-- The emission triggers' EXISTS (inside the inbound message's transaction)
-- must be an index scan.
CREATE INDEX IF NOT EXISTS idx_automation_rules_enabled_type
  ON public.automation_rules (workspace_id, trigger_type)
  WHERE enabled;

-- Target of the workspace-consistent FKs from automation_events/runs.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.automation_rules'::regclass
       AND conname = 'uq_automation_rules_workspace_id'
  ) THEN
    ALTER TABLE public.automation_rules
      ADD CONSTRAINT uq_automation_rules_workspace_id UNIQUE (workspace_id, id);
  END IF;
END
$$;

-- Rules are written only by the server (service_role), which enforces the
-- role check, the schema and the active-rule cap. Members keep reading them.
DROP POLICY IF EXISTS "ws admins manage automations" ON public.automation_rules;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.automation_rules FROM anon, authenticated;

-- ──────────────────────────────────────────────────────────
-- 3. automation_events — the transactional outbox
--
-- Written ONLY by the emission triggers (SECURITY DEFINER), in the same
-- transaction as the write that caused them, and by the time scan (service
-- role). UNIQUE (event_type, subject_id, occurrence) is the whole idempotency
-- of the capture. For appointment reminders the occurrence carries the rule id,
-- so two reminder rules with the same lead time both fire.
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.automation_events (
  id              BIGSERIAL PRIMARY KEY,
  workspace_id    UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,
  subject_id      UUID NOT NULL,
  occurrence      TEXT NOT NULL,
  conversation_id UUID,
  contact_id      UUID,
  message_id      UUID,
  rule_id         UUID,
  -- clock_timestamp(), not NOW(): rows written in one transaction must keep
  -- their order relative to automation_rules.enabled_since.
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expanded_at     TIMESTAMPTZ,
  expand_attempts INT NOT NULL DEFAULT 0,
  expand_error    TEXT,
  UNIQUE (event_type, subject_id, occurrence)
);

ALTER TABLE public.automation_events ADD COLUMN IF NOT EXISTS rule_id UUID;

-- #16 keyed a reminder as '<h>h:<iso>'; the key now leads with the rule id.
-- Rewriting #16's rows keeps a reminder it already sent from going out again
-- under the new key. Idempotent: a rewritten key no longer starts with '<h>h:'.
UPDATE public.automation_events
   SET occurrence = rule_id::text || ':' || occurrence
 WHERE event_type = 'appointment_upcoming'
   AND rule_id IS NOT NULL
   AND occurrence ~ '^\d+h:';

ALTER TABLE public.automation_events
  DROP CONSTRAINT IF EXISTS automation_events_event_type_check;
ALTER TABLE public.automation_events
  ADD CONSTRAINT automation_events_event_type_check
  CHECK (event_type IN (
    'first_message', 'inbound_message', 'handoff_requested', 'lead_qualified',
    'appointment_upcoming'
  ));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.automation_events'::regclass
       AND conname = 'uq_automation_events_workspace_id'
  ) THEN
    ALTER TABLE public.automation_events
      ADD CONSTRAINT uq_automation_events_workspace_id UNIQUE (workspace_id, id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_automation_events_pending
  ON public.automation_events (workspace_id, id)
  WHERE expanded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_automation_events_workspace
  ON public.automation_events (workspace_id);
CREATE INDEX IF NOT EXISTS idx_automation_events_conversation
  ON public.automation_events (conversation_id);
CREATE INDEX IF NOT EXISTS idx_automation_events_contact
  ON public.automation_events (contact_id);
CREATE INDEX IF NOT EXISTS idx_automation_events_message
  ON public.automation_events (message_id);
CREATE INDEX IF NOT EXISTS idx_automation_events_rule
  ON public.automation_events (rule_id)
  WHERE rule_id IS NOT NULL;

ALTER TABLE public.automation_events ENABLE ROW LEVEL SECURITY;

-- Read-only for members (the tab shows the trace). No write policy on purpose.
DROP POLICY IF EXISTS "ws members read automation_events" ON public.automation_events;
CREATE POLICY "ws members read automation_events" ON public.automation_events
  FOR SELECT USING (workspace_id IN (SELECT auth_workspace_ids()));

-- ──────────────────────────────────────────────────────────
-- 4. automation_runs — the execution queue
--
-- One row = one rule that applies to one event; UNIQUE (rule_id, event_id)
-- makes the expansion idempotent. dispatched_at marks that the external
-- effect started: a worker that dies between the send and the close leaves a
-- row the next claim closes as outcome_unknown instead of sending again.
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.automation_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  rule_id         UUID NOT NULL,
  event_id        BIGINT NOT NULL,
  trigger_type    TEXT NOT NULL,
  conversation_id UUID,
  contact_id      UUID,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','done','failed','skipped')),
  attempts        INT NOT NULL DEFAULT 0,
  error           TEXT,
  not_before      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at      TIMESTAMPTZ,
  dispatched_at   TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (rule_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_automation_runs_claimable
  ON public.automation_runs (status, not_before)
  WHERE status IN ('pending','processing');
CREATE INDEX IF NOT EXISTS idx_automation_runs_ws_claimed
  ON public.automation_runs (workspace_id, claimed_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_runs_workspace
  ON public.automation_runs (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_runs_event
  ON public.automation_runs (event_id);
CREATE INDEX IF NOT EXISTS idx_automation_runs_conversation
  ON public.automation_runs (conversation_id);
CREATE INDEX IF NOT EXISTS idx_automation_runs_contact
  ON public.automation_runs (contact_id);
-- The cooldown and the daily cap look up recent dispatches.
CREATE INDEX IF NOT EXISTS idx_automation_runs_dispatched
  ON public.automation_runs (workspace_id, dispatched_at)
  WHERE dispatched_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_automation_runs_rule_contact_dispatched
  ON public.automation_runs (rule_id, contact_id, dispatched_at)
  WHERE dispatched_at IS NOT NULL;
-- The tab's per-rule health (last outcome, failures in 24 h).
CREATE INDEX IF NOT EXISTS idx_automation_runs_rule_finished
  ON public.automation_runs (workspace_id, rule_id, finished_at DESC)
  WHERE finished_at IS NOT NULL;

ALTER TABLE public.automation_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ws members read automation_runs" ON public.automation_runs;
CREATE POLICY "ws members read automation_runs" ON public.automation_runs
  FOR SELECT USING (workspace_id IN (SELECT auth_workspace_ids()));

-- Nothing but the server writes these two tables (RLS has no write policy, and
-- the grants say the same).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.automation_events FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.automation_runs FROM anon, authenticated;

-- ──────────────────────────────────────────────────────────
-- 5. Workspace-consistent references
--
-- Every reference carries workspace_id, so a row can only point at data of
-- its own workspace. Replaces #16's single-column FKs where they exist.
-- event_id is NO ACTION (checked at the end of the statement), not RESTRICT:
-- deleting a rule cascades to its runs and to its reminder events in the same
-- statement, and RESTRICT could fire before the runs were gone.
-- ──────────────────────────────────────────────────────────
DO $$
DECLARE
  -- table, column, referenced table, ON DELETE
  fk text[];
  fks text[][] := ARRAY[
    ['automation_events', 'conversation_id', 'conversations',     'SET NULL'],
    ['automation_events', 'contact_id',      'contacts',          'SET NULL'],
    ['automation_events', 'message_id',      'messages',          'SET NULL'],
    ['automation_events', 'rule_id',         'automation_rules',  'CASCADE'],
    ['automation_runs',   'conversation_id', 'conversations',     'SET NULL'],
    ['automation_runs',   'contact_id',      'contacts',          'SET NULL'],
    ['automation_runs',   'rule_id',         'automation_rules',  'CASCADE'],
    ['automation_runs',   'event_id',        'automation_events', 'NO ACTION']
  ];
  old_fk record;
  new_name text;
  on_delete text;
BEGIN
  FOREACH fk SLICE 1 IN ARRAY fks LOOP
    -- Drop any single-column FK on this column (#16's originals).
    FOR old_fk IN
      SELECT c.conname
        FROM pg_constraint c
       WHERE c.conrelid = ('public.' || fk[1])::regclass
         AND c.contype = 'f'
         AND c.conkey = ARRAY[(
               SELECT a.attnum FROM pg_attribute a
                WHERE a.attrelid = ('public.' || fk[1])::regclass
                  AND a.attname = fk[2]
             )]::int2[]
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', fk[1], old_fk.conname);
    END LOOP;

    new_name := 'fk_' || fk[1] || '_' || fk[2] || '_same_workspace';
    on_delete := CASE fk[4]
      WHEN 'SET NULL' THEN format('SET NULL (%I)', fk[2])
      ELSE fk[4]
    END;
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', fk[1], new_name);
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (workspace_id, %I) '
      'REFERENCES public.%I (workspace_id, id) ON DELETE %s NOT VALID',
      fk[1], new_name, fk[2], fk[3], on_delete
    );
    BEGIN
      EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', fk[1], new_name);
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE WARNING
        '% on %: existing rows point at another workspace; the constraint still guards new writes.',
        new_name, fk[1];
    END;
  END LOOP;
END
$$;

-- ──────────────────────────────────────────────────────────
-- 6. Emission triggers
--
-- SECURITY DEFINER (automation_events has no write policy, and `stage` is
-- also written by user sessions under RLS). The EXCEPTION guard is deliberate:
-- a bug here must never block an inbound message or a handoff. Rule logic
-- (keywords, the enabled_since floor, TTLs) lives in TypeScript and the claim;
-- the triggers only do an indexed EXISTS and an idempotent insert.
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
   WHERE c.id = NEW.conversation_id
     AND c.workspace_id = NEW.workspace_id;

  IF v_conv_created_at IS NULL THEN
    RETURN NULL;
  END IF;

  -- first_message: the contact's first inbound in this conversation. The rules
  -- EXISTS goes first so tenants without such a rule never pay the messages scan.
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

  -- inbound_message: one per inbound, only when a keyword rule is enabled.
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
    INSERT INTO public.automation_events
      (workspace_id, event_type, subject_id, occurrence,
       conversation_id, contact_id, message_id)
    VALUES
      (NEW.workspace_id, 'handoff_requested', NEW.id, NEW.state_version::text,
       NEW.id, NEW.contact_id, NULL)
    ON CONFLICT (event_type, subject_id, occurrence) DO NOTHING;
  END IF;
  RETURN NULL;
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
    -- conversation_id NULL on purpose: the executor picks the contact's most
    -- recent conversation.
    INSERT INTO public.automation_events
      (workspace_id, event_type, subject_id, occurrence,
       conversation_id, contact_id, message_id)
    VALUES
      (NEW.workspace_id, 'lead_qualified', NEW.id, NEW.stage_version::text,
       NULL, NEW.id, NULL)
    ON CONFLICT (event_type, subject_id, occurrence) DO NOTHING;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'automation_event_failed: %', SQLERRM;
  RETURN NULL;
END;
$$;

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
-- 7. Event TTL
--
-- How long after it happened an event may still trigger an action. A backlog
-- (cron not scheduled yet, or down) must not send yesterday's greeting today.
-- Reminders have their own timing guard in the executor (late only when more
-- than 30 minutes of sending hours passed since they were due), so theirs is a
-- backstop long enough for one overnight wait for the sending hours.
-- ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.automation_event_ttl(p_event_type TEXT)
RETURNS INTERVAL
LANGUAGE sql IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE p_event_type
           WHEN 'inbound_message'      THEN INTERVAL '1 hour'
           WHEN 'handoff_requested'    THEN INTERVAL '2 hours'
           WHEN 'first_message'        THEN INTERVAL '6 hours'
           WHEN 'lead_qualified'       THEN INTERVAL '6 hours'
           WHEN 'appointment_upcoming' THEN INTERVAL '26 hours'
           ELSE INTERVAL '1 hour'
         END;
$$;

-- ──────────────────────────────────────────────────────────
-- 8. claim_next_automation_run() — claim with a lease
--
-- FOR UPDATE SKIP LOCKED, round-robin across workspaces by the data itself
-- (the workspace served longest ago first), a 7-minute lease above the cron's
-- maxDuration. Before handing a run out it discards, with an event:
--   * runs out of attempts (max_attempts:<last cause>, or outcome_unknown if
--     dispatched);
--   * runs whose rule was re-enabled after the event (rule_reenabled);
--   * runs whose event is older than its TTL (stale).
-- A discard never stops the drain: the loop moves to the next row (up to 50
-- discards per call).
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
  v_status    TEXT;
  v_ev_type   TEXT;
  v_ev_level  TEXT;
  v_floor     BOOLEAN;
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

    IF v_run.id IS NULL THEN
      RETURN;
    END IF;

    SELECT ru.action_type,
           (ru.enabled_since IS NOT NULL AND ru.enabled_since > e.occurred_at),
           (e.occurred_at < NOW() - public.automation_event_ttl(e.event_type))
      INTO v_action, v_floor, v_stale
      FROM public.automation_events e
      JOIN public.automation_rules  ru
        ON ru.id = v_run.rule_id
       AND ru.workspace_id = v_run.workspace_id
     WHERE e.id = v_run.event_id
       AND e.workspace_id = v_run.workspace_id;

    v_reason := NULL;
    IF v_run.attempts >= 3 THEN
      -- The last retry's cause stays visible ('max_attempts:db_read_failed').
      v_reason := CASE WHEN v_run.dispatched_at IS NOT NULL
                       THEN 'outcome_unknown'
                       ELSE 'max_attempts:' || coalesce(v_run.error, 'unknown') END;
      v_status := 'failed';
    ELSIF v_run.dispatched_at IS NOT NULL AND (v_floor OR v_stale) THEN
      -- The effect may already have left: never skip it silently.
      v_reason := 'outcome_unknown';
      v_status := 'failed';
    ELSIF v_floor THEN
      v_reason := 'rule_reenabled';
      v_status := 'skipped';
    ELSIF v_stale THEN
      v_reason := 'stale';
      v_status := 'skipped';
    END IF;

    IF v_reason IS NOT NULL THEN
      UPDATE public.automation_runs
         SET status      = v_status,
             error       = v_reason,
             finished_at = NOW()
       WHERE id = v_run.id;

      v_ev_type  := CASE v_status WHEN 'failed' THEN 'automation_failed' ELSE 'automation_skipped' END;
      v_ev_level := CASE v_status WHEN 'failed' THEN 'error' ELSE 'info' END;
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

-- ──────────────────────────────────────────────────────────
-- 9. append_contact_tags(workspace, contact, tags[]) — one atomic append
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
-- 10. mark_automation_run_dispatched(run, cooldown, cap)
--
-- Right before the provider call, in ONE transaction: the run is still ours
-- and not dispatched, its rule is still enabled, the conversation's contact is
-- opted in, this rule hasn't sent to this contact within the cooldown, and the
-- workspace is under its daily cap of automated sends. A reminder's cooldown
-- is per appointment instead (two appointments of one contact both get
-- theirs). Advisory locks serialize the checks per cooldown key and per
-- workspace, so two concurrent runs can't both slip under a limit. Returns:
--   'ok' | 'opted_out' | 'cooldown' | 'daily_cap' | 'rule_disabled'
--   'already_dispatched'  -> the effect already left once (outcome unknown)
--   'not_found'           -> the run is no longer ours, or its conversation
--                            or contact is gone
-- The contact the message goes to is recorded on the run (cooldown key).
-- ──────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.mark_automation_run_dispatched(UUID);

CREATE OR REPLACE FUNCTION public.mark_automation_run_dispatched(
  p_run_id         UUID,
  p_cooldown_hours INT,
  p_daily_cap      INT
)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_run        public.automation_runs;
  v_contact_id UUID;
  v_opt_in     BOOLEAN;
  v_phone      TEXT;
  v_subject_id UUID;
  v_count      INT;
BEGIN
  SELECT r.* INTO v_run
    FROM public.automation_runs r
   WHERE r.id = p_run_id
     FOR UPDATE;

  IF v_run.id IS NULL OR v_run.status <> 'processing' THEN
    RETURN 'not_found';
  END IF;
  IF v_run.dispatched_at IS NOT NULL THEN
    RETURN 'already_dispatched';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.automation_rules ru
     WHERE ru.id = v_run.rule_id
       AND ru.workspace_id = v_run.workspace_id
       AND ru.enabled
  ) THEN
    RETURN 'rule_disabled';
  END IF;

  SELECT ct.id, ct.opt_in, ct.phone
    INTO v_contact_id, v_opt_in, v_phone
    FROM public.conversations c
    JOIN public.contacts ct
      ON ct.id = c.contact_id
     AND ct.workspace_id = c.workspace_id
   WHERE c.id = v_run.conversation_id
     AND c.workspace_id = v_run.workspace_id;

  IF v_contact_id IS NULL THEN
    RETURN 'not_found';
  END IF;
  IF v_opt_in IS NOT TRUE OR EXISTS (
    SELECT 1 FROM public.contact_opt_outs o
     WHERE o.workspace_id = v_run.workspace_id
       AND o.phone_key = public.contact_phone_key(v_phone)
  ) THEN
    RETURN 'opted_out';
  END IF;

  IF p_cooldown_hours > 0 AND v_run.trigger_type = 'appointment_upcoming' THEN
    SELECT e.subject_id INTO v_subject_id
      FROM public.automation_events e
     WHERE e.id = v_run.event_id
       AND e.workspace_id = v_run.workspace_id;
    PERFORM pg_advisory_xact_lock(
      hashtextextended('automation_cooldown:' || v_run.rule_id::text || ':appt:' || coalesce(v_subject_id::text, ''), 0)
    );
    IF EXISTS (
      SELECT 1
        FROM public.automation_runs r2
        JOIN public.automation_events e2
          ON e2.id = r2.event_id
         AND e2.workspace_id = r2.workspace_id
       WHERE r2.rule_id = v_run.rule_id
         AND e2.subject_id = v_subject_id
         AND r2.id <> v_run.id
         AND r2.dispatched_at > NOW() - make_interval(hours => p_cooldown_hours)
    ) THEN
      RETURN 'cooldown';
    END IF;
  ELSIF p_cooldown_hours > 0 THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('automation_cooldown:' || v_run.rule_id::text || ':' || v_contact_id::text, 0)
    );
    IF EXISTS (
      SELECT 1 FROM public.automation_runs r2
       WHERE r2.rule_id = v_run.rule_id
         AND r2.contact_id = v_contact_id
         AND r2.id <> v_run.id
         AND r2.dispatched_at > NOW() - make_interval(hours => p_cooldown_hours)
    ) THEN
      RETURN 'cooldown';
    END IF;
  END IF;

  IF p_daily_cap > 0 THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('automation_daily_cap:' || v_run.workspace_id::text, 0)
    );
    SELECT count(*) INTO v_count
      FROM public.automation_runs r3
     WHERE r3.workspace_id = v_run.workspace_id
       AND r3.dispatched_at > NOW() - INTERVAL '24 hours';
    IF v_count >= p_daily_cap THEN
      RETURN 'daily_cap';
    END IF;
  END IF;

  UPDATE public.automation_runs
     SET dispatched_at = clock_timestamp(),
         contact_id    = v_contact_id
   WHERE id = v_run.id;
  RETURN 'ok';
END;
$$;

-- ──────────────────────────────────────────────────────────
-- 11. release_automation_run_dispatch(run)
--
-- Undoes the mark when the send provably did not happen (the outbound row
-- could not be queued, or the provider refused it for a reason that clears),
-- so the retry can send once. Only for a run still claimed.
-- ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.release_automation_run_dispatch(p_run_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_updated INT;
BEGIN
  UPDATE public.automation_runs
     SET dispatched_at = NULL
   WHERE id = p_run_id
     AND status = 'processing'
     AND dispatched_at IS NOT NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

-- ──────────────────────────────────────────────────────────
-- 11b. automation_rule_health(workspace) — what the tab shows per rule
--
-- The last finished run (status, cause, when) and the failures in the last
-- 24 hours, for each rule of one workspace. The server calls it after its own
-- membership check.
-- ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.automation_rule_health(p_workspace_id UUID)
RETURNS TABLE (
  rule_id          UUID,
  last_status      TEXT,
  last_error       TEXT,
  last_finished_at TIMESTAMPTZ,
  failures_24h     INT
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT ru.id,
         last.status,
         last.error,
         last.finished_at,
         (SELECT count(*)::int
            FROM public.automation_runs f
           WHERE f.workspace_id = ru.workspace_id
             AND f.rule_id = ru.id
             AND f.status = 'failed'
             AND f.finished_at > NOW() - INTERVAL '24 hours')
    FROM public.automation_rules ru
    LEFT JOIN LATERAL (
      SELECT r.status, r.error, r.finished_at
        FROM public.automation_runs r
       WHERE r.workspace_id = ru.workspace_id
         AND r.rule_id = ru.id
         AND r.finished_at IS NOT NULL
       ORDER BY r.finished_at DESC
       LIMIT 1
    ) last ON true
   WHERE ru.workspace_id = p_workspace_id;
$$;

-- ──────────────────────────────────────────────────────────
-- 12. Grants: service_role only, for every RPC. Revoke PUBLIC (inherited) and
-- anon/authenticated (direct), then grant service_role. Trigger functions
-- need no EXECUTE grant to fire.
-- ──────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.claim_next_automation_run()                          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.append_contact_tags(UUID, UUID, TEXT[])              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_automation_run_dispatched(UUID, INT, INT)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_automation_run_dispatch(UUID)                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.automation_event_ttl(TEXT)                           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.emit_automation_event_on_message()                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.emit_automation_event_on_state()                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.emit_automation_event_on_stage()                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_contact_opt_out()                               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_inbound_opt_out()                              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.opt_out_intent(TEXT)                                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.contact_phone_key(TEXT)                              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.automation_rule_health(UUID)                         FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_next_automation_run()                       TO service_role;
GRANT EXECUTE ON FUNCTION public.append_contact_tags(UUID, UUID, TEXT[])           TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_automation_run_dispatched(UUID, INT, INT)    TO service_role;
GRANT EXECUTE ON FUNCTION public.release_automation_run_dispatch(UUID)             TO service_role;
GRANT EXECUTE ON FUNCTION public.automation_event_ttl(TEXT)                        TO service_role;
GRANT EXECUTE ON FUNCTION public.automation_rule_health(UUID)                      TO service_role;
GRANT EXECUTE ON FUNCTION public.opt_out_intent(TEXT)                              TO service_role;
GRANT EXECUTE ON FUNCTION public.contact_phone_key(TEXT)                           TO service_role;

-- ============================================================
-- End of migration: 20261001000000_automation_engine
-- ============================================================
