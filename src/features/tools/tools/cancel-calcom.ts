import { createClient as createSbClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult, ToolRunOptions } from "../core/tool";
import {
  APPOINTMENT_TOOL_TIMEOUT_MS,
  confirmedInstantError,
  describeInstant,
  hasTimeToWrite,
  noteForTeam,
  parseConfirmedInstant,
  UnknownOutcomeError,
  WRITE_TIMEOUT_MS,
} from "../lib/hl-appointment.ts";

const schema = z.object({
  appointment_datetime_iso: z
    .string()
    .describe(
      "Fecha y hora de la cita que el cliente confirmó cancelar, copiada exactamente de list_calcom_appointments (ISO 8601 con su offset). Si no está claro cuál cita es, pregúntale al cliente.",
    ),
});

type Args = z.infer<typeof schema>;

/** A tool answer that a person has to follow up: the buffer hands off after the reply. */
function needsHuman(error: string): ToolResult {
  return { ok: false, output: { needs_human: true }, error };
}

const UNCONFIRMED =
  "No pude confirmar la cita en el calendario en este momento, así que NO se canceló. Dile al cliente que una persona del equipo lo revisará.";

const UNKNOWN_CANCEL =
  "No pude confirmar si la cita se canceló. No le digas al cliente que quedó cancelada ni que falló: dile que una persona del equipo lo confirmará.";

async function run(args: Args, ctx: ToolContext, opts?: ToolRunOptions): Promise<ToolResult> {
  const startedAt = Date.now();
  const budgetMs = opts?.timeoutMs ?? APPOINTMENT_TOOL_TIMEOUT_MS;
  const { getCalComConfig, calcomRequest, CALCOM_API_VERSION } = await import(
    "../../inbox/services/calcom-client.ts"
  );
  const { getBusinessInfo } = await import("../../inbox/services/business-info.ts");
  const { workspaceSchedulingTimeZone } = await import("../../inbox/services/scheduling-timezone.ts");
  const { locateCalComBookingAt, markCalComCancelledLocally, onlyUpcomingCalComHint } = await import(
    "../lib/calcom-appointment.ts"
  );

  const cfg = await getCalComConfig(ctx.workspaceId);
  if (!cfg) {
    return { ok: false, output: null, error: "Cal.com no está conectado para este workspace" };
  }
  // The playground has no real contact, so there's no "their appointment".
  if (!ctx.contactId) {
    return {
      ok: false,
      output: null,
      error: "No hay un contacto real en esta conversación; no se puede cancelar una cita.",
    };
  }

  const zone = await workspaceSchedulingTimeZone(ctx.workspaceId, await getBusinessInfo(ctx.workspaceId));
  const parsed = parseConfirmedInstant(args.appointment_datetime_iso, zone);
  if ("error" in parsed) {
    return { ok: false, output: null, error: confirmedInstantError(parsed.error, zone) };
  }
  const instantMs = parsed.ms;
  const when = describeInstant(instantMs, zone);
  if (instantMs < Date.now()) {
    return { ok: false, output: null, error: `La cita del ${when} ya pasó; no se puede cancelar.` };
  }

  const supabase = createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const lookup = {
    supabase,
    apiKey: cfg.apiKey,
    workspaceId: ctx.workspaceId,
    contactId: ctx.contactId,
  };
  const unconfirmed = async (err?: unknown) => {
    if (err) console.error("[cancel_calcom] lookup failed:", err);
    await noteForTeam(
      supabase,
      ctx,
      "calcom_appointment_failed",
      `El cliente pidió cancelar su cita del ${when} y no se pudo confirmar en Cal.com. Revísalo tú.`,
    );
    return needsHuman(UNCONFIRMED);
  };

  // Cal.com's current view: the local rows are only a cache.
  let located;
  try {
    located = await locateCalComBookingAt({ ...lookup, instantMs });
  } catch (err) {
    return unconfirmed(err);
  }

  switch (located.kind) {
    case "unconfirmed":
      return unconfirmed();
    case "already_cancelled":
      return { ok: true, output: { cancelled: true, already_cancelled: true } };
    case "not_active":
      return {
        ok: false,
        output: null,
        error: "Esa cita ya no está activa, así que no se puede cancelar.",
      };
    case "not_found":
      return {
        ok: false,
        output: null,
        error: `No encontré una cita del cliente el ${when}. ${onlyUpcomingCalComHint(located.onlyUpcoming, zone)}No le digas que se canceló.`,
      };
    case "ambiguous":
      await noteForTeam(
        supabase,
        ctx,
        "calcom_appointment_failed",
        `El cliente pidió cancelar su cita del ${when}, pero tiene más de una a esa hora en Cal.com. No se canceló ninguna: revísalo tú.`,
      );
      return needsHuman(
        "El cliente tiene más de una cita a esa hora, así que no se canceló ninguna. Dile que una persona del equipo lo revisará.",
      );
  }

  const { booking } = located;
  // Nothing was written yet: saying so is true.
  if (!hasTimeToWrite(startedAt, budgetMs)) {
    return {
      ok: false,
      output: null,
      error: "El calendario tardó demasiado, así que la cita NO se canceló. Dile al cliente que lo intentas de nuevo en un momento.",
    };
  }

  const res = await calcomRequest(cfg.apiKey, `/v2/bookings/${encodeURIComponent(booking.uid)}/cancel`, {
    method: "POST",
    version: CALCOM_API_VERSION.bookings,
    timeoutMs: WRITE_TIMEOUT_MS,
    body: { cancellationReason: "Cancelada por el cliente por WhatsApp" },
  });

  if (res.kind === "no_answer" || (res.kind === "http" && res.status >= 500)) {
    console.error("[cancel_calcom] cancel got no answer:", res.kind === "http" ? res.status : res.reason);
    await noteForTeam(
      supabase,
      ctx,
      "calcom_appointment_unconfirmed",
      `Se pidió cancelar la cita del ${when} en Cal.com y no hubo confirmación. Revisa si quedó cancelada.`,
    );
    throw new UnknownOutcomeError(UNKNOWN_CANCEL);
  }
  if (res.kind === "http") {
    console.error(`[cancel_calcom] Cal.com ${res.status}:`, res.detail);
    await noteForTeam(
      supabase,
      ctx,
      "calcom_appointment_failed",
      `Cal.com rechazó cancelar la cita del ${when} (error ${res.status}). Revísalo tú.`,
    );
    return needsHuman(
      `El calendario respondió con un error (${res.status}); la cita NO se canceló. Dile al cliente que una persona del equipo lo revisará.`,
    );
  }

  await markCalComCancelledLocally(lookup, booking.uid);
  return { ok: true, output: { cancelled: true } };
}

export const cancelCalComTool: Tool<Args> = {
  name: "cancel_calcom",
  description:
    "Cancela en Cal.com la cita del cliente que empieza en la fecha y hora indicadas. Úsala solo cuando el cliente haya confirmado explícitamente cuál cita quiere cancelar (consulta sus citas con list_calcom_appointments y copia su datetime_iso). Solo confirma la cancelación si esta herramienta responde con éxito; si no encuentra la cita, falla o no pudo confirmar, dile la verdad.",
  sensitivity: "write",
  schema,
  enabledFor: () => true,
  run,
  preferredTimeoutMs: APPOINTMENT_TOOL_TIMEOUT_MS,
};
