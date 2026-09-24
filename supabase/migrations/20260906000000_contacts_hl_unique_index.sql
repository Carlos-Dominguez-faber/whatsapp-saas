-- El webhook de contactos de HighLevel era un no-op silencioso.
--
-- `syncContactFromHL` (highlevel-client.ts) hace el upsert con
-- `onConflict: "workspace_id,hl_contact_id"`, pero NO existía ningún índice
-- único sobre ese par: solo dos índices NO únicos y parciales, `idx_contacts_hl`
-- e `idx_contacts_hl_contact_id` (que además son idénticos entre sí). Sin un
-- índice único que inferir, Postgres rechaza el ON CONFLICT con `42P10`, el
-- upsert fallaba SIEMPRE, y la ruta del webhook igual respondía
-- `{ok:true, synced:true}`: ningún contacto de HighLevel llegó nunca a la base
-- por esa vía.
--
-- POR QUÉ EL ÍNDICE ES TOTAL Y NO PARCIAL, que es lo que invita a hacer el
-- `WHERE hl_contact_id IS NOT NULL` de los dos existentes: PostgREST traduce
-- ese `onConflict` a `ON CONFLICT (workspace_id, hl_contact_id)` **sin**
-- repetir el predicado, y Postgres solo infiere un índice parcial cuando la
-- cláusula lo incluye. Un índice único parcial dejaría el `42P10` intacto y
-- este arreglo sería otro no-op. No convertirlo a parcial "para que ocupe
-- menos": las filas con `hl_contact_id` NULL no se estorban entre sí, porque
-- en un índice único los NULL no colisionan.
--
-- OJO al aplicar: esta migración ENCIENDE un upsert que nunca había corrido,
-- incluido su `tags: hlContact.tags`, que reemplaza las etiquetas locales del
-- contacto por las de HighLevel. Y el índice falla si ya hay pares
-- `(workspace_id, hl_contact_id)` repetidos: revisarlo antes con
--   SELECT workspace_id, hl_contact_id, count(*) FROM contacts
--   WHERE hl_contact_id IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1;
-- Sin CONCURRENTLY a propósito: CONCURRENTLY no corre dentro de la
-- transacción de una migración.

CREATE UNIQUE INDEX IF NOT EXISTS uq_contacts_workspace_hl_contact_id
  ON public.contacts (workspace_id, hl_contact_id);

COMMENT ON INDEX public.uq_contacts_workspace_hl_contact_id IS
  'Habilita el ON CONFLICT (workspace_id, hl_contact_id) del upsert de syncContactFromHL. Total, no parcial: PostgREST no manda el predicado y Postgres no podria inferir un indice parcial.';
