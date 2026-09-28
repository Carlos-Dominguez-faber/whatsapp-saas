import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Opt-outs. A contact who wrote STOP (or was opted out by hand) gets no
 * automation and no template; replies inside the 24h window they open still go
 * out. The database applies STOP/START from the message itself
 * (trg_messages_opt_out) and keeps the suppression per phone in
 * contact_opt_outs, so re-creating the contact or moving the phone doesn't
 * lift it.
 */

/** The digits of a phone: the key contact_opt_outs uses (contact_phone_key in SQL). */
export function phoneKey(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/[^0-9]/g, "");
  return digits || null;
}

/**
 * Whether the phone opted out in this workspace. Throws on a read error (the
 * caller retries); before the migration that creates the table it answers
 * false, as the contact's own opt_in still applies.
 */
export async function isPhoneOptedOut(
  db: SupabaseClient,
  workspaceId: string,
  phone: string | null | undefined,
): Promise<boolean> {
  const key = phoneKey(phone);
  if (!key) return false;
  const { data, error } = await db
    .from("contact_opt_outs")
    .select("phone_key")
    .eq("workspace_id", workspaceId)
    .eq("phone_key", key)
    .limit(1);
  if (error) {
    if (error.code === "42P01") {
      console.error("[opt-out] contact_opt_outs is missing: run `setup.mjs db-push`");
      return false;
    }
    throw new Error(`[opt-out] suppression lookup failed: ${error.message}`);
  }
  return ((data as unknown[] | null) ?? []).length > 0;
}

/**
 * Whether the contact of a conversation opted out (their opt_in, or their
 * phone's suppression). Throws on a read error: callers fail closed.
 */
export async function conversationContactOptedOut(
  db: SupabaseClient,
  workspaceId: string,
  conversationId: string,
): Promise<boolean> {
  const { data: conv, error } = await db
    .from("conversations")
    .select("contact_id")
    .eq("id", conversationId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw new Error(`[opt-out] conversation lookup failed: ${error.message}`);
  const contactId = (conv as { contact_id: string | null } | null)?.contact_id;
  if (!contactId) return false;

  const { data: contact, error: contactError } = await db
    .from("contacts")
    .select("phone, opt_in")
    .eq("id", contactId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (contactError) throw new Error(`[opt-out] contact lookup failed: ${contactError.message}`);
  const row = contact as { phone: string; opt_in: boolean } | null;
  if (!row) return false;
  if (row.opt_in === false) return true;
  return isPhoneOptedOut(db, workspaceId, row.phone);
}

/**
 * The columns to write when someone sets a contact's opt-in by hand: a manual
 * opt-out is an explicit one (it sticks, see trg_contacts_opt_out), and a
 * manual opt-in clears it.
 */
export function manualOptInFields(optIn: boolean | undefined): Record<string, unknown> {
  if (optIn === undefined) return {};
  const now = new Date().toISOString();
  return optIn
    ? { opt_in: true, opt_in_at: now, opted_out_at: null }
    : { opt_in: false, opted_out_at: now };
}
