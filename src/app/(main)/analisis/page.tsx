import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveWorkspace } from "@/features/workspace/services/active-workspace";
import { loadInsights } from "@/features/analytics/services/insights";
import { emptyTopicsMessage, partialCoverageMessage } from "@/features/analytics/lib/insights-view";
import { RangeFilter } from "@/features/analytics/components/range-filter";
import { SummaryCards } from "@/features/analytics/components/summary-cards";
import { TopicRanking } from "@/features/analytics/components/topic-ranking";
import { CrossTable } from "@/features/analytics/components/cross-table";
import { TrendTable } from "@/features/analytics/components/trend-table";
import { TopicManager } from "@/features/analytics/components/topic-manager";

export const dynamic = "force-dynamic";

export default async function AnalisisPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const membership = await getActiveWorkspace(supabase, user.id);
  if (!membership) {
    return <p className="p-6 text-muted-foreground">No tienes un workspace activo.</p>;
  }

  const result = await loadInsights(membership.workspace_id, params);
  if (!result.ok) {
    return (
      <main className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
        <h1 className="font-display text-2xl font-semibold">Análisis</h1>
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
          {result.message}
        </p>
        {result.kind === "invalid" && (
          <Link href="/analisis" className="text-sm text-primary underline">
            Volver a los últimos 30 días
          </Link>
        )}
      </main>
    );
  }

  const { view, range, availableTags, topics, canManage } = result;
  const workspaceId = membership.workspace_id;
  const partialNotice = partialCoverageMessage(view.partialConversations);

  return (
    <main className="mx-auto max-w-5xl space-y-8 p-4 sm:p-6">
      <header className="space-y-3">
        <h1 className="font-display text-2xl font-semibold">Análisis</h1>
        <p className="text-sm text-muted-foreground">
          Los temas se analizan cada noche; lo de hoy aparece mañana.
        </p>
        <RangeFilter range={range} />
      </header>

      {view.stalePending && (
        <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          Hay conversaciones de días anteriores aún sin analizar; los números pueden cambiar.
        </p>
      )}

      {/* Límite declarado (60 mensajes, 800 caracteres por mensaje). */}
      {partialNotice && view.universe > 0 && (
        <p
          role="status"
          data-testid="partial-coverage-notice"
          className="rounded-lg border border-border bg-muted p-3 text-sm text-muted-foreground"
        >
          {partialNotice} Lo que quedó fuera del análisis puede no aparecer en los temas.
        </p>
      )}

      {topics.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-muted-foreground">
          {emptyTopicsMessage(canManage)}
        </p>
      ) : view.universe === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-muted-foreground">
          No hubo conversaciones con mensajes de clientes en este período.
        </p>
      ) : (
        <>
          <SummaryCards view={view} />
          <TopicRanking view={view} />
          <CrossTable
            workspaceId={workspaceId}
            view={view}
            range={range}
            availableTags={availableTags}
          />
          <TrendTable view={view} />
        </>
      )}

      <TopicManager workspaceId={workspaceId} topics={topics} canManage={canManage} />
    </main>
  );
}
