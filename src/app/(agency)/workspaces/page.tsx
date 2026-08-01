import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAllWorkspacesWithStats } from "@/features/agency/services/agency-actions";
import { WorkspacesTable } from "@/features/agency/components/workspaces-table";
import { Building2, Users, MessageCircle, Wifi } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AgencyWorkspacesPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: userRow } = await supabase
    .from("users")
    .select("is_super_admin")
    .eq("id", user.id)
    .single();

  if (!userRow?.is_super_admin) redirect("/inbox");

  const result = await getAllWorkspacesWithStats();

  const workspaces = result.error ? [] : (result.workspaces ?? []);

  // Aggregate stats for KPI cards
  const totalMembers = workspaces.reduce((sum, w) => sum + w.member_count, 0);
  const totalConversations = workspaces.reduce(
    (sum, w) => sum + w.conversation_count,
    0,
  );
  const connectedCount = workspaces.filter((w) => w.kapso_connected).length;

  const kpis = [
    {
      label: "Workspaces",
      value: workspaces.length,
      icon: Building2,
    },
    {
      label: "Miembros totales",
      value: totalMembers,
      icon: Users,
    },
    {
      label: "Conversaciones",
      value: totalConversations,
      icon: MessageCircle,
    },
    {
      label: "Kapso conectado",
      value: connectedCount,
      icon: Wifi,
    },
  ];

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Page header */}
      <div>
        <h1 className="font-display text-2xl font-semibold text-foreground tracking-tight">
          Workspaces
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Gestiona todos los workspaces de clientes desde aquí.
        </p>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {kpis.map(({ label, value, icon: Icon }) => (
          <div
            key={label}
            className="rounded-xl border border-border bg-card p-4 space-y-2"
          >
            <div className="flex items-center gap-2 text-muted-foreground">
              <Icon className="h-4 w-4" aria-hidden="true" />
              <span className="text-xs font-medium">{label}</span>
            </div>
            <p className="font-mono text-2xl font-bold text-foreground">
              {value}
            </p>
          </div>
        ))}
      </div>

      {/* Error banner */}
      {result.error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3">
          <p className="text-sm text-destructive">
            Error al cargar workspaces: {result.error}
          </p>
        </div>
      )}

      {/* Table */}
      <WorkspacesTable workspaces={workspaces} />
    </div>
  );
}
