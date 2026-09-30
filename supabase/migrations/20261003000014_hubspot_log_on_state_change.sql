-- ============================================================================
-- Migration: 20261003000014_hubspot_log_on_state_change
-- Every handoff and close reaches the HubSpot timeline queue.
--
-- The queue was fed by applyTransition() in the app, so a state change that
-- doesn't go through it — the dead-letter handoff in claim_next_batch()
-- (20260929000001), or any direct UPDATE — never reached HubSpot. The queue
-- is now fed by a trigger on conversations.state, in the same transaction as
-- the change, and the app no longer enqueues. Same identity as before:
-- (conversation_id, from_state_version), where from_state_version is the
-- version the conversation had BEFORE the change (OLD.state_version; the
-- BEFORE trigger trg_conversations_state_version bumps NEW). Queued only when
-- HubSpot is an enabled CRM of the workspace. A failure never breaks the
-- transition: it is a WARNING and, best effort, a hubspot_log_enqueue_failed
-- event.
-- SECURITY DEFINER: the table is service-role only, and a member's own
-- update of a conversation must still queue its entry.
-- ============================================================================

SET lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.enqueue_hubspot_log_on_state()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM public.integrations i
        WHERE i.workspace_id = NEW.workspace_id AND i.provider = 'hubspot' AND i.enabled
     )
  THEN
    INSERT INTO public.hubspot_conversation_logs (workspace_id, conversation_id, from_state_version, reason)
    VALUES (NEW.workspace_id, NEW.id, OLD.state_version,
            CASE WHEN NEW.state = 'closed' THEN 'closed' ELSE 'handoff' END)
    ON CONFLICT (conversation_id, from_state_version) DO NOTHING;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'hubspot_log_enqueue_failed: %', SQLERRM;
  -- Visible where people look, not only in the database log: an event, best
  -- effort (its own failure is swallowed too; the transition stands).
  BEGIN
    INSERT INTO public.events (type, level, workspace_id, conversation_id, payload)
    VALUES ('hubspot_log_enqueue_failed', 'error', NEW.workspace_id, NEW.id,
            jsonb_build_object('provider', 'hubspot', 'to', NEW.state, 'code', SQLSTATE));
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_hubspot_log_on_state() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_conversations_hubspot_log ON public.conversations;
CREATE TRIGGER trg_conversations_hubspot_log
  AFTER UPDATE OF state ON public.conversations
  FOR EACH ROW
  WHEN (NEW.state IS DISTINCT FROM OLD.state AND NEW.state IN ('handoff_pending', 'closed'))
  EXECUTE FUNCTION public.enqueue_hubspot_log_on_state();

RESET lock_timeout;

-- ============================================================================
-- End of migration: 20261003000014_hubspot_log_on_state_change
-- ============================================================================
