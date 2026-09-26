"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { checkWorkspaceMember } from "@/lib/auth/workspace-access";
import { listTemplates } from "./templates";
import { dispatchTemplate } from "./dispatch";
// NOTE: do NOT re-export types from a "use server" file — Next/Turbopack treats
// every export of an action module as an async action, and a re-exported type
// becomes an undefined runtime reference that crashes the whole actions chunk.
// Consumers import TemplateRow directly from "./templates".
import type { TemplateRow } from "./templates";

// Server actions are HTTP endpoints: any signed-in user can call them with any
// arguments. So the workspace is never taken from the caller — it is resolved
// from the conversation through the RLS-bound client, where a conversation the
// caller cannot read simply does not exist. listTemplates and dispatchTemplate
// run with the service role (RLS never fires there), so this is the lock.

async function workspaceOfConversation(
  conversationId: string,
): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("conversations")
    .select("workspace_id")
    .eq("id", conversationId)
    .maybeSingle();

  return (data as { workspace_id: string } | null)?.workspace_id ?? null;
}

// ──────────────────────────────────────────────────────────────────────────────
// getApprovedTemplates
// ──────────────────────────────────────────────────────────────────────────────

export async function getApprovedTemplates(
  conversationId: string,
): Promise<TemplateRow[]> {
  const workspaceId = await workspaceOfConversation(conversationId);
  if (!workspaceId) return [];

  // No minimum role: a viewer who can read the thread may see which templates
  // exist. Sending is what needs `agent`. An empty list is exactly what a
  // stranger should see — the picker only knows how to render a list.
  const access = await checkWorkspaceMember(workspaceId);
  if (!access.ok) return [];

  return listTemplates(workspaceId, "approved");
}

// ──────────────────────────────────────────────────────────────────────────────
// sendTemplateAction
// ──────────────────────────────────────────────────────────────────────────────

const SendTemplateSchema = z.object({
  conversationId: z.string().min(1).max(64),
  templateName: z.string().min(1).max(512),
  language: z.string().min(2).max(16),
  variables: z.array(z.string().max(1024)).max(20),
});

const DENIED = { ok: false, error: "Acceso denegado" } as const;

export async function sendTemplateAction(
  conversationId: string,
  templateName: string,
  language: string,
  variables: string[],
): Promise<{ ok: boolean; error?: string }> {
  const parsed = SendTemplateSchema.safeParse({
    conversationId,
    templateName,
    language,
    variables,
  });
  if (!parsed.success) {
    return { ok: false, error: "Datos del template inválidos" };
  }

  // The lock runs before anything is built: an unknown or foreign conversation
  // is denied without the WhatsApp provider ever hearing about it.
  const workspaceId = await workspaceOfConversation(conversationId);
  if (!workspaceId) return DENIED;

  // `agent` because sending a template IS sending a WhatsApp: same bar as the
  // free-text composer.
  const access = await checkWorkspaceMember(workspaceId, { minRole: "agent" });
  if (!access.ok) return DENIED;

  // Only a template this workspace has approved can go out.
  const approved = await listTemplates(workspaceId, "approved");
  if (!approved.some((t) => t.name === templateName && t.language === language)) {
    return { ok: false, error: "El template no está aprobado" };
  }

  const components =
    variables.length > 0
      ? [
          {
            type: "body" as const,
            parameters: variables.map((v) => ({
              type: "text" as const,
              text: v,
            })),
          },
        ]
      : undefined;

  const result = await dispatchTemplate({
    workspaceId,
    conversationId,
    templateName,
    templateLanguage: language,
    components,
    senderUserId: access.userId,
  });

  if (!result.ok) {
    return { ok: false, error: result.error ?? "Error enviando template" };
  }

  return { ok: true };
}
