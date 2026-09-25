import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSbClient } from "@supabase/supabase-js";
import { getActiveWorkspace } from "@/features/workspace/services/active-workspace";
import { ClientTestChat } from "@/features/agents/components/client-test-chat";
import { logout } from "@/features/auth/services/actions";

// Isolated, config-free screen: a client (e.g. a business owner trying the
// product before going live) can chat with their active agent and nothing
// else. No nav to Settings/Inbox/Dashboard/Agency, no prompt, no other
// workspace data reaches this page's props.
export default async function ProbarPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const membership = await getActiveWorkspace(supabase, user.id);

  if (!membership) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8 text-center text-sm text-muted-foreground">
        No tienes un workspace asignado. Contacta a quien te dio acceso.
      </div>
    );
  }

  const workspaceId = membership.workspace_id;

  // Service client for two narrow, explicit reads — never select prompt
  // bodies or anything beyond what this page actually needs.
  const svc = createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const [{ data: workspaceRow }, { data: agentRow }, { data: businessInfo }] =
    await Promise.all([
      svc.from("workspaces").select("name").eq("id", workspaceId).single(),
      svc
        .from("agents")
        .select("id, name, type")
        .eq("workspace_id", workspaceId)
        .eq("is_active", true)
        .maybeSingle(),
      svc
        .from("business_info")
        .select("structured")
        .eq("workspace_id", workspaceId)
        .maybeSingle(),
    ]);

  const businessName =
    ((businessInfo?.structured as { name?: string } | null)?.name as
      | string
      | undefined) ??
    workspaceRow?.name ??
    "tu negocio";

  if (!agentRow) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8 text-center text-sm text-muted-foreground">
        Todavía no hay un agente activo para probar. Contacta a quien te dio
        acceso.
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center bg-background px-4 py-10">
      <div className="flex w-full max-w-lg items-center justify-between pb-6">
        <span className="font-display text-sm font-medium text-muted-foreground">
          Bienvenido a {businessName}
        </span>
        <form action={logout}>
          <button
            type="submit"
            className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Salir
          </button>
        </form>
      </div>

      <div className="w-full max-w-lg">
        <ClientTestChat
          workspaceId={workspaceId}
          agentId={agentRow.id as string}
          agentName={agentRow.name as string}
          businessName={businessName}
        />
      </div>
    </div>
  );
}
