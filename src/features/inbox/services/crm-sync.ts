/**
 * crm-sync.ts — el único punto de despacho local→CRM. HighLevel y HubSpot son clientes espejo,
 * sin una interfaz CrmProvider común: el único switch por proveedor vive acá.
 *
 * NO es "use server" a propósito: recibe workspaceId del caller, que ya lo derivó de la fila del
 * contacto. Como server action, cualquiera podría pasarle otro tenant.
 *
 * Un solo CRM activo: lo impone la base (uq_integrations_one_active_crm). Si igual hubiera
 * dos filas habilitadas, acá no se sincroniza con ninguno (`crm_conflict`), y `crmStatus` es el
 * guard que usan las fronteras que llaman a un CRM directo (setter, webhook de HighLevel).
 */

import { createClient as createSbClient } from "@supabase/supabase-js";
import { syncContactToHL } from "./highlevel-client";
import {
  pushContactToHubSpot,
  syncContactFromHubSpot,
  type CrmSyncOptions,
} from "./hubspot-client";

export type CrmName = "highlevel" | "hubspot";

export type CrmSyncResult =
  | { ok: true; provider: CrmName; id: string }
  // `code` lleva el motivo real de un HubSpot fallido (antes se perdía en
  // el `null` de syncContactToHubSpot), para que el caller pueda mapear los que sabe explicar
  // (p. ej. `properties_not_ready`) en vez de "intenta de nuevo" para todo.
  | { ok: false; reason: "no_crm" | "crm_conflict" | "failed"; code?: string };

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

async function activeCrm(workspaceId: string): Promise<CrmName | "none" | "conflict" | "error"> {
  const { data, error } = await svc()
    .from("integrations")
    .select("provider")
    .eq("workspace_id", workspaceId)
    .eq("enabled", true)
    .in("provider", ["highlevel", "hubspot"]);
  if (error) {
    console.error("[crm-sync] integrations:", error.message);
    return "error";
  }
  const rows = (data as Array<{ provider: CrmName }> | null) ?? [];
  if (rows.length === 0) return "none";
  if (rows.length > 1) {
    console.error("[crm-sync] crm_conflict", { workspaceId });
    return "conflict";
  }
  return rows[0].provider;
}

/**
 * "active" solo si `name` es EL CRM activo del workspace; conflicto o ninguno: "inactive" (no
 * actuar). Un error de LECTURA es "error", distinto de "no activo": el webhook
 * de HighLevel responde 500 para que HighLevel reintente, y los caminos de sync lo reportan como
 * fallo de la base, no como "no es el CRM activo".
 */
export async function crmStatus(
  workspaceId: string,
  name: CrmName,
): Promise<"active" | "inactive" | "error"> {
  const crm = await activeCrm(workspaceId);
  if (crm === "error") return "error";
  return crm === name ? "active" : "inactive";
}

/**
 * Empuja el contacto al CRM activo. `opts` lleva el delta de etiquetas y `pushProfile` (solo la
 * edición del operador pisa nombre/email de un contacto existente en HubSpot). HighLevel lo ignora y sigue empujando el contacto entero, como antes.
 */
export async function syncContactToCrm(
  workspaceId: string,
  contactId: string,
  opts: CrmSyncOptions = {},
): Promise<CrmSyncResult> {
  const crm = await activeCrm(workspaceId);
  if (crm === "none") return { ok: false, reason: "no_crm" };
  if (crm === "conflict") return { ok: false, reason: "crm_conflict" };
  if (crm === "error") return { ok: false, reason: "failed", code: "crm_read_failed" };

  try {
    if (crm === "highlevel") {
      const r = await syncContactToHL(workspaceId, contactId);
      return r ? { ok: true, provider: "highlevel", id: r.hl_id } : { ok: false, reason: "failed" };
    }
    const r = await pushContactToHubSpot(workspaceId, contactId, opts);
    return r.ok ? { ok: true, provider: "hubspot", id: r.hs_id } : { ok: false, reason: "failed", code: r.code };
  } catch (err) {
    // Defensa extra. Los dos proveedores tienen contrato "nunca lanza"
    // (getHLConfig/readHubSpotConfig ya atrapan un decrypt roto), pero si alguno igual lanza —hoy
    // o en un cambio futuro— esto no debe reventar hasta el caller. El detalle queda server-side.
    console.error("[crm-sync] syncContactToCrm: el proveedor lanzó una excepción inesperada", {
      workspaceId,
      contactId,
      provider: crm,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: "failed", code: "unexpected_error" };
  }
}

/**
 * Opciones de sync para una edición del operador en la ficha (`updateContact`), que guarda el
 * arreglo de etiquetas completo. HubSpot recibe las etiquetas como DELTA: las altas van juntas
 * (`addTags`, que manda la unión de todas las locales) y cada baja en su propia subida, porque
 * `removeTag` quita una sola. Nombre/email se empujan a un contacto existente solo si cambiaron.
 * Siempre hay al menos una subida: HighLevel ignora las opciones y empuja el contacto entero.
 */
export function contactSyncOptions(
  prev: { name: string | null; email: string | null; tags: string[] | null },
  next: { name?: string; email?: string; tags?: string[] },
): CrmSyncOptions[] {
  const profileEdited =
    (next.name !== undefined && next.name !== prev.name) ||
    (next.email !== undefined && next.email !== prev.email);
  const before = prev.tags ?? [];
  const added = next.tags ? next.tags.filter((t) => !before.includes(t)) : [];
  const removed = next.tags ? before.filter((t) => !next.tags!.includes(t)) : [];
  return [
    { ...(profileEdited && { pushProfile: true }), ...(added.length > 0 && { addTags: added }) },
    ...removed.map((removeTag) => ({ removeTag })),
  ];
}

/**
 * Botón "Sincronizar CRM". En HubSpot agrega todas las etiquetas locales (`allTags`: unión,
 * nunca quita) y trae nombre/email a los campos locales vacíos. HighLevel no tiene pull
 * por contacto: su pull es el webhook entrante.
 */
export async function syncContactManually(workspaceId: string, contactId: string): Promise<CrmSyncResult> {
  const pushed = await syncContactToCrm(workspaceId, contactId, { allTags: true });
  if (!pushed.ok || pushed.provider !== "hubspot") return pushed;
  try {
    const pulled = await syncContactFromHubSpot(workspaceId, contactId);
    return pulled ? pushed : { ok: false, reason: "failed" };
  } catch (err) {
    // Mismo motivo que en syncContactToCrm, para el paso de pull.
    console.error("[crm-sync] syncContactManually: el pull de HubSpot lanzó una excepción inesperada", {
      workspaceId,
      contactId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: "failed", code: "unexpected_error" };
  }
}
