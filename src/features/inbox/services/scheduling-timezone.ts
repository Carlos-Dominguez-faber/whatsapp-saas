import { resolveTimeZone } from "@/shared/lib/timezone";
import type { BusinessInfo } from "./business-info";
import { hlConfiguredTimeZone } from "./highlevel-client";

/**
 * The ONE zone every scheduling surface uses: the prompt's calendar table,
 * the slots check_availability returns, and what list, schedule, cancel and
 * reschedule read and write. The business's zone (Settings → Negocio), then
 * the HighLevel location's (when the integration has one), then
 * DEFAULT_TIMEZONE.
 *
 * The slots the model copies are written with this zone's offset, and the
 * tools that take a date check the offset against it: a slot from one zone
 * read as a wall clock in another would book or move the wrong hour.
 */
export function schedulingTimeZone(
  info: BusinessInfo | null,
  hlTimeZone: string | null | undefined,
): string {
  const business = (info?.structured as { timezone?: string } | undefined)?.timezone;
  return resolveTimeZone(business, hlTimeZone ?? undefined);
}

/** schedulingTimeZone for a workspace, for callers without the HighLevel config at hand. */
export async function workspaceSchedulingTimeZone(
  workspaceId: string,
  info: BusinessInfo | null,
): Promise<string> {
  return schedulingTimeZone(info, await hlConfiguredTimeZone(workspaceId));
}
