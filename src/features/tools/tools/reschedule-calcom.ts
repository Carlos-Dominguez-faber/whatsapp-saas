import { createClient as createSbClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../core/tool";

const schema = z.object({
  new_datetime_iso: z
    .string()
    .describe(
      "Nuevo inicio de la cita en ISO 8601 UTC, ej: 2026-06-13T15:00:00Z",
    ),
});

type Args = z.infer<typeof schema>;

interface ActiveAppointmentRow {
  id: string;
  calcom_booking_uid: string | null;
}

interface CalComBookingResponse {
  status: string;
  data?: { uid: string };
}

async function run(args: Args, ctx: ToolContext): Promise<ToolResult> {
  const {
    getCalComConfig,
    calcomHeaders,
    CALCOM_BASE_URL,
    CALCOM_API_VERSION,
    redactCalComApiKey,
  } = await import("../../inbox/services/calcom-client.ts");

  const cfg = await getCalComConfig(ctx.workspaceId);
  if (!cfg) {
    return {
      ok: false,
      output: null,
      error: "Cal.com no está conectado para este workspace",
    };
  }

  // No real contact (the playground has none) means there is no "this
  // contact's appointment" to find. Returning early here also avoids relying
  // on .eq("contact_id", null), which supabase-js sends as a literal
  // eq.null filter — not the same as IS NULL — rather than guessing at that
  // behavior.
  if (!ctx.contactId) {
    return {
      ok: false,
      output: null,
      error: "No encontré una cita activa para reagendar",
    };
  }

  const supabase = createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data: appointment } = await supabase
    .from("appointments")
    .select("id, calcom_booking_uid")
    .eq("workspace_id", ctx.workspaceId)
    .eq("contact_id", ctx.contactId)
    .in("status", ["booked", "confirmed"])
    .not("calcom_booking_uid", "is", null)
    // A past appointment that never got marked 'completed' (no cron/webhook
    // does that yet) must not shadow a real future one forever — "the
    // active appointment" means the next upcoming one.
    .gte("scheduled_at", new Date().toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  const appointmentRow = appointment as ActiveAppointmentRow | null;
  if (!appointmentRow?.calcom_booking_uid) {
    return {
      ok: false,
      output: null,
      error: "No encontré una cita activa para reagendar",
    };
  }

  const res = await fetch(
    `${CALCOM_BASE_URL}/v2/bookings/${appointmentRow.calcom_booking_uid}/reschedule`,
    {
      method: "POST",
      headers: calcomHeaders(cfg.apiKey, CALCOM_API_VERSION.bookings),
      body: JSON.stringify({ start: args.new_datetime_iso }),
    },
  );

  if (!res.ok) {
    const err = redactCalComApiKey(await res.text(), cfg.apiKey);
    return {
      ok: false,
      output: null,
      error: `Cal.com API error: ${res.status} ${err.slice(0, 150)}`,
    };
  }

  // Cal.com creates a NEW booking on reschedule (new uid) rather than
  // mutating the old one — persist the new uid, not just the new time, or
  // the next cancel/reschedule will call a stale/replaced booking uid.
  const data = (await res.json()) as CalComBookingResponse;
  const newUid = data.data?.uid;

  if (!newUid) {
    return {
      ok: false,
      output: null,
      error: "Cal.com no devolvió un ID de reserva válido al reagendar",
    };
  }

  const { error: updateError } = await supabase
    .from("appointments")
    .update({
      scheduled_at: args.new_datetime_iso,
      calcom_booking_uid: newUid,
    })
    .eq("id", appointmentRow.id);
  if (updateError) {
    console.warn(
      "[reschedule_calcom] rescheduled in Cal.com but failed to update local record:",
      updateError,
    );
    try {
      await supabase.from("events").insert({
        type: "appointment_update_failed",
        level: "error",
        workspace_id: ctx.workspaceId,
        conversation_id: ctx.conversationId,
        payload: {
          provider: "calcom",
          operation: "reschedule",
          appointment_id: appointmentRow.id,
          old_calcom_booking_uid: appointmentRow.calcom_booking_uid,
          new_calcom_booking_uid: newUid,
          error: updateError.message,
        },
      });
    } catch (logErr) {
      // Fire-and-forget: never let logging failures surface to caller
      console.warn("[reschedule_calcom] events insert failed:", logErr);
    }
  }

  return {
    ok: true,
    output: { rescheduled: true, new_datetime: args.new_datetime_iso },
  };
}

export const rescheduleCalComTool: Tool<Args> = {
  name: "reschedule_calcom",
  description:
    "Reagenda la cita activa más próxima del contacto en Cal.com a un nuevo horario. Úsala solo cuando el cliente haya confirmado explícitamente el nuevo horario — considera llamar primero a check_availability_calcom para ofrecer un horario real. Solo confirma el cambio al cliente si esta herramienta responde con éxito — si falla o no encuentra una cita, dile la verdad, no inventes que se reagendó.",
  sensitivity: "write",
  schema,
  enabledFor: () => true,
  run,
};
