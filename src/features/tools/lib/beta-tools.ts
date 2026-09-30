/**
 * Tools shipped as beta: off by default, and Settings → Tools marks them with
 * where to try them first.
 *
 * Pure module: safe to import from client components.
 */
const HIGHLEVEL_NOTE = "Pruébala primero en una sub-cuenta de HighLevel.";
const CALCOM_NOTE = "Pruébala primero con una cuenta de Cal.com de prueba.";

/** Beta tool → where to try it first. */
export const BETA_TOOLS: ReadonlyMap<string, string> = new Map([
  ["list_highlevel_appointments", HIGHLEVEL_NOTE],
  ["cancel_highlevel", HIGHLEVEL_NOTE],
  ["reschedule_highlevel", HIGHLEVEL_NOTE],
  ["list_event_types_calcom", CALCOM_NOTE],
  ["check_availability_calcom", CALCOM_NOTE],
  ["schedule_calcom", CALCOM_NOTE],
  ["cancel_calcom", CALCOM_NOTE],
  ["reschedule_calcom", CALCOM_NOTE],
  ["list_calcom_appointments", CALCOM_NOTE],
]);
