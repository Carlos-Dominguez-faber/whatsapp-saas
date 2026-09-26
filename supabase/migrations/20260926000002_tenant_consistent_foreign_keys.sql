-- ============================================================
-- Migration: 20260926000002_tenant_consistent_foreign_keys
-- Agente WhatsApp — a row may only point at rows of its own workspace
--
-- Every tenant table carries workspace_id, and the RLS write policies check
-- that column — but the foreign keys to conversations, contacts, prompts, etc.
-- were plain single-column FKs. So a member of workspace A could write a row
-- that is "in A" yet points at B's data, e.g. PATCH a message_batches row of A
-- to conversation_id = <B's conversation>: the buffer then ran B's
-- conversation (history into A's LLM, state transitions, contact updates), or
-- INSERT a message "in A" into B's thread, which B's bot then read as its own
-- words. The service-role pipeline trusts these pairs, so the database must
-- guarantee them.
--
-- Each single-column FK is replaced by a composite (workspace_id, <ref>) FK to
-- a UNIQUE (workspace_id, id) key on the referenced table, keeping the original
-- ON DELETE behaviour (SET NULL is limited to the reference column, PG15+).
-- Replacing — rather than stacking a second FK — keeps a single referential
-- action per relationship. The composite keys also freeze workspace_id on
-- referenced rows that are in use (ON UPDATE NO ACTION).
--
-- Exception: agents.prompt_id, prompts.active_version_id and
-- prompt_versions.prompt_id keep their single-column FKs, because the app
-- embeds them through PostgREST column hints (prompts!prompt_id,
-- prompt_versions!active_version_id), which only resolve against a
-- single-column FK — swapping them would break every prompt lookup, including
-- the code that still runs between `db push` and the redeploy. Those three are
-- guarded by a trigger instead (section 4).
--
-- Constraints are added NOT VALID (enforced for every new write immediately)
-- and then validated; if an existing install already holds cross-workspace
-- rows, validation is skipped with a WARNING instead of failing the upgrade.
-- ============================================================

-- 1. UNIQUE (workspace_id, id) on every referenced table (idempotent).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'conversations', 'contacts', 'message_batches', 'templates', 'schedules',
    'kb_documents'
  ] LOOP
    IF to_regclass('public.' || t) IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = ('public.' || t)::regclass
         AND conname = 'uq_' || t || '_workspace_id'
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I UNIQUE (workspace_id, id)',
        t, 'uq_' || t || '_workspace_id'
      );
    END IF;
  END LOOP;
END
$$;

-- 2. Swap each single-column FK for its workspace-consistent composite.
DO $$
DECLARE
  -- table, old FK name, reference column, referenced table, ON DELETE action
  fk text[];
  fks text[][] := ARRAY[
    ['message_batches', 'message_batches_conversation_id_fkey', 'conversation_id', 'conversations',   'CASCADE'],
    ['messages',        'messages_conversation_id_fkey',        'conversation_id', 'conversations',   'CASCADE'],
    ['messages',        'messages_batch_id_fkey',               'batch_id',        'message_batches', 'SET NULL'],
    ['messages',        'fk_messages_template',                 'template_id',     'templates',       'SET NULL'],
    ['events',          'events_conversation_id_fkey',          'conversation_id', 'conversations',   'SET NULL'],
    ['conversations',   'conversations_contact_id_fkey',        'contact_id',      'contacts',        'CASCADE'],
    ['appointments',    'appointments_contact_id_fkey',         'contact_id',      'contacts',        'SET NULL'],
    ['appointments',    'appointments_conversation_id_fkey',    'conversation_id', 'conversations',   'SET NULL'],
    ['appointments',    'appointments_schedule_id_fkey',        'schedule_id',     'schedules',       'SET NULL'],
    ['kb_chunks',       'kb_chunks_document_id_fkey',           'document_id',     'kb_documents',    'CASCADE']
  ];
  new_name text;
  on_delete text;
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION 'This migration needs Postgres 15+ (ON DELETE SET NULL (column)). Upgrade it in Supabase → Settings → Infrastructure, then run db push again.';
  END IF;

  FOREACH fk SLICE 1 IN ARRAY fks LOOP
    CONTINUE WHEN to_regclass('public.' || fk[1]) IS NULL
               OR to_regclass('public.' || fk[4]) IS NULL;

    new_name := 'fk_' || fk[1] || '_' || fk[3] || '_same_workspace';
    on_delete := CASE fk[5]
      WHEN 'SET NULL' THEN format('SET NULL (%I)', fk[3])
      ELSE fk[5]
    END;

    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', fk[1], fk[2]);
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', fk[1], new_name);
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (workspace_id, %I) '
      'REFERENCES public.%I (workspace_id, id) ON DELETE %s NOT VALID',
      fk[1], new_name, fk[3], fk[4], on_delete
    );
  END LOOP;
END
$$;

-- 3. Validate existing rows; never block the upgrade on legacy bad rows.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT conrelid::regclass AS tbl, conname
      FROM pg_constraint
     WHERE connamespace = 'public'::regnamespace
       AND contype = 'f'
       AND conname LIKE 'fk\_%\_same\_workspace'
       AND NOT convalidated
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', r.tbl, r.conname);
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE WARNING
        '% on %: existing rows point at another workspace; the constraint still guards new writes. See the audit queries in INSTALAR.md (Actualizar).',
        r.conname, r.tbl;
    END;
  END LOOP;
END
$$;

-- 4. The prompt family keeps its single-column FKs (see header); a trigger
--    enforces the same rule, and workspace_id is frozen on those rows so a
--    referenced prompt or version cannot be moved out from under its users.
CREATE OR REPLACE FUNCTION public.enforce_same_workspace_ref()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  ref_table text := TG_ARGV[0];
  ref_col   text := TG_ARGV[1];
  ref_id    uuid := (to_jsonb(NEW) ->> ref_col)::uuid;
  found     boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION '%.workspace_id cannot change', TG_TABLE_NAME
      USING ERRCODE = '23503';
  END IF;
  IF ref_id IS NULL THEN
    RETURN NEW;
  END IF;
  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM public.%I WHERE id = $1 AND workspace_id = $2)',
    ref_table
  ) INTO found USING ref_id, NEW.workspace_id;
  IF NOT found THEN
    RAISE EXCEPTION '%.% must reference a % row of workspace %',
      TG_TABLE_NAME, ref_col, ref_table, NEW.workspace_id
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.enforce_same_workspace_ref() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_agents_prompt_same_workspace ON public.agents;
CREATE TRIGGER trg_agents_prompt_same_workspace
  BEFORE INSERT OR UPDATE ON public.agents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_workspace_ref('prompts', 'prompt_id');

DROP TRIGGER IF EXISTS trg_prompts_active_version_same_workspace ON public.prompts;
CREATE TRIGGER trg_prompts_active_version_same_workspace
  BEFORE INSERT OR UPDATE ON public.prompts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_workspace_ref('prompt_versions', 'active_version_id');

DROP TRIGGER IF EXISTS trg_prompt_versions_prompt_same_workspace ON public.prompt_versions;
CREATE TRIGGER trg_prompt_versions_prompt_same_workspace
  BEFORE INSERT OR UPDATE ON public.prompt_versions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_workspace_ref('prompts', 'prompt_id');

-- Triggers only guard new writes: flag legacy cross-workspace rows.
DO $$
DECLARE
  bad int;
BEGIN
  SELECT
    (SELECT count(*) FROM public.agents a
       JOIN public.prompts p ON p.id = a.prompt_id
      WHERE p.workspace_id <> a.workspace_id)
  + (SELECT count(*) FROM public.prompts p
       JOIN public.prompt_versions v ON v.id = p.active_version_id
      WHERE v.workspace_id <> p.workspace_id)
  + (SELECT count(*) FROM public.prompt_versions v
       JOIN public.prompts p ON p.id = v.prompt_id
      WHERE p.workspace_id <> v.workspace_id)
  INTO bad;
  IF bad > 0 THEN
    RAISE WARNING
      '% agents/prompts/prompt_versions rows point at another workspace. See the audit queries in INSTALAR.md (Actualizar).',
      bad;
  END IF;
END
$$;

-- 5. message_batches is written only by the service-role buffer pipeline;
--    users have no business writing it directly.
REVOKE INSERT, UPDATE, DELETE ON public.message_batches FROM anon, authenticated;

-- ============================================================
-- End of migration: 20260926000002_tenant_consistent_foreign_keys
-- ============================================================
