import type { SupabaseClient } from "@supabase/supabase-js";
import { hlZoneOf } from "@/features/inbox/services/highlevel-client";
import { schedulingTimeZone } from "@/features/inbox/services/scheduling-timezone";
import type { BusinessInfo } from "@/features/inbox/services/business-info";

/**
 * The zone reminders are scheduled and written in: the same one every other
 * scheduling surface uses (schedulingTimeZone — the business's zone, then the
 * HighLevel location's, then DEFAULT_TIMEZONE). Never UTC by accident: a
 * reminder evaluated in UTC for a business in Mexico goes out at 2 am.
 *
 * Returns null only when the settings can't be read. The caller then skips
 * this tick instead of guessing a zone and messaging someone at night.
 */
export async function resolveWorkspaceTimezone(
  db: SupabaseClient,
  workspaceId: string,
): Promise<string | null> {
  const [info, hl] = await Promise.all([
    db
      .from("business_info")
      .select("structured, free_text")
      .eq("workspace_id", workspaceId)
      .limit(1)
      .maybeSingle(),
    db
      .from("integrations")
      .select("config")
      .eq("workspace_id", workspaceId)
      .eq("provider", "highlevel")
      .eq("enabled", true)
      .maybeSingle(),
  ]);

  if (info.error || hl.error) {
    console.error(
      `[workspace-timezone] workspace ${workspaceId}: could not read its zone settings:`,
      info.error?.message ?? hl.error?.message,
    );
    return null;
  }

  const business: BusinessInfo | null = info.data
    ? {
        structured: (info.data.structured as Record<string, unknown>) ?? {},
        free_text: (info.data.free_text as string | null) ?? null,
      }
    : null;
  const hlZone = hl.data
    ? hlZoneOf((hl.data.config as Record<string, unknown> | null) ?? {})
    : null;
  return schedulingTimeZone(business, hlZone);
}
