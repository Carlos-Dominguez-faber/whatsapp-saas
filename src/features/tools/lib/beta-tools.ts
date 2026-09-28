/**
 * Tools shipped as beta: off by default, and Settings → Tools marks them so
 * a workspace tries them on a HighLevel sub-account first.
 *
 * Pure module: safe to import from client components.
 */
export const BETA_TOOLS: ReadonlySet<string> = new Set([
  "list_highlevel_appointments",
  "cancel_highlevel",
  "reschedule_highlevel",
]);

export const BETA_NOTE = "Pruébala primero en una sub-cuenta de HighLevel.";
