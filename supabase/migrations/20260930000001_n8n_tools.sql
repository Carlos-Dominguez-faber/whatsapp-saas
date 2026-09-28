-- ============================================================
-- Migration: 20260930000001_n8n_tools
-- Agente WhatsApp — dynamic n8n workflow tools, per workspace (PR #11).
--
-- Each row IS a full Tool (unlike tool_configs, which stores config for a
-- tool fixed in code). auth_header_value is a secret, stored encrypted by the
-- app (AES-256-GCM, AAD "<workspace_id>:n8n_tool").
--
-- Idempotent, also over installs that ran #11's own migration
-- (20260830000000, on provider/kapso — setup.mjs db-push marks it reverted):
-- the table is kept as is and only its policies and grants are replaced.
--
-- Access: the app reads and writes this table with the service role, after
-- checking the caller is an admin. Sessions only get SELECT, on every column
-- but the secret, and RLS limits it to admins of the workspace.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.n8n_tools (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL,
  mode               TEXT NOT NULL CHECK (mode IN ('sync', 'async')),
  sensitivity        TEXT NOT NULL DEFAULT 'write' CHECK (sensitivity IN ('read', 'write')),
  webhook_url        TEXT NOT NULL,
  auth_header_name   TEXT,
  auth_header_value  TEXT,
  parameters         JSONB NOT NULL DEFAULT '[]',
  timeout_ms         INT NOT NULL DEFAULT 8000 CHECK (timeout_ms BETWEEN 1000 AND 15000),
  enabled            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, name)
);

-- #11's table had no default: new rows are write tools unless marked read.
ALTER TABLE public.n8n_tools ALTER COLUMN sensitivity SET DEFAULT 'write';

CREATE INDEX IF NOT EXISTS idx_n8n_tools_workspace ON public.n8n_tools(workspace_id, enabled);

DROP TRIGGER IF EXISTS trg_n8n_tools_updated_at ON public.n8n_tools;
CREATE TRIGGER trg_n8n_tools_updated_at
  BEFORE UPDATE ON public.n8n_tools
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.n8n_tools ENABLE ROW LEVEL SECURITY;

-- #11 let every member read rows (secret included) and admins write them.
DROP POLICY IF EXISTS "ws members read n8n_tools" ON public.n8n_tools;
DROP POLICY IF EXISTS "ws admins manage n8n_tools" ON public.n8n_tools;
DROP POLICY IF EXISTS "n8n_tools_select_admins" ON public.n8n_tools;

CREATE POLICY "n8n_tools_select_admins" ON public.n8n_tools
  FOR SELECT USING (
    workspace_id IN (SELECT public.auth_workspace_ids())
    AND public.auth_has_role(workspace_id, ARRAY['admin']::public.workspace_role[])
  );

-- A column-level REVOKE does nothing under a table-level grant, so the
-- table-level grants go and SELECT comes back column by column, without the
-- secret. No INSERT/UPDATE/DELETE for sessions: writes go through the API.
REVOKE ALL ON public.n8n_tools FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  id, workspace_id, name, description, mode, sensitivity, webhook_url,
  auth_header_name, parameters, timeout_ms, enabled, created_at, updated_at
) ON public.n8n_tools TO authenticated;
GRANT ALL ON public.n8n_tools TO service_role;

-- ============================================================
-- End of migration: 20260930000001_n8n_tools
-- ============================================================
