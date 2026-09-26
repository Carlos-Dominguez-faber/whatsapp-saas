import type { SupabaseClient } from "@supabase/supabase-js";
import { mexicoDayStartIso } from "@/features/jev-judge/cost";

export async function countJudgmentsToday(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from("events")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("type", "jev_judgment")
    .filter("payload->>fallback", "eq", "false")
    .gte("created_at", mexicoDayStartIso());
  if (error) return 0;
  return count ?? 0;
}
