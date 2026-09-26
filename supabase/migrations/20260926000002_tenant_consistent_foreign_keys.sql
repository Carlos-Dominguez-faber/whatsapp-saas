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
    'prompts', 'prompt_versions', 'kb_documents'
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
    ['agents',          'agents_prompt_id_fkey',                'prompt_id',       'prompts',         'SET NULL'],
    ['prompt_versions', 'prompt_versions_prompt_id_fkey',       'prompt_id',       'prompts',         'CASCADE'],
    ['prompts',         'fk_prompts_active_version',            'active_version_id', 'prompt_versions', 'SET NULL'],
    ['kb_chunks',       'kb_chunks_document_id_fkey',           'document_id',     'kb_documents',    'CASCADE']
  ];
  new_name text;
  on_delete text;
BEGIN
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

-- 4. message_batches is written only by the service-role buffer pipeline;
--    users have no business writing it directly.
REVOKE INSERT, UPDATE, DELETE ON public.message_batches FROM anon, authenticated;

-- ============================================================
-- End of migration: 20260926000002_tenant_consistent_foreign_keys
-- ============================================================
