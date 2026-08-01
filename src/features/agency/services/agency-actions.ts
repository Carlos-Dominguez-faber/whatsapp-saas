"use server";

import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { z } from "zod";
import { provisionWorkspaceUser } from "@/lib/auth/provision-user";
import type {
  ClientCredentials,
  CreateWorkspaceResult,
  GetWorkspacesResult,
  WorkspaceWithStats,
} from "../types";

// ─── Schemas ──────────────────────────────────────────────────────────────────

const CreateWorkspaceSchema = z.object({
  name: z.string().min(1, "El nombre es requerido").max(80),
  useCase: z.enum(["setter", "soporte", "agendamiento", "general"]),
  clientEmail: z.string().email("Email inválido").optional().or(z.literal("")),
  clientPassword: z
    .string()
    .min(8, "La contraseña debe tener al menos 8 caracteres")
    .max(72)
    .optional()
    .or(z.literal("")),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

async function assertSuperAdmin(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("users")
    .select("is_super_admin")
    .eq("id", user.id)
    .single();

  if (!data?.is_super_admin) return null;
  return user.id;
}

// ─── Actions ──────────────────────────────────────────────────────────────────

export async function createWorkspaceForClient(
  input: unknown,
): Promise<CreateWorkspaceResult> {
  const userId = await assertSuperAdmin();
  if (!userId) return { error: "No autorizado" };

  const parsed = CreateWorkspaceSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  }

  const { name, useCase, clientEmail, clientPassword } = parsed.data;
  const service = svc();
  let clientCredentials: ClientCredentials | null = null;

  // Create workspace
  // Short, client-friendly slug: name + 3 random chars to avoid collisions.
  const baseSlug = generateSlug(name);
  const suffix = Math.random().toString(36).slice(2, 5);
  const slug = `${baseSlug}-${suffix}`;

  const { data: workspace, error: wsError } = await service
    .from("workspaces")
    .insert({ name, slug })
    .select("id")
    .single();

  if (wsError || !workspace) {
    console.error("[agency] workspace insert error:", wsError);
    return { error: "Error al crear el workspace" };
  }

  const workspaceId = (workspace as { id: string }).id;

  // The agency super admin manages every workspace they create — membership is
  // required for the membership-based RLS on conversations/messages/integrations,
  // so the "Gestionar" / "Inbox" actions actually load the client's data.
  const { error: ownerMemberError } = await service.from("memberships").insert({
    workspace_id: workspaceId,
    user_id: userId,
    role: "admin",
    is_active: true,
  });
  if (ownerMemberError) {
    console.error("[agency] owner membership insert error:", ownerMemberError);
  }

  // Provision the client account directly (no email/SMTP): create the user with
  // a known password and hand the credentials to the agency to share. The client
  // logs in directly — no invite email, no password-reset link needed.
  if (clientEmail && clientEmail.length > 0) {
    try {
      const provisioned = await provisionWorkspaceUser(service, clientEmail, {
        password: clientPassword || undefined,
      });

      const { error: memberError } = await service.from("memberships").insert({
        workspace_id: workspaceId,
        user_id: provisioned.userId,
        role: "admin",
        is_active: true,
      });
      if (memberError) {
        console.error("[agency] membership insert error:", memberError);
      }

      // Only surface a password when we just created the account.
      if (provisioned.password) {
        clientCredentials = {
          email: clientEmail,
          password: provisioned.password,
        };
      }
    } catch (err) {
      console.error("[agency] client provisioning error:", err);
      // Non-fatal — workspace still created, agency can add the user later.
    }
  }

  // Seed starter prompt
  const STARTER_PROMPTS: Record<string, string> = {
    setter:
      "Eres un agente de ventas amable y profesional para {{business_name}}. Tu objetivo es calificar leads y agendar citas.",
    soporte:
      "Eres un agente de soporte al cliente para {{business_name}}. Responde preguntas con precisión y empatía.",
    agendamiento:
      "Eres un asistente de agendamiento para {{business_name}}. Ayuda a los clientes a reservar citas.",
    general:
      "Eres un asistente virtual para {{business_name}}. Eres amable, claro y útil.",
  };

  const promptBody = (
    STARTER_PROMPTS[useCase] ?? STARTER_PROMPTS.general
  ).replace("{{business_name}}", name);

  const { data: promptRow } = await service
    .from("prompts")
    .insert({
      workspace_id: workspaceId,
      scope: "global",
      scope_ref: null,
      name: "Prompt principal",
    })
    .select("id")
    .single();

  if (promptRow) {
    const promptId = (promptRow as { id: string }).id;
    const { data: versionRow } = await service
      .from("prompt_versions")
      .insert({
        workspace_id: workspaceId,
        prompt_id: promptId,
        version: 1,
        state: "published",
        body: promptBody,
        published_at: new Date().toISOString(),
        created_by: userId,
      })
      .select("id")
      .single();

    if (versionRow) {
      const versionId = (versionRow as { id: string }).id;
      await service
        .from("prompts")
        .update({ active_version_id: versionId })
        .eq("id", promptId);
    }
  }

  // Seed business info so the "Negocio" tab and the agent context aren't empty.
  await service.from("business_info").insert({
    workspace_id: workspaceId,
    structured: { name },
    free_text: "",
  });

  // Seed the 3 agents (Setter / Soporte / Agendamiento). The chosen use case is
  // active (general → setter); each agent gets its own mode-scoped prompt.
  const activeType = useCase === "general" ? "setter" : useCase;
  const AGENT_NAMES: Record<string, string> = {
    setter: "Carlos",
    soporte: "Sofía",
    agendamiento: "Andrés",
  };
  for (const type of ["setter", "soporte", "agendamiento"] as const) {
    const body = (
      type === activeType
        ? promptBody
        : (STARTER_PROMPTS[type] ?? STARTER_PROMPTS.general)
    ).replace("{{business_name}}", name);

    const { data: agentPrompt } = await service
      .from("prompts")
      .insert({
        workspace_id: workspaceId,
        scope: "mode",
        scope_ref: type,
        name: `Agente ${type}`,
      })
      .select("id")
      .single();

    const agentPromptId = (agentPrompt as { id: string } | null)?.id ?? null;
    if (agentPromptId) {
      const { data: agentVersion } = await service
        .from("prompt_versions")
        .insert({
          workspace_id: workspaceId,
          prompt_id: agentPromptId,
          version: 1,
          state: "published",
          body,
          published_at: new Date().toISOString(),
          created_by: userId,
        })
        .select("id")
        .single();
      const agentVersionId = (agentVersion as { id: string } | null)?.id;
      if (agentVersionId) {
        await service
          .from("prompts")
          .update({ active_version_id: agentVersionId })
          .eq("id", agentPromptId);
      }
    }

    await service.from("agents").insert({
      workspace_id: workspaceId,
      type,
      name: AGENT_NAMES[type],
      avatar_key: type,
      model: null,
      is_active: type === activeType,
      prompt_id: agentPromptId,
    });
  }

  // Fail loud instead of shipping a dead placeholder host to the client.
  // In dev, fall back to localhost so local testing works.
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.NODE_ENV !== "production" ? "http://localhost:3000" : null);
  if (!baseUrl) {
    throw new Error(
      "NEXT_PUBLIC_APP_URL no está configurada — no se puede generar el webhook URL del workspace.",
    );
  }
  const webhookUrl = `${baseUrl}/api/webhooks/kapso?wsid=${workspaceId}`;

  return { workspaceId, webhookUrl, clientCredentials };
}

/**
 * Permanently deletes a client workspace and all its data (cascade).
 * Super-admin only; runs with the service role so it bypasses the
 * membership-based RLS. Irreversible.
 */
export async function deleteWorkspaceForClient(
  workspaceId: string,
): Promise<{ error?: string; ok?: boolean }> {
  const userId = await assertSuperAdmin();
  if (!userId) return { error: "No autorizado" };

  const service = svc();
  const { error } = await service
    .from("workspaces")
    .delete()
    .eq("id", workspaceId);

  if (error) {
    console.error("[agency] workspace delete error:", error);
    return { error: "Error al eliminar el cliente" };
  }

  return { ok: true };
}

export async function getAllWorkspacesWithStats(): Promise<GetWorkspacesResult> {
  const userId = await assertSuperAdmin();
  if (!userId) return { error: "No autorizado" };

  const service = svc();

  // Fetch all workspaces
  const { data: workspaces, error: wsError } = await service
    .from("workspaces")
    .select("id, name, slug, created_at")
    .order("created_at", { ascending: false });

  if (wsError) {
    console.error("[agency] fetch workspaces error:", wsError);
    return { error: "Error al cargar workspaces" };
  }

  if (!workspaces || workspaces.length === 0) {
    return { workspaces: [] };
  }

  const ids = (workspaces as { id: string }[]).map((w) => w.id);

  // Member counts
  const { data: memberships } = await service
    .from("memberships")
    .select("workspace_id")
    .in("workspace_id", ids)
    .eq("is_active", true);

  // Conversation counts
  const { data: conversations } = await service
    .from("conversations")
    .select("workspace_id")
    .in("workspace_id", ids);

  // Kapso integrations
  const { data: integrations } = await service
    .from("integrations")
    .select("workspace_id, enabled")
    .eq("provider", "kapso")
    .in("workspace_id", ids);

  // Build lookup maps
  const memberMap = new Map<string, number>();
  for (const m of memberships ?? []) {
    const id = (m as { workspace_id: string }).workspace_id;
    memberMap.set(id, (memberMap.get(id) ?? 0) + 1);
  }

  const convMap = new Map<string, number>();
  for (const c of conversations ?? []) {
    const id = (c as { workspace_id: string }).workspace_id;
    convMap.set(id, (convMap.get(id) ?? 0) + 1);
  }

  const kapsoMap = new Map<string, boolean>();
  for (const i of integrations ?? []) {
    const row = i as { workspace_id: string; enabled: boolean };
    kapsoMap.set(row.workspace_id, row.enabled);
  }

  const result: WorkspaceWithStats[] = (
    workspaces as {
      id: string;
      name: string;
      slug: string;
      created_at: string;
    }[]
  ).map((w) => ({
    id: w.id,
    name: w.name,
    slug: w.slug,
    created_at: w.created_at,
    member_count: memberMap.get(w.id) ?? 0,
    conversation_count: convMap.get(w.id) ?? 0,
    kapso_connected: kapsoMap.get(w.id) ?? false,
  }));

  return { workspaces: result };
}
