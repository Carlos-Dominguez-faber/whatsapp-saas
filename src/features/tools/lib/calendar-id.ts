// The model rarely omits an optional field cleanly — it sends "" or a
// guessed value like "default" instead of leaving it out. The workspace's
// configured calendar is admin-verified, so it always wins when present.
export function resolveCalendarId(
  workspaceCalendarId: string | null | undefined,
  modelCalendarId: string | null | undefined,
): string | undefined {
  return workspaceCalendarId || modelCalendarId || undefined;
}
