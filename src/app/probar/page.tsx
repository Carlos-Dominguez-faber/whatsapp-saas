import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSbClient } from "@supabase/supabase-js";
import { getActiveWorkspace } from "@/features/workspace/services/active-workspace";
import { ClientTestChat } from "@/features/agents/components/client-test-chat";
import { logout } from "@/features/auth/services/actions";

export const metadata: Metadata = {
  title: "Probar el agente",
};

export const dynamic = "force-dynamic";

// A screen to chat with the workspace's active agent and nothing else — for
// whoever should try the agent without the app around it (a client before
// going live, say). It hides the navigation; it does NOT isolate data: the
// same account can still open /inbox, /dashboard or the prompts directly.
// Hand it out on a demo workspace (INSTALAR.md explains why).
export default async function ProbarPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/probar");

  const membership = await getActiveWorkspace(supabase, user.id);
  if (!membership) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8 text-center text-sm text-muted-foreground">
        No tienes un espacio asignado. Contacta a quien te dio acceso.
      </div>
    );
  }

  const workspaceId = membership.workspace_id;
  const isStaff = membership.role === "admin" || membership.role === "manager";

  // Two narrow reads with the service role (the member was checked above):
  // the names this page shows, never a prompt or a setting.
  const svc = createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const [{ data: workspaceRow }, { data: agentRow }, { data: businessInfo }] =
    await Promise.all([
      svc.from("workspaces").select("name").eq("id", workspaceId).maybeSingle(),
      svc
        .from("agents")
        .select("name")
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
    (workspaceRow?.name as string | undefined) ??
    "el negocio";

  return (
    <div className="flex min-h-screen flex-col items-center bg-background px-4 py-10">
      <div className="flex w-full max-w-lg items-center justify-between gap-4 pb-6">
        <span className="font-display text-sm font-medium text-muted-foreground">
          {businessName}
        </span>
        <div className="flex items-center gap-4">
          {membership.role !== "viewer" && (
            <Link
              href="/inbox"
              className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Ir a la app
            </Link>
          )}
          <form action={logout}>
            <button
              type="submit"
              className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Salir
            </button>
          </form>
        </div>
      </div>

      <div className="w-full max-w-lg space-y-4">
        {isStaff && (
          <p
            role="note"
            className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs"
          >
            Comparte esta pantalla (<code>/probar</code>) con quien quieras que pruebe el
            agente. Solo corren las herramientas de consulta. No aísla datos: con la misma
            cuenta se puede abrir el inbox y la configuración, así que para alguien de fuera
            usa un espacio de demostración, sin conversaciones reales.
          </p>
        )}

        {agentRow ? (
          <ClientTestChat
            workspaceId={workspaceId}
            agentName={agentRow.name as string}
            businessName={businessName}
          />
        ) : (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            Todavía no hay un agente activo para probar. Contacta a quien te dio acceso.
          </p>
        )}
      </div>
    </div>
  );
}
