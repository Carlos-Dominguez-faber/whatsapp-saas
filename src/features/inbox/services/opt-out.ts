import { normalizeText } from "./state-machine";

/**
 * Whole-message phrases a contact sends to stop, or resume, the business's
 * proactive messages (automations and templates; replies in an open window
 * still go out). Only an explicit, exact message counts, after lowercasing and
 * dropping accents and punctuation. Bare words like "baja", "alta" or "alto"
 * are ordinary one-word answers ("¿planta alta o baja?", a list or button
 * tap), so they don't count; "me quiero dar de baja del gimnasio" is a
 * question for the agent.
 */
const STOP_PHRASES = new Set([
  "stop",
  "unsubscribe",
  "darme de baja",
  "no mas mensajes",
  "no quiero recibir mensajes",
  // Meta's opt-out button on marketing templates.
  "stop promotions",
  "detener promociones",
]);

const START_PHRASES = new Set(["start", "suscribirme", "reanudar mensajes"]);

export type OptOutIntent = "stop" | "start" | null;

export function optOutIntent(text: string | null | undefined): OptOutIntent {
  if (!text) return null;
  const clean = normalizeText(text)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean || clean.length > 40) return null;
  if (STOP_PHRASES.has(clean)) return "stop";
  if (START_PHRASES.has(clean)) return "start";
  return null;
}

/**
 * The columns to write when someone sets a contact's opt-in by hand: a manual
 * opt-out is an explicit one (it sticks, see trg_contacts_keep_opt_out), and a
 * manual opt-in clears it.
 */
export function manualOptInFields(optIn: boolean | undefined): Record<string, unknown> {
  if (optIn === undefined) return {};
  const now = new Date().toISOString();
  return optIn
    ? { opt_in: true, opt_in_at: now, opted_out_at: null }
    : { opt_in: false, opted_out_at: now };
}
