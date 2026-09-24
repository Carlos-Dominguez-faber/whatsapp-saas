import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { logout } from "@/features/auth/services/actions";
import {
  getActiveWorkspace,
  listMemberships,
} from "@/features/workspace/services/active-workspace";
import { WorkspaceSwitcher } from "@/features/workspace/components/workspace-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  BarChart3,
  Building2,
  LayoutDashboard,
  LogOut,
  MessageCircle,
  Settings,
} from "lucide-react";
import Link from "next/link";

export default async function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  // Super admin flag + active workspace context + membership list (for switcher)
  const [{ data: userRow }, active, memberships] = await Promise.all([
    supabase
      .from("users")
      .select("is_super_admin")
      .eq("id", user.id)
      .maybeSingle(),
    getActiveWorkspace(supabase, user.id),
    listMemberships(supabase, user.id),
  ]);

  const isSuperAdmin = userRow?.is_super_admin ?? false;
  const activeId = active?.workspace_id ?? null;
  const workspaceName =
    memberships.find((m) => m.workspace_id === activeId)?.name ?? null;

  return (
    <div className="min-h-screen flex flex-col">
      <header
        className={cn(
          "glass-strong sticky top-0 z-50 h-14 shrink-0",
          "flex items-center justify-between px-3 sm:px-6",
          "border-b border-border/50",
        )}
      >
        {/* Left: brand + workspace name */}
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-display text-base font-semibold text-primary tracking-tight shrink-0">
            Agente WA
          </span>
          {workspaceName && (
            <>
              <span
                className="text-border/70 select-none shrink-0"
                aria-hidden="true"
              >
                /
              </span>
              {memberships.length > 1 && activeId ? (
                <WorkspaceSwitcher
                  workspaces={memberships.map((m) => ({
                    workspace_id: m.workspace_id,
                    name: m.name,
                  }))}
                  activeId={activeId}
                />
              ) : (
                <span
                  className="font-mono text-xs text-muted-foreground truncate max-w-[120px] sm:max-w-[200px]"
                  title={workspaceName}
                >
                  {workspaceName}
                </span>
              )}
            </>
          )}
        </div>

        {/* Right: agency link (super admin only) + dashboard + settings + logout */}
        <div className="flex items-center gap-1 shrink-0">
          <ThemeToggle />

          {isSuperAdmin && (
            <Link href="/workspaces">
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground"
              >
                <Building2 className="h-4 w-4" aria-hidden="true" />
                <span className="sr-only sm:not-sr-only sm:ml-2">Agency</span>
              </Button>
            </Link>
          )}

          <Link href="/inbox">
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
            >
              <MessageCircle className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only sm:not-sr-only sm:ml-2">Inbox</span>
            </Button>
          </Link>

          <Link href="/dashboard">
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
            >
              <LayoutDashboard className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only sm:not-sr-only sm:ml-2">Dashboard</span>
            </Button>
          </Link>

          <Link href="/analisis">
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
            >
              <BarChart3 className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only sm:not-sr-only sm:ml-2">Análisis</span>
            </Button>
          </Link>

          <Link href="/settings">
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
            >
              <Settings className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only sm:not-sr-only sm:ml-2">Settings</span>
            </Button>
          </Link>

          <form action={logout}>
            <Button
              type="submit"
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only sm:not-sr-only sm:ml-2">Salir</span>
            </Button>
          </form>
        </div>
      </header>

      <div className="flex-1 pb-14 md:pb-0">{children}</div>

      {/* Mobile bottom nav — hidden on md+ */}
      <nav
        className={cn(
          "md:hidden fixed bottom-0 inset-x-0 z-50 h-14",
          "glass-strong border-t border-border/50",
          "flex items-center justify-around px-4",
        )}
        aria-label="Navegación móvil"
      >
        <Link
          href="/inbox"
          className="flex flex-col items-center gap-0.5 text-xs text-muted-foreground hover:text-primary transition-colors"
        >
          <MessageCircle className="h-5 w-5" aria-hidden="true" />
          <span>Inbox</span>
        </Link>

        <Link
          href="/dashboard"
          className="flex flex-col items-center gap-0.5 text-xs text-muted-foreground hover:text-primary transition-colors"
        >
          <LayoutDashboard className="h-5 w-5" aria-hidden="true" />
          <span>Dashboard</span>
        </Link>

        <Link
          href="/analisis"
          className="flex flex-col items-center gap-0.5 text-xs text-muted-foreground hover:text-primary transition-colors"
        >
          <BarChart3 className="h-5 w-5" aria-hidden="true" />
          <span>Análisis</span>
        </Link>

        <Link
          href="/settings"
          className="flex flex-col items-center gap-0.5 text-xs text-muted-foreground hover:text-primary transition-colors"
        >
          <Settings className="h-5 w-5" aria-hidden="true" />
          <span>Settings</span>
        </Link>

        {isSuperAdmin && (
          <Link
            href="/workspaces"
            className="flex flex-col items-center gap-0.5 text-xs text-muted-foreground hover:text-primary transition-colors"
          >
            <Building2 className="h-5 w-5" aria-hidden="true" />
            <span>Agency</span>
          </Link>
        )}
      </nav>
    </div>
  );
}
