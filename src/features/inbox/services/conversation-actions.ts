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
import { syncContactToHL } from "./highlevel-client";
import { isMissingFunctionError, reportMissingFunctionOnce } from "@/shared/lib/db-errors";

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
 * Adds tags to a contact in one atomic UPDATE (`append_contact_tags`), so a
 * concurrent writer can't drop a tag another one just added. Before the
 * migration that creates the RPC, falls back to the old read-merge-write.
 * Throws on a database error; `contact_found` false means the contact isn't in
 * this workspace.
 */
export async function appendContactTags(
  workspaceId: string,
  contactId: string,
  tags: string[],
): Promise<AppendTagsRow> {
  const supabase = svc();
  const { data, error } = await supabase.rpc("append_contact_tags", {
    p_workspace_id: workspaceId,
    p_contact_id: contactId,
    p_tags: tags,
  });

  if (error && isMissingFunctionError(error, "append_contact_tags")) {
    reportMissingFunctionOnce("append_contact_tags", "tags are merged with a read and a write");
    const { data: contact, error: readError } = await supabase
      .from("contacts")
      .select("tags")
      .eq("id", contactId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (readError) throw new Error(`append tags read: ${readError.message}`);
    if (!contact) return { contact_found: false, tags_added: 0 };
    const existing = Array.isArray(contact.tags) ? (contact.tags as string[]) : [];
    const clean = tags.map((t) => t.trim()).filter(Boolean);
    const merged = Array.from(new Set([...existing, ...clean]));
    const added = merged.length - existing.length;
    if (added > 0) {
      const { error: writeError } = await supabase
        .from("contacts")
        .update({ tags: merged })
        .eq("id", contactId)
        .eq("workspace_id", workspaceId);
      if (writeError) throw new Error(`append tags write: ${writeError.message}`);
    }
    return { contact_found: true, tags_added: added };
  }

  if (error) {
    console.error("[conversation-actions] append_contact_tags error:", error.message);
    throw new Error(`append_contact_tags: ${error.message}`);
  }

  // RETURNS TABLE llega como array de filas. Sin fila no se sabe qué pasó, y
  // "no sé" se trata como transitorio (se reintenta), nunca como éxito.
  const row = ((data as AppendTagsRow[] | null) ?? [])[0];
  if (!row) throw new Error("append_contact_tags no devolvió ninguna fila");
  return row;
}

/**
 * Agrega una etiqueta al contacto y empuja el cambio a HighLevel best-effort
 * (no-op si HL no está conectado).
 *
 * Es una sola llamada a `append_contact_tags` (migración 20260903000000) y no
 * un read-modify-write: leer `tags`, calcular la unión y escribir el array
 * entero deja una ventana en la que otra escritura concurrente —el setter, otra
 * automatización, un sync de CRM— pisa la etiqueta recién puesta. La RPC
 * resuelve el agregado dentro del propio UPDATE, con la fila bloqueada.
 *
 * Devuelve `true` cuando REALMENTE agregó la etiqueta y `false` cuando el
 * contacto ya la tenía. Los dos son ÉXITO; el booleano solo decide el sync a
 * HL, porque sincronizar cuando no cambió nada es tráfico inútil en cada vuelta
 * del motor.
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

  const row = await appendContactTags(params.workspaceId, params.contactId, [tag]);

  if (!row.contact_found) throw new ConfigError("contact_not_found");

  // tags_added = 0 ⇒ ya la tenía. Éxito idempotente y sin sync: nada cambió.
  if (row.tags_added <= 0) return false;

  // Best-effort: si HL no está conectado es un no-op. syncContactToHL lanza en
  // más de un camino (highlevel-client.ts); sin el .catch, un caller worker
  // (el ejecutor del motor) vería una unhandled rejection por un sync que ni siquiera bloquea
  // el resultado de esta función.
  void syncContactToHL(params.workspaceId, params.contactId).catch((e) =>
    console.warn("[conversation-actions] syncContactToHL:", e),
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
