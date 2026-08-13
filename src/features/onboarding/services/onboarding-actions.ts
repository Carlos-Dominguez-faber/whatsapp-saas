"use server";

import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { z } from "zod";
import { encryptCredentials } from "@/shared/lib/integration-secrets";

// ─── Schema ───────────────────────────────────────────────────────────────────

export const OnboardingSchema = z.object({
  useCase: z.enum(["setter", "soporte", "agendamiento", "general"]),
  businessName: z.string().min(1, "El nombre del negocio es requerido"),
  industry: z.string().optional(),
  description: z.string().optional(),
  ycloudApiKey: z.string().optional(),
  ycloudPhone: z.string().optional(),
  ycloudSigningSecret: z.string().optional(),
});

export type OnboardingInput = z.infer<typeof OnboardingSchema>;
export type OnboardingResult =
  | { workspaceId: string; error?: never }
  | { workspaceId?: never; error: string };

// ─── Starter prompts per use case ─────────────────────────────────────────────

const STARTER_PROMPTS: Record<string, string> = {
  setter: `Eres un agente de ventas amable y profesional para {{business_name}}. Tu objetivo es calificar leads y agendar citas. Haz preguntas de descubrimiento, escucha las necesidades del cliente y guíalo hacia una llamada o reunión.`,
  soporte: `Eres un agente de soporte al cliente para {{business_name}}. Responde preguntas con precisión, resuelve problemas con empatía y escala a un humano cuando sea necesario.`,
  agendamiento: `Eres un asistente de agendamiento para {{business_name}}. Ayuda a los clientes a reservar citas, confirma disponibilidad y envía recordatorios.`,
  general: `Eres un asistente virtual para {{business_name}}. Eres amable, claro y útil. Responde las preguntas del cliente y ayúdalo a obtener la información que necesita.`,
};

// ─── Slug generator ───────────────────────────────────────────────────────────

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

// ─── Server action ────────────────────────────────────────────────────────────

export async function completeOnboarding(
  input: unknown,
): Promise<OnboardingResult> {
  // 1. Validate input
  const parsed = OnboardingSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  }

  const data = parsed.data;

  // 2. Auth check
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return { error: "No autorizado" };
  }

  // 3. Use service client to bypass RLS for the initial workspace creation
  //    (the user has no membership yet, so RLS blocks inserts)
  const serviceClient = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // 4. Generate unique slug
  const baseSlug = generateSlug(data.businessName);
  const suffix = Math.random().toString(36).slice(2, 5);
  const slug = `${baseSlug}-${suffix}`;

  // 5. Create workspace
  const { data: workspace, error: wsError } = await serviceClient
    .from("workspaces")
    .insert({
      name: data.businessName,
      slug,
    })
    .select("id")
    .single();

  if (wsError || !workspace) {
    console.error("[completeOnboarding] workspace insert error:", wsError);
    return { error: "Error al crear el workspace" };
  }

  const workspaceId = workspace.id as string;

  // 6. Create membership (admin role)
  const { error: memberError } = await serviceClient
    .from("memberships")
    .insert({
      workspace_id: workspaceId,
      user_id: user.id,
      role: "admin",
      is_active: true,
    });

  if (memberError) {
    console.error("[completeOnboarding] membership insert error:", memberError);
    // Rollback workspace
    await serviceClient.from("workspaces").delete().eq("id", workspaceId);
    return { error: "Error al crear la membresía" };
  }

  // 7. Create business_info
  const { error: biError } = await serviceClient.from("business_info").insert({
    workspace_id: workspaceId,
    structured: {
      name: data.businessName,
      industry: data.industry ?? "",
    },
    free_text: data.description ?? "",
  });

  if (biError) {
    console.error("[completeOnboarding] business_info insert error:", biError);
    // Non-fatal — continue
  }

  // 8. Seed starter prompt
  const rawBody = STARTER_PROMPTS[data.useCase] ?? STARTER_PROMPTS.general;
  const promptBody = rawBody.replace("{{business_name}}", data.businessName);

  const { data: promptRow, error: promptError } = await serviceClient
    .from("prompts")
    .insert({
      workspace_id: workspaceId,
      scope: "global",
      scope_ref: null,
      name: "Prompt principal",
    })
    .select("id")
    .single();

  if (!promptError && promptRow) {
    const promptId = (promptRow as { id: string }).id;

    const { data: versionRow, error: versionError } = await serviceClient
      .from("prompt_versions")
      .insert({
        workspace_id: workspaceId,
        prompt_id: promptId,
        version: 1,
        state: "published",
        body: promptBody,
        published_at: new Date().toISOString(),
        created_by: user.id,
      })
      .select("id")
      .single();

    if (!versionError && versionRow) {
      const versionId = (versionRow as { id: string }).id;
      await serviceClient
        .from("prompts")
        .update({ active_version_id: versionId })
        .eq("id", promptId);
    }
  }

  // 8b. Seed the 3 agents (Setter / Soporte / Agendamiento). The chosen use case
  // is active (general → setter); each agent gets its own mode-scoped prompt.
  const activeType = data.useCase === "general" ? "setter" : data.useCase;
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
    ).replace("{{business_name}}", data.businessName);

    const { data: agentPrompt } = await serviceClient
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
      const { data: agentVersion } = await serviceClient
        .from("prompt_versions")
        .insert({
          workspace_id: workspaceId,
          prompt_id: agentPromptId,
          version: 1,
          state: "published",
          body,
          published_at: new Date().toISOString(),
          created_by: user.id,
        })
        .select("id")
        .single();
      const agentVersionId = (agentVersion as { id: string } | null)?.id;
      if (agentVersionId) {
        await serviceClient
          .from("prompts")
          .update({ active_version_id: agentVersionId })
          .eq("id", agentPromptId);
      }
    }

    await serviceClient.from("agents").insert({
      workspace_id: workspaceId,
      type,
      name: AGENT_NAMES[type],
      avatar_key: type,
      model: null,
      is_active: type === activeType,
      prompt_id: agentPromptId,
    });
  }

  // 9. Save YCloud integration (if credentials provided)
  if (data.ycloudApiKey) {
    const { error: intError } = await serviceClient
      .from("integrations")
      .insert({
        workspace_id: workspaceId,
        provider: "ycloud",
        enabled: true,
        credentials: await encryptCredentials(
          {
            ycloud_api_key: data.ycloudApiKey,
            webhook_signing_secret: data.ycloudSigningSecret ?? "",
          },
          workspaceId,
          "ycloud",
        ),
        config: {
          phone_number: data.ycloudPhone ?? "",
        },
        oauth_tokens: {},
      });

    if (intError) {
      console.error("[completeOnboarding] integration insert error:", intError);
      // Non-fatal — user can configure later in settings
    }
  }

  return { workspaceId };
}
