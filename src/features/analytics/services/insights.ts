import { createClient as createSbClient } from "@supabase/supabase-js";
import { checkWorkspaceMember } from "@/lib/auth/workspace-access";
import { resolveWorkspaceTimezone } from "@/features/automations/lib/workspace-timezone";
import { parseInsightsParams, type InsightsRange } from "../lib/schemas";
import { toInsightsView, type InsightsView, type RawInsights } from "../lib/insights-view";
import type { InsightTopic } from "./topic-actions";

export type LoadInsightsResult =
  | {
      ok: true;
      view: InsightsView;
      range: InsightsRange;
      availableTags: string[];
      topics: InsightTopic[];
      canManage: boolean;
      tz: string;
    }
  | { ok: false; kind: "forbidden" | "invalid" | "error"; message: string };

const MSG_FORBIDDEN = "No tienes acceso al análisis de este espacio.";
const MSG_ERROR = "No se pudo cargar el análisis, intenta de nuevo en unos minutos.";

function svc() {
  return createSbClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

export async function loadInsights(
  workspaceId: string,
  params: Record<string, string | string[] | undefined>,
  now: Date = new Date(),
): Promise<LoadInsightsResult> {
  // Lee con service_role: verifica la membresía ella misma (viewer o superior).
  const member = await checkWorkspaceMember(workspaceId, { minRole: "viewer" });
  if (!member.ok) return { ok: false, kind: "forbidden", message: MSG_FORBIDDEN };

  const db = svc();
  // null NO es "usa UTC". El helper ya devuelve DEFAULT_TIMEZONE cuando de
  // verdad no hay nada configurado; null significa "no hay zona confiable", y
  // con eso los cortes de día, los porcentajes y la evidencia saldrían de otra
  // zona horaria sin que nadie lo note.
  const tz = await resolveWorkspaceTimezone(db, workspaceId);
  if (tz === null) {
    console.error("[analisis] load failed", "timezone_unresolved");
    return { ok: false, kind: "error", message: MSG_ERROR };
  }

  const parsed = parseInsightsParams(params, tz, now);
  if (!parsed.ok) return { ok: false, kind: "invalid", message: parsed.error };
  const range = parsed.value;

  const [insights, tags, topics] = await Promise.all([
    db.rpc("get_insights", {
      p_workspace_id: workspaceId,
      p_from: range.fromIso,
      p_to: range.toIso,
      p_tags: range.tags,
      p_tz: tz,
    }),
    db.rpc("get_workspace_tags", { p_workspace_id: workspaceId }),
    db
      .from("insight_topics")
      .select("id, name, description, status, backfill_status, created_at")
      .eq("workspace_id", workspaceId)
      .eq("status", "active")
      .order("created_at"),
  ]);

  const failed = insights.error ?? tags.error ?? topics.error;
  if (failed || !insights.data) {
    console.error("[analisis] load failed", failed?.code ?? "empty_insights");
    return { ok: false, kind: "error", message: MSG_ERROR };
  }

  return {
    ok: true,
    view: toInsightsView(insights.data as RawInsights, tz, now),
    range,
    availableTags: ((tags.data ?? []) as Array<{ tag: string }>).map((t) => t.tag),
    topics: (topics.data ?? []) as InsightTopic[],
    canManage: member.role === "manager" || member.role === "admin",
    tz,
  };
}
