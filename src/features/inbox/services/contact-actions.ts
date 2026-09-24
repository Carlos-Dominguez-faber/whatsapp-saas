"use server";

/**
 * contact-actions.ts — Server actions for contact CRUD and HL sync.
 */

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { checkWorkspaceMember } from "@/lib/auth/workspace-access";
import { syncContactToHL } from "./highlevel-client";
import type { ContactRow } from "@/features/inbox/types";

// ──────────────────────────────────────────────────────────────────────────────
// Schemas
// ──────────────────────────────────────────────────────────────────────────────

const UpdateContactSchema = z.object({
  name: z.string().min(1, "El nombre es requerido").optional(),
  email: z.string().email("Email inválido").optional(),
  stage: z.enum(["new", "engaged", "qualified", "customer", "lost"]).optional(),
  tags: z.array(z.string()).optional(),
  opt_in: z.boolean().optional(),
});

export type UpdateContactInput = z.infer<typeof UpdateContactSchema>;

export type ActionResult<T> =
  | { ok: true; data: T; error?: never }
  | { ok: false; data?: never; error: string };

// ──────────────────────────────────────────────────────────────────────────────
// updateContact
// ──────────────────────────────────────────────────────────────────────────────
export async function updateContact(
  contactId: string,
  data: UpdateContactInput,
): Promise<ActionResult<{ id: string }>> {
  // 1. Auth check
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return { ok: false, error: "No autorizado" };
  }

  // 2. Validate input
  const parsed = UpdateContactSchema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Datos inválidos",
    };
  }

  if (Object.keys(parsed.data).length === 0) {
    return { ok: false, error: "No se proporcionaron campos a actualizar" };
  }

  // 3. Update contact (RLS ensures user can only update their workspace's contacts)
  const { data: updated, error: updateError } = await supabase
    .from("contacts")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", contactId)
    .select("id, workspace_id")
    .single();

  if (updateError || !updated) {
    console.error("[updateContact] Supabase error:", updateError?.message);
    return { ok: false, error: "Error al actualizar el contacto" };
  }

  const { id: updatedId, workspace_id } = updated as {
    id: string;
    workspace_id: string;
  };

  // 4. Fire-and-forget HL sync (do not block UI)
  syncContactToHL(workspace_id, contactId).catch((err: unknown) => {
    console.warn("[updateContact] HL sync failed (non-critical):", err);
  });

  return { ok: true, data: { id: updatedId } };
}

// ──────────────────────────────────────────────────────────────────────────────
// getContact
// ──────────────────────────────────────────────────────────────────────────────
export async function getContact(
  contactId: string,
): Promise<ContactRow | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", contactId)
    .single();

  if (error || !data) {
    console.error("[getContact] error:", error?.message);
    return null;
  }

  return data as ContactRow;
}

// ──────────────────────────────────────────────────────────────────────────────
// syncContactHL — manual sync trigger from UI
// ──────────────────────────────────────────────────────────────────────────────
export async function syncContactHL(
  contactId: string,
  workspaceId: string,
): Promise<ActionResult<{ hl_id: string }>> {
  // workspaceId comes from the client: verify membership here, with the role
  // the contacts write policy requires.
  const access = await checkWorkspaceMember(workspaceId, { minRole: "agent" });
  if (!access.ok) {
    return { ok: false, error: "No autorizado" };
  }

  const result = await syncContactToHL(workspaceId, contactId);

  if (!result) {
    return { ok: false, error: "Error al sincronizar con HighLevel" };
  }

  return { ok: true, data: { hl_id: result.hl_id } };
}
