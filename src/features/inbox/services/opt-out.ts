import { normalizeText } from "./state-machine";

/**
 * Whole-message keywords a contact sends to stop, or resume, the business's
 * proactive messages. Only an exact message counts (after lowercasing,
 * dropping accents and punctuation): "baja" is an opt-out, "me doy de baja
 * del gimnasio, ¿cómo le hago?" is a question for the agent.
 */
const STOP_KEYWORDS = new Set([
  "stop",
  "baja",
  "alto",
  "unsubscribe",
  "darme de baja",
  "dar de baja",
  "cancelar suscripcion",
  "no mas mensajes",
]);

const START_KEYWORDS = new Set(["start", "alta", "unstop", "suscribir", "suscribirme"]);

export type OptOutIntent = "stop" | "start" | null;

export function optOutIntent(text: string | null | undefined): OptOutIntent {
  if (!text) return null;
  const clean = normalizeText(text)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean || clean.length > 40) return null;
  if (STOP_KEYWORDS.has(clean)) return "stop";
  if (START_KEYWORDS.has(clean)) return "start";
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
