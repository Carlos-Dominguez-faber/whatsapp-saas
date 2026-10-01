-- contacts.hs_contact_id: id del contacto en HubSpot.
--
-- Índice TOTAL, no parcial, por la misma razón que uq_contacts_workspace_hl_contact_id
-- (20260906000000): PostgREST manda ON CONFLICT (cols) sin predicado y Postgres no infiere un
-- índice parcial. Fija además que un contacto de HubSpot se enlaza a un solo contacto local por
-- workspace. Los NULL no colisionan. Sin CONCURRENTLY: columna nueva, toda en NULL.

ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS hs_contact_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_contacts_workspace_hs_contact_id
  ON public.contacts (workspace_id, hs_contact_id);

COMMENT ON INDEX public.uq_contacts_workspace_hs_contact_id IS
  'Un contacto de HubSpot por contacto local y workspace. Total, no parcial: PostgREST no manda el predicado del ON CONFLICT.';
