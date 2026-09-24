// Handoff notifications — what happens once a conversation lands in
// `handoff_pending`.
//
// Este módulo cubre el acuse que se le manda al CLIENTE ("alguien te va a
// atender"). Ese mensaje es texto libre, y es legal acá porque el contacto
// acaba de escribir: la ventana de 24h está abierta y tanto el guard de
// dispatchText() como el trigger check_outbound_24h_window() lo dejan pasar.
//
// El aviso al EQUIPO vive en team-notifier.ts y sale por EMAIL. Se dispara
// desde acá (ver notifyHandoffPending) porque este es el único punto por el que
// pasan los cinco caminos de handoff.
//
// Avisarle al equipo por WHATSAPP sigue sin implementarse a propósito: los
// números del equipo nunca nos escribieron, así que no hay ventana abierta y
// Meta exige una plantilla HSM aprobada, que un workspace no puede tener hasta
// que su WABA exista y esté verificada.
//
// Hard rule for everything in this module: a failed notification must never
// break or revert the handoff. Every path swallows its error and records it in
// `events` instead.

import { createClient as createSbClient } from "@supabase/supabase-js";
import { dispatchText } from "./dispatch";
import { DEFAULT_HANDOFF_ACK } from "../types/handoff";

export { DEFAULT_HANDOFF_ACK };

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

/**
 * True cuando ya se registró un evento de este `type` para la conversación en
 * los últimos `windowMinutes`. Compartido por el ACK al cliente
 * (`handoff_ack_sent`) y el aviso al equipo (`handoff_team_notified`) — misma
 * consulta, mismo motivo: una conversación entra y sale de handoff_pending
 * varias veces y cada vuelta no debe repetir el aviso.
 *
 * El filtro por `workspace_id` es parte del dedupe, no un adorno: la policy
 * `events_insert` deja que cualquier operador inserte una fila con SU propio
 * workspace y el `conversation_id` de una conversación ajena. Sin este
 * filtro, ese evento cruzado calla el aviso real del workspace dueño de la
 * conversación durante toda la ventana.
 */
export async function wasRecentlyLogged(
  workspaceId: string,
  conversationId: string,
  type: string,
  windowMinutes: number,
): Promise<boolean> {
  const supabase = svc();
  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();

  const { data } = await supabase
    .from("events")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("conversation_id", conversationId)
    .eq("type", type)
    .gte("created_at", since)
    .limit(1);

  return Boolean(data?.length);
}

/** Don't send a second acknowledgement within this window. */
const ACK_DEDUPE_MINUTES = 15;

export interface HandoffAckConfig {
  enabled: boolean;
  message: string;
}

/**
 * Reads the per-workspace acknowledgement settings from the Kapso integration
 * config — the same jsonb bag that already carries message_history_window.
 * Defaults to enabled so a workspace that never touches the setting still gives
 * the contact a reply instead of silence.
 */
export async function getHandoffAckConfig(
  workspaceId: string,
): Promise<HandoffAckConfig> {
  const supabase = svc();

  const { data } = await supabase
    .from("integrations")
    .select("config")
    .eq("workspace_id", workspaceId)
    .eq("provider", "kapso")
    .maybeSingle();

  const config = (data?.config ?? {}) as {
    handoff_ack_enabled?: boolean;
    handoff_ack_message?: string;
  };

  const message = config.handoff_ack_message?.trim();

  return {
    enabled: config.handoff_ack_enabled !== false,
    message: message || DEFAULT_HANDOFF_ACK,
  };
}

export async function logEvent(
  workspaceId: string,
  conversationId: string,
  type: string,
  level: "info" | "warn" | "error",
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await svc().from("events").insert({
      workspace_id: workspaceId,
      conversation_id: conversationId,
      type,
      level,
      payload,
    });
  } catch (err) {
    // Logging must not become the thing that breaks the handoff either.
    console.error("[handoff-notifier] failed to log event:", err);
  }
}

export interface HandoffNotifyParams {
  workspaceId: string;
  conversationId: string;
  /** What put the conversation in handoff_pending: keyword | agent | manual */
  trigger: string;
}

/**
 * Sends the contact-facing acknowledgement for a conversation that just entered
 * handoff_pending.
 *
 * Never throws. Never returns a value the caller is expected to act on — the
 * transition already happened and stands regardless of what happens here.
 */
export async function notifyHandoffPending(
  params: HandoffNotifyParams,
): Promise<void> {
  const { workspaceId, conversationId, trigger } = params;

  // El aviso al EQUIPO va ACÁ, antes de los tres cortes de abajo
  // (config.enabled, prefijo "tool:", dedupe del ACK): esos tres son del ACK
  // al CLIENTE, no del aviso al equipo. Un ACK apagado, una despedida que el
  // agente ya mandó, o un ACK reciente no significan que ya hay una persona
  // mirando la conversación — el equipo tiene que enterarse en los tres
  // casos igual. Import dinámico para no crear un ciclo estático con
  // team-notifier.ts, que sí importa este archivo (mismo patrón que usa
  // decision-engine.ts para importar este módulo).
  try {
    const { notifyTeamHandoff } = await import("./team-notifier");
    await notifyTeamHandoff({ workspaceId, conversationId, trigger });
  } catch (err) {
    console.error(
      "[handoff-notifier] team notify failed:",
      err instanceof Error ? err.message : err,
    );
  }

  try {
    const config = await getHandoffAckConfig(workspaceId);

    if (!config.enabled) return;

    // El corte aplica SOLO al prefijo "tool:", que significa "la despedida
    // del agente ya salió" (dispatch de 10a exitoso en buffer.ts). Mandar
    // igual el ACK genérico ahí duplicaría el mensaje. "tool_unsent:" — el
    // dispatch falló o nunca se intentó (rama dead-letter) — cae a propósito
    // al camino normal de abajo: el cliente no recibió nada del agente, así
    // que sí necesita el ACK genérico.
    if (trigger.startsWith("tool:")) {
      await logEvent(workspaceId, conversationId, "handoff_ack_skipped", "info", {
        reason: "agent_farewell",
        trigger,
      });
      return;
    }

    if (
      await wasRecentlyLogged(
        workspaceId,
        conversationId,
        "handoff_ack_sent",
        ACK_DEDUPE_MINUTES,
      )
    ) {
      await logEvent(workspaceId, conversationId, "handoff_ack_skipped", "info", {
        reason: "deduped",
        within_minutes: ACK_DEDUPE_MINUTES,
        trigger,
      });
      return;
    }

    const result = await dispatchText({
      workspaceId,
      conversationId,
      body: config.message,
      // No senderUserId: this is system-generated, same as an AI reply.
    });

    if (result.ok) {
      await logEvent(workspaceId, conversationId, "handoff_ack_sent", "info", {
        trigger,
      });
    } else {
      // WINDOW_EXPIRED and OPT_OUT are expected outcomes, not incidents: the
      // contact may have opted out, or the trigger came from an agent long
      // after the contact's last message.
      // Se ramifica por errorCode, no por el texto: el mensaje que ve el
      // operador ahora va en español y puede cambiar de redacción.
      const expected =
        result.errorCode === "WINDOW_EXPIRED" ||
        result.errorCode === "OPT_OUT";
      await logEvent(
        workspaceId,
        conversationId,
        "handoff_ack_failed",
        expected ? "info" : "warn",
        { trigger, error: result.error },
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A workspace with no Kapso integration yet is a normal state during
    // onboarding, not an incident worth an error-level event.
    const notConnected = message.includes("Kapso integration not found");
    await logEvent(
      workspaceId,
      conversationId,
      "handoff_ack_failed",
      notConnected ? "info" : "error",
      { trigger, error: message },
    );
  }
}
