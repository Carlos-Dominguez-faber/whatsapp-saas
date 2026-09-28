-- ============================================================
-- Migration: 20260930000007_retire_custom_webhook
-- custom_webhook is retired: n8n tools (n8n_tools) replace it.
--
-- custom_webhook was `sensitive`, so the registry never ran it (it waited for
-- an approval no screen gives). Each workspace's config becomes an n8n tool,
-- DISABLED, for an admin to review and activate in Configuración → n8n:
--   - name: webhook_personalizado (with _2, _3... if the workspace uses it);
--   - the same URL; mode async (custom_webhook never read the answer);
--     write; 8 s, like custom_webhook;
--   - one optional parameter, `note`, the only argument the model gave it;
--   - the description says it was migrated and what changed: the workflow
--     now gets workspace_id, conversation_id, contact_id, idempotency_key and
--     args.note, not the old `payload` built from template fields. The model
--     reads that description, so it names the old fields' KEYS only, and a
--     value only when it is a single {{variable}}: a fixed value may be a
--     secret (token=sk_live_...).
-- custom_webhook's config had no auth header; one found there anyway
-- (auth_header_name + auth_header_value) is carried in plaintext, which
-- scripts/encrypt-credentials.mjs encrypts on its next run (sessions never
-- read that column, see 20260930000001), if it passes the API's rules; if
-- not it is dropped and a NOTICE says so (the runner checks again).
-- Then its tool_configs rows and its catalog row go. A NOTICE gives the
-- count.
--
-- The work is a function, kept (callable only by the service role) so
-- pgTAP can exercise it; a second run finds no catalog row and does nothing.
-- #11 deleted custom_webhook in 20260830000001, which main never had:
-- scripts/setup.mjs marks that version reverted.
-- ============================================================

CREATE OR REPLACE FUNCTION public.retire_custom_webhook()
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tool_id UUID;
  v_config RECORD;
  v_url TEXT;
  v_name TEXT;
  v_suffix INT;
  v_fields TEXT;
  v_header_name TEXT;
  v_header_value TEXT;
  v_migrated INT := 0;
  v_dropped INT := 0;
BEGIN
  SELECT id INTO v_tool_id FROM public.tools WHERE key = 'custom_webhook';
  IF v_tool_id IS NULL THEN
    RETURN 0;
  END IF;

  FOR v_config IN
    SELECT workspace_id, config FROM public.tool_configs WHERE tool_id = v_tool_id
  LOOP
    v_url := btrim(coalesce(v_config.config->>'webhook_url', ''));
    -- Never configured: nothing to carry over.
    CONTINUE WHEN v_url = '';

    v_name := 'webhook_personalizado';
    v_suffix := 1;
    WHILE EXISTS (
      SELECT 1 FROM public.n8n_tools
       WHERE workspace_id = v_config.workspace_id AND name = v_name
    ) LOOP
      v_suffix := v_suffix + 1;
      v_name := 'webhook_personalizado_' || v_suffix;
    END LOOP;

    SELECT string_agg(
             CASE WHEN f->>'value' ~ '^\s*\{\{\s*[A-Za-z0-9_.]+\s*\}\}\s*$'
                  THEN format('%s=%s', f->>'key', btrim(f->>'value'))
                  ELSE format('%s (valor fijo, no se copia)', f->>'key') END,
             ', ')
      INTO v_fields
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(v_config.config->'payload_fields') = 'array'
             THEN v_config.config->'payload_fields' ELSE '[]'::jsonb END
      ) AS f;

    v_header_name := nullif(btrim(coalesce(v_config.config->>'auth_header_name', '')), '');
    v_header_value := nullif(v_config.config->>'auth_header_value', '');
    IF v_header_name IS NULL OR v_header_value IS NULL THEN
      v_header_name := NULL;
      v_header_value := NULL;
    -- The API's rules (n8n-secrets.ts): a plain header name that doesn't
    -- describe the request itself, and a value without line breaks or other
    -- control characters.
    ELSIF v_header_name !~ '^[A-Za-z0-9-]{1,100}$'
       OR lower(v_header_name) IN ('host', 'content-length', 'content-type',
            'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'te',
            'trailer', 'proxy-authorization', 'proxy-connection', 'expect', 'cookie')
       OR length(v_header_value) > 2000
       OR v_header_value ~ E'[\\x01-\\x08\\x0a-\\x1f\\x7f]' THEN
      RAISE NOTICE 'custom_webhook: workspace %: its auth header breaks the n8n rules and was not carried over; set it in Configuración → n8n.',
        v_config.workspace_id;
      v_header_name := NULL;
      v_header_value := NULL;
      v_dropped := v_dropped + 1;
    END IF;

    INSERT INTO public.n8n_tools (
      workspace_id, name, description, mode, sensitivity, webhook_url,
      auth_header_name, auth_header_value, parameters, timeout_ms, enabled
    ) VALUES (
      v_config.workspace_id,
      v_name,
      left(
        'Avisa a un sistema externo del negocio (un webhook). '
        || 'Úsalo cuando debas notificar o registrar al contacto en ese sistema. '
        || '[Migrada desde custom_webhook — revisa antes de activar: el webhook ahora recibe '
        || 'workspace_id, conversation_id, contact_id, idempotency_key y args.note, '
        || 'no los datos del contacto'
        || CASE WHEN v_fields IS NOT NULL THEN '; antes recibía payload con ' || v_fields ELSE '' END
        || ']',
        500
      ),
      'async',
      'write',
      v_url,
      v_header_name,
      v_header_value,
      '[{"key": "note", "label": "Nota", "type": "string", "required": false,
         "description": "Nota corta opcional para incluir en el webhook"}]'::jsonb,
      8000,
      FALSE
    );
    v_migrated := v_migrated + 1;
  END LOOP;

  DELETE FROM public.tool_configs WHERE tool_id = v_tool_id;
  DELETE FROM public.tools WHERE id = v_tool_id;
  RETURN v_migrated;
END;
$$;

REVOKE ALL ON FUNCTION public.retire_custom_webhook() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retire_custom_webhook() TO service_role;

DO $$
DECLARE
  v_count INT;
BEGIN
  v_count := public.retire_custom_webhook();
  RAISE NOTICE 'custom_webhook: % configuration(s) moved to n8n_tools, disabled: review and activate them in Configuración → n8n.', v_count;
END
$$;

-- ============================================================
-- End of migration: 20260930000007_retire_custom_webhook
-- ============================================================
