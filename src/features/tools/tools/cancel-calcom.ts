import { createClient as createSbClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../core/tool";

const schema = z.object({});

type Args = z.infer<typeof schema>;

interface ActiveAppointmentRow {
  id: string;
  calcom_booking_uid: string | null;
}

async function run(_args: Args, ctx: ToolContext): Promise<ToolResult> {
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
      error: "No encontré una cita activa para cancelar",
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
      error: "No encontré una cita activa para cancelar",
    };
  }

  const res = await fetch(
    `${CALCOM_BASE_URL}/v2/bookings/${appointmentRow.calcom_booking_uid}/cancel`,
    {
      method: "POST",
      headers: calcomHeaders(cfg.apiKey, CALCOM_API_VERSION.bookings),
      body: JSON.stringify({
        cancellationReason: "Cancelado por el cliente vía WhatsApp",
      }),
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

  const { error: updateError } = await supabase
    .from("appointments")
    .update({ status: "cancelled" })
    .eq("id", appointmentRow.id);
  if (updateError) {
    console.warn(
      "[cancel_calcom] cancelled in Cal.com but failed to update local status:",
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
          operation: "cancel",
          appointment_id: appointmentRow.id,
          calcom_booking_uid: appointmentRow.calcom_booking_uid,
          error: updateError.message,
        },
      });
    } catch (logErr) {
      // Fire-and-forget: never let logging failures surface to caller
      console.warn("[cancel_calcom] events insert failed:", logErr);
    }
  }

  return {
    ok: true,
    output: { cancelled: true },
  };
}

export const cancelCalComTool: Tool<Args> = {
  name: "cancel_calcom",
  description:
    "Cancela la cita activa más próxima del contacto en Cal.com. Úsala solo cuando el cliente haya confirmado explícitamente que quiere cancelar. Solo confirma la cancelación al cliente si esta herramienta responde con éxito — si falla o no encuentra una cita, dile la verdad, no inventes que se canceló.",
  sensitivity: "write",
  schema,
  enabledFor: () => true,
  run,
};
