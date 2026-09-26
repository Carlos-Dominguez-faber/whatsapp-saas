// Dashboard metrics — service role queries (no RLS needed for aggregates)

import { createClient as createSbClient } from "@supabase/supabase-js";
import type { ConversationState } from "@/features/inbox/types";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export interface WorkspaceMetrics {
  messagesToday: number;
  activeConversations: number;
  handoffPending: number;
  /** null when the viewer may not see it (events are admin/manager only). */
  llmCostWeekUsd: number | null;
  templatesSentWeek: number;
}

export interface RecentConversation {
  id: string;
  contactName: string | null;
  contactPhone: string;
  lastMessagePreview: string | null;
  state: ConversationState;
  lastMessageAt: string | null;
}

// Rough $/token estimate for cost display (blended model avg)
const USD_PER_TOKEN = 0.000_002;

export async function getWorkspaceMetrics(
  workspaceId: string,
  opts: {
    /**
     * The LLM cost comes from events, which RLS shows to admins and managers
     * only; these reads use the service role, so the caller decides.
     */
    includeLlmCost: boolean;
  },
): Promise<WorkspaceMetrics> {
  const supabase = svc();

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const weekStart = new Date();
  weekStart.setUTCDate(weekStart.getUTCDate() - 7);
  weekStart.setUTCHours(0, 0, 0, 0);

  const [
    messagesResult,
    activeResult,
    handoffResult,
    llmEventsResult,
    templatesResult,
  ] = await Promise.all([
    // Messages today (all directions)
    supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .gte("created_at", todayStart.toISOString()),

    // Active conversations
    supabase
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .in("state", ["ai_active", "human_active"]),

    // Handoff pending
    supabase
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("state", "handoff_pending"),

    // LLM usage events this week (admins and managers only)
    opts.includeLlmCost
      ? supabase
          .from("events")
          .select("payload")
          .eq("workspace_id", workspaceId)
          .eq("type", "llm_usage")
          .gte("created_at", weekStart.toISOString())
      : Promise.resolve({ data: null }),

    // Templates sent this week
    supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("type", "template")
      .gte("created_at", weekStart.toISOString()),
  ]);

  const totalTokensWeek = (llmEventsResult.data ?? []).reduce((sum, row) => {
    const payload = row.payload as Record<string, unknown> | null;
    const t = payload?.total_tokens;
    return sum + (typeof t === "number" ? t : 0);
  }, 0);

  return {
    messagesToday: messagesResult.count ?? 0,
    activeConversations: activeResult.count ?? 0,
    handoffPending: handoffResult.count ?? 0,
    llmCostWeekUsd: opts.includeLlmCost ? totalTokensWeek * USD_PER_TOKEN : null,
    templatesSentWeek: templatesResult.count ?? 0,
  };
}

export async function getRecentConversations(
  workspaceId: string,
  limit = 5,
): Promise<RecentConversation[]> {
  const supabase = svc();

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const { data } = await supabase
    .from("conversations")
    .select(
      `
      id,
      state,
      last_message_at,
      contacts!inner(name, phone),
      messages(body, direction, created_at)
    `,
    )
    .eq("workspace_id", workspaceId)
    .gte("last_message_at", todayStart.toISOString())
    .order("last_message_at", { ascending: false })
    .limit(limit);

  if (!data) return [];

  return data.map((row) => {
    const contact = Array.isArray(row.contacts)
      ? row.contacts[0]
      : row.contacts;
    const msgs = Array.isArray(row.messages) ? row.messages : [];
    const lastMsg = msgs.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    )[0];

    return {
      id: row.id,
      contactName: (contact as { name: string | null })?.name ?? null,
      contactPhone: (contact as { phone: string })?.phone ?? "",
      lastMessagePreview: lastMsg?.body ?? null,
      state: row.state as ConversationState,
      lastMessageAt: row.last_message_at,
    };
  });
}
