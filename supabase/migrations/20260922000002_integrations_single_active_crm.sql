-- Un solo CRM activo por workspace: HighLevel o HubSpot, nunca los dos.
--
-- Tiene que vivir en la BASE, no solo en el PUT de integraciones: dos PUT concurrentes pasan el
-- chequeo a la vez, y la policy integrations_write_admins (FOR ALL) deja escribir la tabla
-- directo por PostgREST. El PUT traduce el 23505 de este índice a 409.
--
-- PARCIAL A PROPÓSITO, a diferencia de los índices de ids de CRM (que son totales): aquellos son
-- árbitros de ON CONFLICT y PostgREST omite el predicado. Este es solo una restricción y nadie
-- hace ON CONFLICT contra él. Cal.com es agenda, no CRM: no entra.

DO $$
DECLARE v_ws text;
BEGIN
  SELECT string_agg(workspace_id::text, ', ') INTO v_ws
    FROM (SELECT workspace_id
            FROM public.integrations
           WHERE enabled AND provider IN ('highlevel', 'hubspot')
           GROUP BY workspace_id
          HAVING count(*) > 1) t;
  IF v_ws IS NOT NULL THEN
    RAISE EXCEPTION 'No se puede imponer un solo CRM activo: estos workspaces tienen HighLevel y HubSpot habilitados a la vez: %. Desactivar uno en cada workspace y volver a correr la migración.', v_ws;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_one_active_crm
  ON public.integrations (workspace_id)
  WHERE enabled AND provider IN ('highlevel', 'hubspot');

COMMENT ON INDEX public.uq_integrations_one_active_crm IS
  'Un solo CRM (HighLevel o HubSpot) habilitado por workspace. Parcial a propósito: es una restricción, no un árbitro de ON CONFLICT.';
