import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Inserts an event unless this workspace already has one of `type` today
 * (UTC) — or, with `sameAs`, one whose payload contains those keys (once a
 * day per contact, say). For alerts that would otherwise repeat on every
 * turn. Best-effort: a failure is logged and never thrown.
 */
export async function emitEventOncePerDay(
  supabase: SupabaseClient,
  workspaceId: string,
  type: string,
  level: "info" | "warn" | "error",
  payload: Record<string, unknown>,
  sameAs?: Record<string, unknown>,
): Promise<void> {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  try {
    let lookup = supabase
      .from("events")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("type", type)
      .gte("created_at", dayStart.toISOString());
    if (sameAs) lookup = lookup.contains("payload", sameAs);
    const { data: existing, error } = await lookup.limit(1);
    if (error) throw error;
    if ((existing?.length ?? 0) > 0) return;

    const { error: insertError } = await supabase.from("events").insert({
      type,
      level,
      workspace_id: workspaceId,
      payload,
    });
    if (insertError) throw insertError;
  } catch (err) {
    console.error(`[events] failed to record ${type}:`, err);
  }
}
