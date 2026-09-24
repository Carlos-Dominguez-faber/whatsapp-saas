"use server";

/**
 * contact-actions.ts — Server actions for contact CRUD and CRM sync.
 */

import { z } from "zod";
import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSbClient } from "@supabase/supabase-js";
import { checkWorkspaceMember } from "@/lib/auth/workspace-access";
import {
  contactSyncOptions,
  syncContactToCrm,
  syncContactManually,
  type CrmName,
} from "./crm-sync";
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

  // 3. Valores previos, para saber si el operador de verdad EDITÓ nombre, email o etiquetas: el
  //    panel reenvía siempre el nombre de WhatsApp aunque solo cambie la etapa.
  const { data: before, error: beforeError } = await supabase
    .from("contacts")
    .select("name, email, tags, workspace_id")
    .eq("id", contactId)
    .maybeSingle();

  if (beforeError || !before) {
    console.error("[updateContact] Supabase error:", beforeError?.message);
    return { ok: false, error: "Error al actualizar el contacto" };
  }
  const prev = before as {
    name: string | null;
    email: string | null;
    tags: string[] | null;
    workspace_id: string;
  };

  // 4. Update contact (RLS ensures user can only update their workspace's contacts)
  const { data: updated, error: updateError } = await supabase
    .from("contacts")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", contactId)
    .eq("workspace_id", prev.workspace_id)
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

  // 5. CRM sync después de responder, por `after()` y no como promesa suelta: así la plataforma
  //    mantiene viva la función hasta que termine. La edición del operador es la única que empuja
  //    nombre/email a un contacto que ya existía en el CRM, y solo si alguno de los dos CAMBIÓ:
  //    guardar la etapa con el mismo nombre no pisa el nombre que el cliente tiene en HubSpot.
  //    En HubSpot las etiquetas viajan como delta (altas y bajas); HighLevel ignora las opciones y
  //    empuja el contacto entero, como antes.
  const opts = contactSyncOptions(prev, parsed.data);
  after(async () => {
    for (const o of opts) {
      await syncContactToCrm(workspace_id, contactId, o).catch((err: unknown) => {
        console.warn("[updateContact] CRM sync failed (non-critical):", err);
      });
    }
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
// syncContactCrm — botón "Sincronizar CRM" de la ficha
// ──────────────────────────────────────────────────────────────────────────────

/** Códigos de CrmSyncResult que se pueden explicar mejor que "intenta de nuevo". */
const SYNC_FAILURE_MESSAGES: Record<string, string> = {
  properties_not_ready: "Falta probar la conexión de HubSpot en Configuración → Integraciones.",
};

/**
 * Sincroniza el contacto con el CRM activo a pedido del operador. Debajo todo corre con
 * `service_role` y salta RLS, así que la autorización se hace acá: el `workspaceId` sale de la
 * fila del contacto, **no** del cliente (aceptarlo del cliente dejaba mandar el contacto de un
 * tenant al CRM de otro), y el usuario tiene que ser miembro activo con rol que escribe contactos
 * (admin/manager/agent; el viewer solo lee).
 */
export async function syncContactCrm(
  contactId: string,
): Promise<ActionResult<{ provider: CrmName; id: string }>> {
  const { data: contact, error: contactError } = await createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
    .from("contacts")
    .select("workspace_id")
    .eq("id", contactId)
    .maybeSingle();
  if (contactError) {
    console.error("[syncContactCrm] contacts:", contactError.message);
    return { ok: false, error: "No pudimos comprobar el contacto. Intenta de nuevo." };
  }
  if (!contact) return { ok: false, error: "No encontramos el contacto" };
  const workspaceId = (contact as { workspace_id: string }).workspace_id;

  const member = await checkWorkspaceMember(workspaceId, { minRole: "agent" });
  if (!member.ok) {
    if (member.status === 401) return { ok: false, error: "No autorizado" };
    // Mismo mensaje para "no existe" y "de otro tenant": no confirmar ids ajenos.
    if (member.reason === "not_member") return { ok: false, error: "No encontramos el contacto" };
    return { ok: false, error: "Tu rol solo permite ver el contacto, no editarlo" };
  }

  let result: Awaited<ReturnType<typeof syncContactManually>>;
  try {
    result = await syncContactManually(workspaceId, contactId);
  } catch (err) {
    // Defensa extra por si el proveedor lanza pese a su contrato "nunca lanza"; el detalle
    // técnico se queda server-side.
    console.error("[syncContactCrm] excepción inesperada sincronizando con el CRM:", {
      workspaceId,
      contactId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "No pudimos sincronizar con el CRM. Intenta de nuevo." };
  }
  if (result.ok) return { ok: true, data: { provider: result.provider, id: result.id } };
  if (result.reason === "no_crm") {
    return { ok: false, error: "No hay un CRM conectado. Conéctalo en Configuración → Integraciones." };
  }
  if (result.reason === "crm_conflict") {
    return { ok: false, error: "Hay dos CRM activos. Desactiva uno en Configuración → Integraciones." };
  }
  return {
    ok: false,
    error: (result.code && SYNC_FAILURE_MESSAGES[result.code]) || "No pudimos sincronizar con el CRM. Intenta de nuevo.",
  };
}
