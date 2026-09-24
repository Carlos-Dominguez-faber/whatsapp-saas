-- Lectura del contacto para un push a HubSpot, atada a la huella del token que se va a usar.
--
-- link_hubspot_contact ata a la huella el enlace que se ESCRIBE, pero un enlace que ya existía se
-- leía con un SELECT suelto: un worker con la config del token A podía leer un hs_contact_id que
-- otro sync había enlazado con el token B (después de que mark_hubspot_ready limpiara los enlaces
-- de A) y, como el id ya estaba, no pasaba por la RPC ni por su chequeo de huella. Resultado:
-- transcripción, etiquetas, perfil o negocio sobre OTRA persona del portal A.
--
-- Esta función devuelve la fila del contacto SOLO si la integración habilitada de HubSpot del
-- workspace tiene config->>'token_fingerprint' = p_token_fingerprint y properties_ready = true.
-- mark_hubspot_ready limpia los enlaces en la MISMA transacción que cambia el portal, así que un
-- enlace leído bajo una huella que coincide pertenece al portal de ese token.
--
-- Dos sentencias, a propósito, y en este orden:
--   1. SELECT … FOR SHARE sobre la integración: si un PUT o mark_hubspot_ready la está cambiando,
--      espera a que termine y vuelve a evaluar la condición sobre la versión nueva (igual que
--      link_hubspot_contact).
--   2. SELECT del contacto, con un snapshot NUEVO (READ COMMITTED, sentencia aparte): ve lo que
--      commiteó quien tenía el lock. En UNA sola sentencia el contacto se leería con el snapshot
--      tomado ANTES de esperar el lock y podría devolver un enlace que mark_hubspot_ready acaba de
--      limpiar.
-- El lock compartido se mantiene hasta el fin de la transacción de la llamada: mientras dura,
-- nadie puede cambiar la huella ni el portal. Mismo orden de locks que mark_hubspot_ready
-- (integración, después contactos).
--
-- Devuelve: una fila con ready = false (resto NULL) si la huella no coincide o la integración no
-- está lista; la fila del contacto con ready = true si coincide; ninguna fila si el contacto no
-- existe en ese workspace.
CREATE OR REPLACE FUNCTION public.read_hubspot_link(
  p_workspace_id UUID,
  p_contact_id UUID,
  p_token_fingerprint TEXT
)
RETURNS TABLE (
  ready BOOLEAN,
  id UUID,
  name TEXT,
  phone TEXT,
  email TEXT,
  tags TEXT[],
  hs_contact_id TEXT
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  PERFORM 1
     FROM public.integrations i
    WHERE i.workspace_id = p_workspace_id
      AND i.provider = 'hubspot'
      AND i.enabled
      AND i.config->>'token_fingerprint' = p_token_fingerprint
      AND i.config->'properties_ready' = 'true'::jsonb
      FOR SHARE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT[], NULL::TEXT;
    RETURN;
  END IF;

  RETURN QUERY
    SELECT true, c.id, c.name, c.phone, c.email, c.tags, c.hs_contact_id
      FROM public.contacts c
     WHERE c.id = p_contact_id
       AND c.workspace_id = p_workspace_id;
END;
$$;

REVOKE ALL ON FUNCTION public.read_hubspot_link(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_hubspot_link(UUID, UUID, TEXT) TO service_role;
