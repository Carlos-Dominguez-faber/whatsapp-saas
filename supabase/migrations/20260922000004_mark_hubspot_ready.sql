-- "Probar conexión" de HubSpot: marca la integración lista SOLO para el token que se probó y ata
-- los enlaces de contactos a la cuenta (portal) de HubSpot.
--
-- Condicional por config->>'token_fingerprint' (la escribe el PUT al recibir un token nuevo): si
-- un PUT cambió el token mientras la prueba corría, no se marca nada. Todo en una transacción: el
-- UPDATE de config de ESTA función es un merge (config || jsonb_build_object(...)) sobre la fila
-- vigente, así que no pierde un pipeline que un PUT concurrente ya guardó. Y si el portal cambió,
-- los hs_contact_id de la cuenta anterior se limpian y los registros pendientes se cancelan, sin
-- ventana en que un sync use un id de la cuenta vieja contra la nueva.
--
-- La dirección contraria (un PUT en vuelo que leyó config antes de esta función) la cubre el PUT
-- (route.ts): escribe con CAS sobre updated_at y responde 409 si esta función movió la fila.
CREATE OR REPLACE FUNCTION public.mark_hubspot_ready(
  p_workspace_id UUID,
  p_token_fingerprint TEXT,
  p_portal_id TEXT
)
RETURNS TABLE (updated BOOLEAN, portal_changed BOOLEAN, links_cleared INT, logs_cancelled INT)
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
  v_old_portal TEXT;
  v_links INT := 0;
  v_logs INT := 0;
  v_changed BOOLEAN;
BEGIN
  SELECT i.config->>'portal_id' INTO v_old_portal
    FROM public.integrations i
   WHERE i.workspace_id = p_workspace_id
     AND i.provider = 'hubspot'
     AND i.config->>'token_fingerprint' = p_token_fingerprint
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, false, 0, 0;
    RETURN;
  END IF;

  v_changed := v_old_portal IS NOT NULL AND v_old_portal <> p_portal_id;
  IF v_changed THEN
    UPDATE public.contacts c
       SET hs_contact_id = NULL, updated_at = now()
     WHERE c.workspace_id = p_workspace_id AND c.hs_contact_id IS NOT NULL;
    GET DIAGNOSTICS v_links = ROW_COUNT;

    UPDATE public.hubspot_conversation_logs l
       SET status = 'cancelled', last_error = 'portal_changed', claimed_until = NULL, updated_at = now()
     WHERE l.workspace_id = p_workspace_id AND l.status = 'pending';
    GET DIAGNOSTICS v_logs = ROW_COUNT;
  END IF;

  UPDATE public.integrations i
     SET config = i.config || jsonb_build_object('properties_ready', true, 'portal_id', p_portal_id),
         updated_at = now()
   WHERE i.workspace_id = p_workspace_id AND i.provider = 'hubspot';

  RETURN QUERY SELECT true, v_changed, v_links, v_logs;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_hubspot_ready(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_hubspot_ready(UUID, TEXT, TEXT) TO service_role;

-- Enlace contacto local → contacto de HubSpot.
--
-- pushContactToHubSpot resuelve el id de HubSpot con el token que LEYÓ al empezar; si en el medio
-- un PUT cambió el token (otra cuenta, properties_ready vuelve a false), un UPDATE directo dejaría
-- enlazado un id de la cuenta vieja. Por eso el enlace se escribe en UNA sentencia condicionada a
-- que la huella del token siga vigente y la integración esté lista. FOR SHARE sobre la fila de la
-- integración: si un PUT o mark_hubspot_ready la está cambiando, se espera a que termine y se
-- vuelve a evaluar la condición sobre la versión nueva (sin FOR SHARE, el recheck de READ
-- COMMITTED reusaría la versión vieja de la integración). Mismo orden de locks que
-- mark_hubspot_ready (integración, después contactos): sin deadlock entre las dos.
-- Devuelve false si no enlazó (contacto de otro workspace, huella distinta o no lista).
CREATE OR REPLACE FUNCTION public.link_hubspot_contact(
  p_workspace_id UUID,
  p_contact_id UUID,
  p_hs_contact_id TEXT,
  p_token_fingerprint TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
VOLATILE
SET search_path = ''
AS $$
  WITH linked AS (
    UPDATE public.contacts c
       SET hs_contact_id = p_hs_contact_id, updated_at = now()
     WHERE c.id = p_contact_id
       AND c.workspace_id = p_workspace_id
       AND EXISTS (
         SELECT 1
           FROM public.integrations i
          WHERE i.workspace_id = p_workspace_id
            AND i.provider = 'hubspot'
            AND i.enabled
            AND i.config->>'token_fingerprint' = p_token_fingerprint
            AND i.config->'properties_ready' = 'true'::jsonb
            FOR SHARE
       )
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM linked);
$$;

REVOKE ALL ON FUNCTION public.link_hubspot_contact(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_hubspot_contact(UUID, UUID, TEXT, TEXT) TO service_role;
