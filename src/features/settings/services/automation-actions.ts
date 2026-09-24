"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSbClient } from "@supabase/supabase-js";
import {
  AutomationRuleInputSchema,
  firstErrorMessage,
  type ActionType,
  type TriggerType,
} from "@/features/automations/lib/rule-schema";
import {
  assertActiveRuleCap,
  RuleCapError,
} from "@/features/automations/services/rule-cap";

// ── Types ─────────────────────────────────────────────────────────────────────

export type { TriggerType, ActionType };

export interface AutomationRule {
  id: string;
  workspace_id: string;
  name: string;
  enabled: boolean;
  trigger_type: TriggerType;
  trigger_config: Record<string, unknown>;
  action_type: ActionType;
  action_config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

async function assertAdminOrManager(
  workspaceId: string,
): Promise<void | { error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { error: "No autenticado" };

  const { data: member } = await supabase
    .from("memberships")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!member) return { error: "Sin permisos" };
  if (!["admin", "manager"].includes(member.role as string)) {
    return {
      error: "Solo admins y managers pueden gestionar automatizaciones",
    };
  }
}

// ── saveAutomationRule ────────────────────────────────────────────────────────

export async function saveAutomationRule(
  workspaceId: string,
  rule: Omit<
    AutomationRule,
    "workspace_id" | "created_at" | "updated_at" | "id"
  > & {
    id?: string;
  },
): Promise<{ data?: AutomationRule; error?: string }> {
  const authCheck = await assertAdminOrManager(workspaceId);
  if (authCheck && "error" in authCheck) return authCheck;

  const parsed = AutomationRuleInputSchema.safeParse(rule);
  if (!parsed.success) {
    return { error: firstErrorMessage(parsed.error) };
  }

  const db = svc();
  const { id, ...fields } = parsed.data;

  // Tope de reglas activas. Mismo criterio que la ruta de API: solo
  // se comprueba cuando la regla queda HABILITADA, y al editar se excluye a sí
  // misma del conteo (si no, guardar la regla nº 20 se rechazaría sola).
  if (fields.enabled) {
    try {
      await assertActiveRuleCap(db, workspaceId, { excludeRuleId: id });
    } catch (err) {
      if (err instanceof RuleCapError) return { error: err.message };
      return { error: "No se pudo guardar la automatización. Intenta de nuevo." };
    }
  }

  if (id) {
    // Update
    const { data, error } = await db
      .from("automation_rules")
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("workspace_id", workspaceId)
      .select()
      .single();

    if (error) {
      console.error("[saveAutomationRule update]:", error);
      return { error: "Error al actualizar la automatización" };
    }

    revalidatePath("/settings");
    return { data: data as AutomationRule };
  }

  // Create
  const { data, error } = await db
    .from("automation_rules")
    .insert({ workspace_id: workspaceId, ...fields })
    .select()
    .single();

  if (error) {
    console.error("[saveAutomationRule create]:", error);
    return { error: "Error al crear la automatización" };
  }

  revalidatePath("/settings");
  return { data: data as AutomationRule };
}

// ── deleteAutomationRule ──────────────────────────────────────────────────────

export async function deleteAutomationRule(
  workspaceId: string,
  ruleId: string,
): Promise<{ success?: boolean; error?: string }> {
  const authCheck = await assertAdminOrManager(workspaceId);
  if (authCheck && "error" in authCheck) return authCheck;

  const idParsed = z.string().uuid().safeParse(ruleId);
  if (!idParsed.success) return { error: "ID de regla inválido" };

  const db = svc();
  const { error } = await db
    .from("automation_rules")
    .delete()
    .eq("id", ruleId)
    .eq("workspace_id", workspaceId);

  if (error) {
    console.error("[deleteAutomationRule]:", error);
    return { error: "Error al eliminar la automatización" };
  }

  revalidatePath("/settings");
  return { success: true };
}

// ── toggleAutomationRule ──────────────────────────────────────────────────────

export async function toggleAutomationRule(
  workspaceId: string,
  ruleId: string,
  enabled: boolean,
): Promise<{ data?: AutomationRule; error?: string }> {
  const authCheck = await assertAdminOrManager(workspaceId);
  if (authCheck && "error" in authCheck) return authCheck;

  const idParsed = z.string().uuid().safeParse(ruleId);
  if (!idParsed.success) return { error: "ID de regla inválido" };

  // Una server action es un endpoint HTTP público: `enabled` llega sin pasar
  // por el schema de la regla, así que un caller puede mandar cualquier cosa
  // (p. ej. el string "false", que es truthy en JS) y terminaría escribiéndose
  // en una columna boolean.
  const enabledParsed = z.boolean().safeParse(enabled);
  if (!enabledParsed.success) {
    return { error: "El estado de la automatización no es válido" };
  }

  const db = svc();

  // Tope de reglas activas. Deshabilitar nunca se rechaza: solo el
  // toggle a `true` puede pasarse del tope.
  if (enabled) {
    try {
      await assertActiveRuleCap(db, workspaceId, { excludeRuleId: ruleId });
    } catch (err) {
      if (err instanceof RuleCapError) return { error: err.message };
      return { error: "No se pudo guardar la automatización. Intenta de nuevo." };
    }
  }

  const { data, error } = await db
    .from("automation_rules")
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq("id", ruleId)
    .eq("workspace_id", workspaceId)
    .select()
    .single();

  if (error) {
    console.error("[toggleAutomationRule]:", error);
    return { error: "Error al actualizar la automatización" };
  }

  revalidatePath("/settings");
  return { data: data as AutomationRule };
}
