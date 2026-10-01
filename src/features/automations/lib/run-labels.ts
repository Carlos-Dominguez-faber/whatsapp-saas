/**
 * How a run's status and cause read to a person: the rule cards' "last run"
 * line and the runs panel share these.
 */

export const RUN_STATUS_LABELS: Record<string, string> = {
  done: "Se ejecutó",
  skipped: "Se omitió",
  failed: "Falló",
  pending: "En cola",
  processing: "En curso",
};

/** The run causes a person needs to read; any other shows as its code. */
const REASON_LABELS: Record<string, string> = {
  cooldown: "ya le había enviado en las últimas 24 h",
  daily_cap: "se alcanzó el tope diario",
  opted_out: "el contacto pidió no recibir mensajes",
  outcome_unknown: "no se sabe si llegó",
  send_rejected: "WhatsApp la rechazó",
  template_paused: "Meta pausó la plantilla",
  reminder_too_late: "demasiado cerca de la cita",
  outside_send_window: "fuera del horario de envío",
  appointment_not_active: "la cita ya no está activa",
  appointment_moved: "la cita cambió de hora",
  appointment_passed: "la cita ya pasó",
  stale: "el evento venció",
  rule_reenabled: "ocurrió antes de activar la regla",
  rule_disabled: "la regla estaba apagada",
  no_conversation: "sin conversación",
  calcom_not_connected: "Cal.com no está conectado",
  calcom_unconfirmable: "la cita no se puede comprobar en Cal.com",
  calcom_read_failed: "no se pudo leer Cal.com",
  pending_confirmation: "la cita espera que el negocio la acepte en Cal.com",
};

export function runReasonLabel(code: string): string {
  if (code.startsWith("missing_variable:")) {
    return `falta el dato ${code.slice("missing_variable:".length)}`;
  }
  if (code.startsWith("max_attempts:")) {
    const cause = code.slice("max_attempts:".length);
    return `se agotaron los intentos (${REASON_LABELS[cause] ?? cause})`;
  }
  return REASON_LABELS[code] ?? code;
}
