-- ============================================================
-- Migration: 20260927000002_save_whatsapp_integration_rpc
-- Agente WhatsApp — save (and switch) a workspace's WhatsApp provider in ONE
-- transaction
--
-- Switching YCloud ↔ Kapso used to be two writes from the API route: disable
-- the active row, then upsert the new one. A failure between them left the
-- workspace with no WhatsApp at all. This function does both in a single
-- transaction, and also carries the workspace-level settings over:
--
--   config = this provider's own row
--            − the workspace-level keys (only when switching: whatever that
--              row remembered from an earlier stint must not come back)
--            ‖ the workspace-level keys of the provider being replaced
--            ‖ what the caller sends (wins)
--
-- The caller (service role only) passes the credentials already merged and
-- encrypted; this function never sees plaintext.
-- ============================================================

CREATE OR REPLACE FUNCTION public.save_whatsapp_integration(
  p_workspace_id   uuid,
  p_provider       public.integration_provider,
  p_enabled        boolean,
  p_credentials    jsonb,
  p_config         jsonb,
  p_workspace_keys text[]
)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_own_config      jsonb;
  v_active_id       uuid;
  v_active_provider text;
  v_active_config   jsonb;
  v_carried         jsonb := '{}'::jsonb;
BEGIN
  IF p_provider::text NOT IN ('ycloud', 'kapso') THEN
    RAISE EXCEPTION 'not a WhatsApp provider: %', p_provider USING ERRCODE = '22023';
  END IF;

  -- Lock the workspace's WhatsApp rows in a fixed order, so two concurrent
  -- saves queue up instead of deadlocking.
  PERFORM 1
     FROM public.integrations
    WHERE workspace_id = p_workspace_id
      AND provider IN ('ycloud', 'kapso')
    ORDER BY provider
      FOR UPDATE;

  SELECT config
    INTO v_own_config
    FROM public.integrations
   WHERE workspace_id = p_workspace_id
     AND provider = p_provider;
  v_own_config := coalesce(v_own_config, '{}'::jsonb);

  IF p_enabled THEN
    SELECT id, provider::text, config
      INTO v_active_id, v_active_provider, v_active_config
      FROM public.integrations
     WHERE workspace_id = p_workspace_id
       AND provider IN ('ycloud', 'kapso')
       AND provider <> p_provider
       AND enabled;

    IF v_active_id IS NOT NULL THEN
      SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
        INTO v_carried
        FROM jsonb_each(coalesce(v_active_config, '{}'::jsonb))
       WHERE key = ANY (p_workspace_keys);

      v_own_config := v_own_config - coalesce(p_workspace_keys, '{}'::text[]);

      UPDATE public.integrations
         SET enabled = false, updated_at = now()
       WHERE id = v_active_id;
    END IF;
  END IF;

  INSERT INTO public.integrations
    (workspace_id, provider, enabled, credentials, config, updated_at)
  VALUES
    (p_workspace_id, p_provider, p_enabled, coalesce(p_credentials, '{}'::jsonb),
     v_own_config || v_carried || coalesce(p_config, '{}'::jsonb), now())
  ON CONFLICT (workspace_id, provider) DO UPDATE
    SET enabled     = EXCLUDED.enabled,
        credentials = EXCLUDED.credentials,
        config      = EXCLUDED.config,
        updated_at  = EXCLUDED.updated_at;

  -- The provider this workspace stopped using, or NULL when nothing switched.
  RETURN v_active_provider;
END;
$$;

REVOKE ALL ON FUNCTION public.save_whatsapp_integration(uuid, public.integration_provider, boolean, jsonb, jsonb, text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_whatsapp_integration(uuid, public.integration_provider, boolean, jsonb, jsonb, text[])
  TO service_role;

-- ============================================================
-- End of migration: 20260927000002_save_whatsapp_integration_rpc
-- ============================================================
