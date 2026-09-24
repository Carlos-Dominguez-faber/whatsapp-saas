-- ============================================================
-- Migration: 20260830000000_n8n_tools
-- Agente WhatsApp — dynamic n8n workflow tools, per workspace.
-- Each row IS a full Tool (unlike tool_configs, which stores config for a
-- tool fixed in code).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.n8n_tools (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL,
  mode               TEXT NOT NULL CHECK (mode IN ('sync', 'async')),
  sensitivity        TEXT NOT NULL CHECK (sensitivity IN ('read', 'write')),
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

CREATE INDEX IF NOT EXISTS idx_n8n_tools_workspace ON public.n8n_tools(workspace_id, enabled);

CREATE TRIGGER trg_n8n_tools_updated_at
  BEFORE UPDATE ON public.n8n_tools
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.n8n_tools ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ws members read n8n_tools" ON public.n8n_tools
  FOR SELECT USING (workspace_id IN (SELECT auth_workspace_ids()));

CREATE POLICY "ws admins manage n8n_tools" ON public.n8n_tools
  FOR ALL USING (
    workspace_id IN (SELECT auth_workspace_ids())
    AND auth_has_role(workspace_id, ARRAY['admin']::workspace_role[])
  ) WITH CHECK (
    workspace_id IN (SELECT auth_workspace_ids())
    AND auth_has_role(workspace_id, ARRAY['admin']::workspace_role[])
  );
