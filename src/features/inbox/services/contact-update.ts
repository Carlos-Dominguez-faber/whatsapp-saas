/**
 * contact-update.ts — the one path for a person editing a contact's CRM
 * fields (the panel's server action and PATCH /api/contacts/[id]).
 *
 * The opt-in only changes when the request asks for a value different from
 * the stored one. A form that always sends `opt_in` with what it loaded
 * would otherwise undo a STOP that arrived while it was open. Opting a
 * contact back in after they opted out takes a manager or admin; the database
 * enforces the same (trg_contacts_opt_in_guard) and records every manual
 * change with who made it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { checkWorkspaceMember } from "@/lib/auth/workspace-access";
import { manualOptInFields } from "./opt-out";

export const OPT_IN_OVERRIDE_DENIED =
  "Este contacto pidió no recibir mensajes. Solo un admin o manager puede volver a darlo de alta.";
export const CONTACT_CHANGED =
  "El contacto cambió mientras guardabas (por ejemplo, escribió STOP). Recarga y vuelve a intentar.";

export interface ContactPatch {
  name?: string;
  email?: string;
  stage?: "new" | "engaged" | "qualified" | "customer" | "lost";
  tags?: string[];
  opt_in?: boolean;
}

export type ContactUpdateResult =
  | { ok: true; contact: Record<string, unknown> }
  | { ok: false; status: 403 | 404 | 409 | 500; error: string };

/**
 * Applies `patch` with the caller's session (RLS scopes it to their
 * workspaces). `select` is what the caller wants back.
 */
export async function applyContactUpdate(
  supabase: SupabaseClient,
  contactId: string,
  patch: ContactPatch,
  select = "*",
): Promise<ContactUpdateResult> {
  const { data: current, error: readError } = await supabase
    .from("contacts")
    .select("id, workspace_id, opt_in, opted_out_at")
    .eq("id", contactId)
    .maybeSingle();
  if (readError) {
    console.error("[contact-update] read failed:", readError.message);
    return { ok: false, status: 500, error: "Error al actualizar el contacto" };
  }
  if (!current) return { ok: false, status: 404, error: "Contacto no encontrado" };

  const row = current as {
    workspace_id: string;
    opt_in: boolean;
    opted_out_at: string | null;
  };
  const { opt_in, ...fields } = patch;

  let optFields: Record<string, unknown> = {};
  if (opt_in !== undefined && opt_in !== row.opt_in) {
    if (opt_in && row.opted_out_at) {
      const access = await checkWorkspaceMember(row.workspace_id, { minRole: "manager" });
      if (!access.ok) return { ok: false, status: 403, error: OPT_IN_OVERRIDE_DENIED };
    }
    optFields = manualOptInFields(opt_in);
  }

  let query = supabase
    .from("contacts")
    .update({ ...fields, ...optFields, updated_at: new Date().toISOString() })
    .eq("id", contactId)
    .eq("workspace_id", row.workspace_id);
  const changesOptIn = Object.keys(optFields).length > 0;
  if (changesOptIn) {
    // Only over the opt-in this decision was made on: a STOP that lands while
    // the request is in flight must not be cleared by it.
    query = query.eq("opt_in", row.opt_in);
    query =
      row.opted_out_at === null
        ? query.is("opted_out_at", null)
        : query.eq("opted_out_at", row.opted_out_at);
  }
  const { data, error } = await query.select(select).single();

  if (error || !data) {
    if (error?.code === "42501") {
      return { ok: false, status: 403, error: OPT_IN_OVERRIDE_DENIED };
    }
    if (error?.code === "PGRST116") {
      return changesOptIn
        ? { ok: false, status: 409, error: CONTACT_CHANGED }
        : { ok: false, status: 404, error: "Contacto no encontrado" };
    }
    console.error("[contact-update] update failed:", error?.message);
    return { ok: false, status: 500, error: "Error al actualizar el contacto" };
  }
  return { ok: true, contact: data as unknown as Record<string, unknown> };
}
