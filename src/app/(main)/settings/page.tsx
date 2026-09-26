import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSbClient } from "@supabase/supabase-js";
import { getActiveWorkspace } from "@/features/workspace/services/active-workspace";
import { listAgents } from "@/features/agents/services/agent-queries";
import { SettingsShell } from "@/features/settings/components/settings-shell";
import { countJudgmentsToday } from "@/features/jev-judge/usage";
import { readJevUses } from "@/features/jev-judge/uses";

export default async function SettingsPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const membership = await getActiveWorkspace(supabase, user.id);

  if (!membership) {
    // Super admins without a workspace belong in the agency panel, not a dead end.
    const { data: userRow } = await supabase
      .from("users")
      .select("is_super_admin")
      .eq("id", user.id)
      .maybeSingle();
    if (userRow?.is_super_admin) {
      redirect("/workspaces");
    }
    return (
      <div className="p-8 text-sm text-muted-foreground">
        Sin workspace asignado. Contacta al administrador.
      </div>
    );
  }

  const workspaceId = membership.workspace_id as string;

  const svc = createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const [
    { data: biData },
    { data: toolsData },
    { data: toolConfigsData },
    { data: integrationsData },
  ] = await Promise.all([
    svc
      .from("business_info")
      .select("*")
      .eq("workspace_id", workspaceId)
      .single(),
    svc.from("tools").select("*").order("name"),
    svc
      .from("tool_configs")
      .select("tool_id, enabled, config")
      .eq("workspace_id", workspaceId),
    svc
      .from("integrations")
      .select("provider, enabled, credentials, oauth_tokens, config")
      .eq("workspace_id", workspaceId),
  ]);

  const initialAgents = await listAgents(svc, workspaceId);
  const ycloud = (integrationsData ?? []).find(
    (row) => row.provider === "ycloud",
  );
  const ycloudConfig = (ycloud?.config as Record<string, unknown> | null) ?? {};
  const judgmentsToday = await countJudgmentsToday(svc, workspaceId);

  // Mask credentials server-side before passing to client components
  function maskRecord(
    obj: Record<string, unknown> | null,
  ): Record<string, string> {
    if (!obj) return {};
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, v ? "••••••" : ""]),
    );
  }

  const maskedIntegrations = (integrationsData ?? []).map(
    (row: Record<string, unknown>) => ({
      provider: row.provider,
      enabled: row.enabled,
      config: (row.config as Record<string, unknown>) ?? {},
      credentials: maskRecord(
        (row.credentials as Record<string, unknown>) ?? null,
      ),
      oauth_tokens: maskRecord(
        (row.oauth_tokens as Record<string, unknown>) ?? null,
      ),
    }),
  );

  const enabledToolIds = new Set(
    (toolConfigsData ?? [])
      .filter((t) => t.enabled)
      .map((t) => t.tool_id as string),
  );
  const configByToolId = new Map(
    (toolConfigsData ?? []).map((t) => [
      t.tool_id as string,
      (t.config as Record<string, unknown> | null) ?? null,
    ]),
  );

  const toolsWithEnabled = (toolsData ?? []).map(
    (tool: Record<string, unknown>) => ({
      id: tool.id as string,
      key: tool.key as string,
      name: tool.name as string,
      description: (tool.description as string | null) ?? "",
      sensitivity: (tool.sensitivity as string) ?? "read",
      enabled: enabledToolIds.has(tool.id as string),
      config: configByToolId.get(tool.id as string) ?? null,
    }),
  );

  return (
    <SettingsShell
      workspaceId={workspaceId}
      role={membership.role as string}
      initialBusinessInfo={biData ?? null}
      initialTools={toolsWithEnabled}
      initialIntegrations={maskedIntegrations}
      initialAgents={initialAgents}
      jev={{
        enabled: ycloudConfig.jev_enabled === true,
        uses: readJevUses(ycloudConfig),
        keyReady: Boolean(process.env.TYPESAFE_API_KEY),
        judgmentsToday,
      }}
    />
  );
}
