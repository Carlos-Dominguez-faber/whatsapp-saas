// Aviso por email al EQUIPO cuando una conversación entra en
// `handoff_pending`. Hoy la única señal para un humano es tener el inbox
// abierto; esto manda un correo a cada operador activo del workspace.
//
// Opt-in por workspace (`handoff_team_email` en la config de WhatsApp,
// apagado por defecto), con un tope de correos por hora por workspace.
//
// Mismo contrato de dureza que handoff-notifier.ts: un fallo acá JAMÁS puede
// romper ni revertir el handoff. Todo va en un solo try/catch y cada salida
// (incluido "no está configurado") queda registrada en `events`.

import { createClient as createSbClient } from "@supabase/supabase-js";
import { logEvent, wasRecentlyLogged } from "./handoff-notifier";
import { emitEventOncePerDay } from "./daily-events";
import { loadWhatsAppSettings } from "./whatsapp-provider";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

const TEAM_NOTIFY_DEDUPE_MINUTES = 15;
const MAX_RECIPIENTS = 20;
/** Avisos (handoffs notificados) por workspace y hora; lo demás se salta. */
export const TEAM_NOTIFY_HOURLY_CAP = 10;

/** Roles que reciben el aviso — el mismo criterio de escritura del CRM (viewer queda fuera). */
const NOTIFIABLE_ROLES = ["admin", "manager", "agent"];

/** Formato mínimo, no RFC completo — solo para no mandarle un solo POST con
 * basura a Resend y que rechace la lista entera (422) por un email malo. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Traduce el `trigger` de la transición a una frase en español para el correo. */
const TRIGGER_LABELS: Record<string, string> = {
  keyword: "el cliente escribió una palabra clave de traspaso",
  manual: "un operador pidió el traspaso manualmente",
  agent: "el agente de IA pidió el traspaso",
  cost_cut: "se alcanzó el tope de costo de IA para esta conversación",
  customer_request: "el cliente pidió hablar con una persona",
  agent_stuck: "el agente de IA no pudo resolver la consulta por su cuenta",
  handoff_failed:
    "no se pudo pasar la conversación a una persona automáticamente y la IA sigue activa",
  tool_failed:
    "una acción de agenda falló o no se pudo confirmar, y se le dijo al cliente que una persona lo revisará",
  write_unconfirmed: "una acción de la IA no se pudo confirmar; revisa qué quedó hecho",
};

function describeTrigger(trigger: string): string {
  const bare = trigger.replace(/^tool(_unsent)?:/, "");
  return (
    TRIGGER_LABELS[bare] ??
    TRIGGER_LABELS[trigger] ??
    "la conversación necesita que una persona la revise"
  );
}

export interface TeamHandoffParams {
  workspaceId: string;
  conversationId: string;
  /** Lo mismo que le llega a notifyHandoffPending: keyword | manual | agent | cost_cut | tool:*|tool_unsent:* */
  trigger: string;
}

interface MembershipEmailRow {
  role: string;
  users: { email: string; is_active: boolean | null } | null;
}

const ROLE_ORDER: Record<string, number> = { admin: 0, manager: 1, agent: 2 };

interface ConversationContactIdRow {
  contact_id: string;
}

interface ContactNamePhoneRow {
  name: string | null;
  phone: string;
}

/**
 * Manda el aviso por email. Nunca lanza — cualquier error queda en
 * `console.error` (server-side) y/o en un evento `warn`, nunca en el correo.
 */
export async function notifyTeamHandoff(
  params: TeamHandoffParams,
): Promise<void> {
  const { workspaceId, conversationId, trigger } = params;

  try {
    const supabase = svc();

    // Opt-in: sin el switch del workspace no se manda nada, ni se registra.
    const whatsapp = await loadWhatsAppSettings(supabase, workspaceId);
    const enabled =
      (whatsapp?.config as { handoff_team_email?: boolean } | undefined)
        ?.handoff_team_email === true;
    if (!enabled) return;

    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.HANDOFF_NOTIFY_FROM;

    if (!apiKey || !from) {
      await logEvent(
        workspaceId,
        conversationId,
        "handoff_team_notify_skipped",
        "info",
        { reason: "not_configured", trigger },
      );
      return;
    }

    // El dedupe comprueba antes de mandar y registra después, sin
    // reserva atómica — dos transiciones a handoff_pending casi simultáneas
    // pueden pasar las dos el check y mandar dos correos. El daño es un
    // correo de más, no una acción destructiva; una reserva atómica (p. ej.
    // un UPSERT con constraint única por ventana) cuesta bastante más que
    // ese costo. Subir esto de rango si algún día el correo dispara una
    // acción no idempotente.
    if (
      await wasRecentlyLogged(
        workspaceId,
        conversationId,
        "handoff_team_notified",
        TEAM_NOTIFY_DEDUPE_MINUTES,
      )
    ) {
      await logEvent(
        workspaceId,
        conversationId,
        "handoff_team_notify_skipped",
        "info",
        { reason: "deduped", within_minutes: TEAM_NOTIFY_DEDUPE_MINUTES, trigger },
      );
      return;
    }

    // Tope por workspace y hora: una racha de traspasos (por ejemplo, un
    // corte de presupuesto con cost_cut_handoff) no se convierte en una
    // ráfaga de correos. Se registra una vez al día que se llegó al tope.
    const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    const { count: sentLastHour, error: capError } = await supabase
      .from("events")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("type", "handoff_team_notified")
      .gte("created_at", hourAgo);
    if (capError) {
      console.error("[team-notifier] hourly cap query failed:", capError.message);
      await logEvent(
        workspaceId,
        conversationId,
        "handoff_team_notify_failed",
        "warn",
        { reason: "cap_query_failed", trigger },
      );
      return;
    }
    if ((sentLastHour ?? 0) >= TEAM_NOTIFY_HOURLY_CAP) {
      await emitEventOncePerDay(
        supabase,
        workspaceId,
        "handoff_team_notify_capped",
        "warn",
        { hourly_cap: TEAM_NOTIFY_HOURLY_CAP },
      );
      return;
    }

    const { data: memberships, error: membershipsError } = await supabase
      .from("memberships")
      .select("role, users(email, is_active)")
      .eq("workspace_id", workspaceId)
      .eq("is_active", true)
      .in("role", NOTIFIABLE_ROLES);

    if (membershipsError) {
      // Una consulta caída NO es "workspace sin operadores": si se cuenta
      // igual, nadie se entera de que el correo no salió por un fallo de la
      // base y no por falta de destinatarios.
      console.error(
        "[team-notifier] memberships query failed:",
        membershipsError.message,
      );
      await logEvent(
        workspaceId,
        conversationId,
        "handoff_team_notify_failed",
        "warn",
        { reason: "recipients_query_failed", trigger },
      );
      return;
    }

    // The cap applies after dropping deactivated users and bad addresses,
    // admins first: a large team must not crowd out the people in charge.
    const rawEmails = ((memberships ?? []) as unknown as MembershipEmailRow[])
      .filter((m) => m.users?.is_active !== false)
      .sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9))
      .map((m) => m.users?.email)
      .filter((email): email is string => Boolean(email));

    const validEmails = rawEmails.filter((email) => EMAIL_RE.test(email));
    const invalidCount = rawEmails.length - validEmails.length;

    if (invalidCount > 0) {
      // La dirección en sí NUNCA va al evento (lo lee cualquier miembro del
      // workspace) ni al `console.error` — ninguno de los dos necesita el
      // dato personal, solo saber que algo se descartó.
      console.error(
        `[team-notifier] ${invalidCount} destinatario(s) con email inválido, descartado(s)`,
      );
      await logEvent(
        workspaceId,
        conversationId,
        "handoff_team_notify_anomaly",
        "warn",
        { reason: "invalid_recipient_emails", discarded: invalidCount, trigger },
      );
    }

    const recipients = Array.from(new Set(validEmails)).slice(0, MAX_RECIPIENTS);

    if (recipients.length === 0) {
      // "no había nadie elegible" y "había gente pero todos con email roto"
      // son motivos distintos para quien revisa: el segundo apunta a datos
      // sucios en `users.email`, no a un workspace sin operadores.
      await logEvent(
        workspaceId,
        conversationId,
        "handoff_team_notify_skipped",
        invalidCount > 0 ? "warn" : "info",
        {
          reason: invalidCount > 0 ? "no_valid_recipients" : "no_recipients",
          trigger,
        },
      );
      return;
    }

    // Sin embed: `conversations.contact_id` es una FK simple y nada impide
    // que apunte a un contacto de OTRO workspace. Se resuelve en dos
    // consultas, cada una filtrando su propio tenant, en vez de confiar en
    // que el embed haya respetado el workspace del contacto.
    const { data: conv, error: convError } = await supabase
      .from("conversations")
      .select("contact_id")
      .eq("id", conversationId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();

    if (convError) {
      // Un fallo de infraestructura NO es "conversación de otro workspace":
      // acá no se puede afirmar nada sobre a quién pertenece la conversación,
      // así que no se manda correo (podría estar exponiendo un enlace ajeno).
      console.error(
        "[team-notifier] conversations query failed:",
        convError.message,
      );
      await logEvent(
        workspaceId,
        conversationId,
        "handoff_team_notify_failed",
        "warn",
        { reason: "conversation_read_failed", trigger },
      );
      return;
    }

    if (!conv) {
      await logEvent(
        workspaceId,
        conversationId,
        "handoff_team_notify_skipped",
        "warn",
        { reason: "conversation_not_in_workspace", trigger },
      );
      return;
    }

    const { contact_id: contactId } = conv as ConversationContactIdRow;

    const { data: contactRow, error: contactError } = await supabase
      .from("contacts")
      .select("name, phone")
      .eq("id", contactId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();

    let contactLabel: string;
    // El asunto lleva a lo más el nombre, nunca el teléfono: el asunto se ve
    // en notificaciones y vistas previas.
    let subjectLabel = "un contacto";
    if (contactError) {
      // Acá sí se manda el correo: el equipo necesita saber que hay una
      // conversación esperando aunque no se haya podido resolver el nombre.
      console.error(
        "[team-notifier] contacts query failed:",
        contactError.message,
      );
      contactLabel = "un contacto";
      await logEvent(
        workspaceId,
        conversationId,
        "handoff_team_notify_failed",
        "warn",
        { reason: "contact_read_failed", trigger },
      );
    } else if (contactRow) {
      const contact = contactRow as ContactNamePhoneRow;
      contactLabel = contact.name
        ? `${contact.name} (${contact.phone})`
        : contact.phone;
      if (contact.name) subjectLabel = contact.name;
    } else {
      // Anomalía de datos: el contact_id de la conversación no calza con
      // este workspace. Se manda el correo igual (el equipo sigue
      // necesitando saber que hay una conversación esperando) pero sin
      // exponer nombre ni teléfono de un contacto ajeno.
      contactLabel = "un contacto";
      await logEvent(
        workspaceId,
        conversationId,
        "handoff_team_notify_anomaly",
        "warn",
        { reason: "contact_workspace_mismatch", trigger },
      );
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const link = `${appUrl}/inbox/${conversationId}`;
    const reasonText = describeTrigger(trigger);

    const text =
      `Hola,\n\n` +
      `${contactLabel} necesita que una persona tome la conversación.\n` +
      `Motivo: ${reasonText}.\n\n` +
      `Puedes verla acá: ${link}\n`;

    let resendOk = false;
    try {
      // Un correo por destinatario (endpoint batch de Resend, una sola
      // llamada): nadie ve las direcciones de los demás.
      const res = await fetch("https://api.resend.com/emails/batch", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(
          recipients.map((to) => ({
            from,
            to: [to],
            subject: `Un cliente necesita ayuda: ${subjectLabel}`,
            text,
          })),
        ),
        // Este aviso corre con await ANTES del ACK al cliente (ver
        // handoff-notifier.ts): sin tope, un Resend colgado retrasa el
        // mensaje que le dice al cliente que alguien lo va a atender. Un
        // timeout acá cuenta como envío fallido más abajo (evento warn) y
        // eso está bien: a diferencia del envío por WhatsApp de Kapso, donde
        // reintentar puede duplicar un mensaje que el cliente ya recibió,
        // reintentar este correo es inofensivo — peor caso, dos correos
        // iguales al equipo. NO unificar con la política de timeout de
        // Kapso: son la regla contraria a propósito.
        signal: AbortSignal.timeout(5000),
      });
      resendOk = res.ok;
      if (!res.ok) {
        console.error("[team-notifier] Resend respondió", res.status);
      }
    } catch (err) {
      console.error(
        "[team-notifier] fetch a Resend falló:",
        err instanceof Error ? err.message : err,
      );
    }

    if (resendOk) {
      await logEvent(
        workspaceId,
        conversationId,
        "handoff_team_notified",
        "info",
        { trigger, recipients: recipients.length },
      );
    } else {
      await logEvent(
        workspaceId,
        conversationId,
        "handoff_team_notify_failed",
        "warn",
        { trigger },
      );
    }
  } catch (err) {
    console.error(
      "[team-notifier] unexpected error:",
      err instanceof Error ? err.message : err,
    );
  }
}
