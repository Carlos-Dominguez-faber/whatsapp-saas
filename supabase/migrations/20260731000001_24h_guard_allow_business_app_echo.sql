-- 24h window guard (SEC-04) — allow WhatsApp Business App echoes through.
--
-- With Kapso in coexistence mode the business also answers from the WhatsApp
-- Business App on a phone. Kapso echoes those messages back to us as
-- `whatsapp.message.sent` with kapso.origin = 'business_app', and we record them
-- so the inbox reflects reality.
--
-- Such a row is a RECORD OF A MESSAGE WHATSAPP ALREADY DELIVERED, not an attempt
-- to send one. Blocking it would only make our history wrong while the customer
-- has the message on their phone. Meta already enforces the 24h rule on the
-- Business App itself, so nothing new gets past the guard here: this only ever
-- lets us write down something that already happened.
--
-- Everything else is unchanged — app-initiated free text outside the window
-- still raises WINDOW_EXPIRED.

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
