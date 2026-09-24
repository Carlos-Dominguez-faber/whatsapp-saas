/**
 * Acciones sobre una conversación o su contacto que tienen dos usuarios: el
 * post_action del setter (buffer.ts) y el motor de automatizaciones. Vivían
 * embebidas en `executeSetterPostAction`; se extrajeron acá para que las dos
 * rutas hagan exactamente lo mismo y un arreglo valga para ambas.
 *
 * Contrato:
 *   - `requestHandoff` devuelve `false` SOLO cuando la transición no está
 *     permitida ("el mundo cambió"). Cualquier otro error se RELANZA: una base
 *     caída no es un handoff que no correspondía.
 *   - `addTagToContact` LANZA y distingue el motivo. Un booleano único
 *     colapsaría "ya la tenía" (éxito), "el contacto no existe" (configuración)
 *     y "se cayó la base" (transitorio), y el ejecutor reintentaría los tres.
 */

import { createClient as createSbClient } from "@supabase/supabase-js";
import { applyTransition, TransitionError } from "./decision-engine";
import { syncContactToCrm } from "./crm-sync";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

/**
 * Error de CONFIGURACIÓN: la regla nombra algo que el mundo no tiene. No se
 * arregla solo, así que el ejecutor lo cierra `failed` sin reintento. Todo lo
 * demás que lanza es transitorio y sí se reintenta.
 */
export class ConfigError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ConfigError";
    this.code = code;
  }
}

/** Fila de append_contact_tags. No se llaman `found`: chocaría con FOUND. */
interface AppendTagsRow {
  contact_found: boolean;
  tags_added: number;
}

/**
 * Agrega una etiqueta al contacto y empuja el cambio al CRM activo best-effort
 * (no-op sin CRM).
 *
 * Es una sola llamada a `append_contact_tags` (migración 20260903000000) y no
 * un read-modify-write: leer `tags`, calcular la unión y escribir el array
 * entero deja una ventana en la que otra escritura concurrente —el setter, otra
 * automatización, un sync de CRM— pisa la etiqueta recién puesta. La RPC
 * resuelve el agregado dentro del propio UPDATE, con la fila bloqueada.
 *
 * Devuelve `true` cuando REALMENTE agregó la etiqueta y `false` cuando el
 * contacto ya la tenía. Los dos son ÉXITO; el booleano solo decide el sync al
 * CRM, porque sincronizar cuando no cambió nada es tráfico inútil en cada
 * vuelta del motor.
 */
export async function addTagToContact(params: {
  workspaceId: string;
  contactId: string;
  tag: string;
}): Promise<boolean> {
  const tag = params.tag.trim();
  // Una etiqueta vacía es configuración rota, no un transitorio: la regla se
  // guardó sin `tag`. Reintentarla tres veces no la arregla.
  if (!tag) throw new ConfigError("empty_tag");

  const { data, error } = await svc().rpc("append_contact_tags", {
    p_workspace_id: params.workspaceId,
    p_contact_id: params.contactId,
    p_tags: [tag],
  });

  if (error) {
    console.error(
      "[conversation-actions] append_contact_tags error:",
      error.message,
    );
    throw new Error(`append_contact_tags: ${error.message}`);
  }

  // RETURNS TABLE llega como array de filas. Sin fila no se sabe qué pasó, y
  // "no sé" se trata como transitorio (se reintenta), nunca como éxito.
  const row = ((data as AppendTagsRow[] | null) ?? [])[0];
  if (!row) throw new Error("append_contact_tags no devolvió ninguna fila");

  if (!row.contact_found) throw new ConfigError("contact_not_found");

  // tags_added = 0 ⇒ ya la tenía. Éxito idempotente y sin sync: nada cambió.
  if (row.tags_added <= 0) return false;

  // Best-effort: sin CRM conectado es un no-op. Lleva el delta, no el arreglo: HubSpot agrega la
  // etiqueta sin pisar las que el equipo puso allá. Sin el .catch, un caller worker (el ejecutor
  // del motor) vería una unhandled rejection por un sync que no bloquea el resultado de esta función.
  void syncContactToCrm(params.workspaceId, params.contactId, { addTags: [tag] }).catch((e) =>
    console.warn("[conversation-actions] syncContactToCrm:", e),
  );
  return true;
}

/**
 * Pide handoff humano pasando por el choke point de estado.
 *
 * `handoff_pending` solo es válido desde `ai_active` / `human_active`:
 * desde cualquier otro estado `applyTransition` lanza `TransitionError` y acá
 * se traduce a `false` (el ejecutor lo cierra `skipped`). **Cualquier otro
 * error se relanza**: si la base se cayó, el handoff no ocurrió y hay que
 * reintentarlo, no darlo por descartado.
 *
 * Ojo: "la conversación no existe" también se relanza (`applyTransition` lanza
 * un Error común). Es deliberado — el ejecutor agota intentos y termina
 * `failed`, que es visible, en vez de un `skipped` que nadie mira.
 */
export async function requestHandoff(params: {
  workspaceId: string;
  conversationId: string;
  reason: string;
}): Promise<boolean> {
  try {
    await applyTransition(params.conversationId, "handoff_pending", {
      trigger: params.reason,
      workspaceId: params.workspaceId,
    });
    return true;
  } catch (err) {
    if (err instanceof TransitionError) {
      console.warn("[conversation-actions] requestHandoff omitido:", err.message);
      return false;
    }
    throw err;
  }
}
