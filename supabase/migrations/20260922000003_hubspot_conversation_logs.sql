-- Cola del registro de conversaciones en el timeline de HubSpot. applyTransition solo ENCOLA (un
-- INSERT, idempotente por transición); la llamada a HubSpot la hace la fase hubspotLogs de
-- cron/automations, con lease, intentos acotados y deadline por llamada.
-- Solo service_role: RLS activada, sin policies, y RPC revocadas a anon/authenticated.

CREATE TABLE IF NOT EXISTS public.hubspot_conversation_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  -- Identidad de la transición: el CAS de applyTransition compara state_version, así que cada
  -- versión transiciona una sola vez.
  from_state_version INT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('handoff', 'closed')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed', 'cancelled')),
  attempts INT NOT NULL DEFAULT 0,
  -- Lease mientras se procesa, y "no antes de" (backoff) cuando vuelve a pending.
  claimed_until TIMESTAMPTZ,
  -- Solo CÓDIGOS (unauthorized, timeout, …), nunca texto de HubSpot ni err.message.
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_hubspot_conversation_logs_transition UNIQUE (conversation_id, from_state_version)
);

CREATE INDEX IF NOT EXISTS idx_hubspot_conversation_logs_pending
  ON public.hubspot_conversation_logs (created_at) WHERE status = 'pending';

ALTER TABLE public.hubspot_conversation_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.hubspot_conversation_logs FROM anon, authenticated;

-- Encola SOLO si HubSpot es un CRM habilitado del workspace (con el índice de un-solo-CRM, es
-- EL activo) y si la conversación es de ese workspace. Idempotente por transición.
CREATE OR REPLACE FUNCTION public.enqueue_hubspot_conversation_log(
  p_workspace_id UUID,
  p_conversation_id UUID,
  p_from_state_version INT,
  p_reason TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
VOLATILE
SET search_path = ''
AS $$
  WITH ins AS (
    INSERT INTO public.hubspot_conversation_logs (workspace_id, conversation_id, from_state_version, reason)
    SELECT p_workspace_id, p_conversation_id, p_from_state_version, p_reason
     WHERE EXISTS (SELECT 1 FROM public.integrations i
                    WHERE i.workspace_id = p_workspace_id AND i.provider = 'hubspot' AND i.enabled)
       AND EXISTS (SELECT 1 FROM public.conversations c
                    WHERE c.id = p_conversation_id AND c.workspace_id = p_workspace_id)
    ON CONFLICT (conversation_id, from_state_version) DO NOTHING
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM ins);
$$;

-- Reclama UNA fila disponible (pending y sin lease vigente). SKIP LOCKED reparte entre corridas
-- simultáneas; claimed_until hace que la segunda ni la vea. attempts sube al reclamar: si la
-- función muere, el intento cuenta igual.
CREATE OR REPLACE FUNCTION public.claim_hubspot_conversation_log(p_lease_seconds INT DEFAULT 120)
RETURNS TABLE (id UUID, workspace_id UUID, conversation_id UUID, reason TEXT, attempts INT)
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_id UUID;
  v_lease INTERVAL := make_interval(secs => LEAST(GREATEST(COALESCE(p_lease_seconds, 120), 30), 600));
BEGIN
  SELECT l.id INTO v_id
    FROM public.hubspot_conversation_logs l
   WHERE l.status = 'pending'
     AND (l.claimed_until IS NULL OR l.claimed_until < now())
   ORDER BY l.created_at
   LIMIT 1
   FOR UPDATE SKIP LOCKED;
  IF v_id IS NULL THEN
    RETURN;
  END IF;

  -- FIFO global, sin round-robin por workspace; con el volumen de traspasos no hay
  -- acaparamiento real. Si aparece, copiar el round-robin de claim_next_automation_run.
  RETURN QUERY
  UPDATE public.hubspot_conversation_logs l
     SET claimed_until = now() + v_lease,
         attempts = l.attempts + 1,
         updated_at = now()
   WHERE l.id = v_id
  RETURNING l.id, l.workspace_id, l.conversation_id, l.reason, l.attempts;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_hubspot_conversation_log(UUID, UUID, INT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_hubspot_conversation_log(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_hubspot_conversation_log(UUID, UUID, INT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_hubspot_conversation_log(INT) TO service_role;
