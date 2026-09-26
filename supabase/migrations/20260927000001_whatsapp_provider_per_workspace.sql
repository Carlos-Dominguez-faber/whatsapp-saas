-- ============================================================
-- Migration: 20260927000001_whatsapp_provider_per_workspace
-- Agente WhatsApp — one active WhatsApp provider per workspace
--
-- 1. At most ONE enabled WhatsApp integration (ycloud or kapso) per workspace:
--    everything that sends or reads WhatsApp settings resolves "the" active
--    row. Switching providers disables the old row (kept, with its
--    credentials, so switching back needs no re-entry).
--
-- 2. The outbound 24h guard learns two things that are records, not sends:
--    - Kapso coexistence echoes (a human answering from the WhatsApp Business
--      App on their phone: already delivered by WhatsApp) — from the old
--      provider/kapso branch (20260731000001);
--    - internal notes (type 'system', meta.internal), which are never sent;
--      they used to fail once the conversation's 24h window had closed.
-- ============================================================

-- 1a. Installs coming from provider/kapso may still have an enabled YCloud
--     row next to their Kapso one. Kapso is the one they were using there.
DO $$
DECLARE
  n int;
BEGIN
  UPDATE public.integrations y
     SET enabled = false, updated_at = now()
    FROM public.integrations k
   WHERE y.workspace_id = k.workspace_id
     AND y.provider = 'ycloud' AND y.enabled
     AND k.provider = 'kapso' AND k.enabled;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE NOTICE '% workspace(s) had YCloud and Kapso both enabled; kept Kapso active.', n;
  END IF;
END
$$;

-- 1b. The rule itself.
CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_one_active_whatsapp
  ON public.integrations (workspace_id)
  WHERE enabled AND provider IN ('ycloud', 'kapso');

-- 2. 24h guard.
CREATE OR REPLACE FUNCTION public.check_outbound_24h_window()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  conv_window_expires_at TIMESTAMPTZ;
  conv_workspace_id UUID;
BEGIN
  -- Only enforce on outbound non-template messages
  IF NEW.direction <> 'out' OR NEW.type = 'template' THEN
    RETURN NEW;
  END IF;

  -- Echo of a message sent from the WhatsApp Business App (coexistence):
  -- already delivered by WhatsApp, so this is bookkeeping, not a send.
  IF NEW.meta ->> 'origin' = 'business_app' THEN
    RETURN NEW;
  END IF;

  -- Internal notes are never sent to the contact.
  IF NEW.type = 'system' AND (NEW.meta ->> 'internal')::boolean IS TRUE THEN
    RETURN NEW;
  END IF;

  SELECT window_expires_at, workspace_id
    INTO conv_window_expires_at, conv_workspace_id
    FROM public.conversations
   WHERE id = NEW.conversation_id;

  -- No window set (null) → allow (first interaction)
  IF conv_window_expires_at IS NULL THEN
    RETURN NEW;
  END IF;

  -- Window open → allow
  IF NOW() <= conv_window_expires_at THEN
    RETURN NEW;
  END IF;

  -- Window expired: check for admin override flag
  IF (NEW.meta ->> 'override_admin')::boolean IS TRUE THEN
    -- Log the override event
    INSERT INTO public.events (workspace_id, conversation_id, type, level, payload)
    VALUES (
      conv_workspace_id,
      NEW.conversation_id,
      'WINDOW_OVERRIDE',
      'warn',
      jsonb_build_object('sender_user_id', NEW.sender_user_id, 'body_preview', left(COALESCE(NEW.body,''), 40))
    );
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'WINDOW_EXPIRED: free text outside 24h window. Use an approved template.';
END;
$$;

-- CREATE OR REPLACE keeps the grants 20260926000001 left (none for PUBLIC,
-- anon or authenticated); restate them so this file stands on its own.
REVOKE ALL ON FUNCTION public.check_outbound_24h_window() FROM PUBLIC, anon, authenticated;

-- ============================================================
-- End of migration: 20260927000001_whatsapp_provider_per_workspace
-- ============================================================
