import { createClient as createSbClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../core/tool";

const schema = z.object({
  new_datetime_iso: z
    .string()
    .describe(
      "Nuevo inicio de la cita en ISO 8601 con zona horaria, ej: 2026-06-12T10:00:00-06:00",
    ),
});

type Args = z.infer<typeof schema>;

interface ActiveAppointmentRow {
  id: string;
  hl_appointment_id: string | null;
}

interface ContactHLIdRow {
  hl_contact_id: string | null;
}

async function run(args: Args, ctx: ToolContext): Promise<ToolResult> {
  const { getHLConfig, findActiveHLAppointmentByContact } = await import(
    "../../inbox/services/highlevel-client.ts"
  );

  const cfg = await getHLConfig(ctx.workspaceId);
  if (!cfg) {
    return {
      ok: false,
      output: null,
      error: "HighLevel no está conectado para este workspace",
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
    .select("id, hl_appointment_id")
    .eq("workspace_id", ctx.workspaceId)
    .eq("contact_id", ctx.contactId)
    .in("status", ["booked", "confirmed"])
    // A row without an HighLevel id can't be acted on here, so it must not
    // shadow one that can.
    .not("hl_appointment_id", "is", null)
    // A past appointment that never got marked 'completed' (no cron/webhook
    // does that yet) must not shadow a real future one forever — "the
    // active appointment" means the next upcoming one.
    .gte("scheduled_at", new Date().toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  const appointmentRow = appointment as ActiveAppointmentRow | null;
  let hlAppointmentId = appointmentRow?.hl_appointment_id ?? null;

  // The local row can be missing even when the appointment exists in
  // HighLevel (e.g. its insert failed after the booking) — HighLevel is
  // the source of truth, so fall back to asking it directly before failing.
  if (!hlAppointmentId && ctx.contactId) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("hl_contact_id")
      .eq("id", ctx.contactId)
      .eq("workspace_id", ctx.workspaceId)
      .maybeSingle();
    const hlContactId =
      (contact as ContactHLIdRow | null)?.hl_contact_id ?? null;
    if (hlContactId) {
      const { getBusinessInfo, resolveTimeZone } = await import(
        "../../inbox/services/business-info.ts"
      );
      const timeZone = resolveTimeZone(await getBusinessInfo(ctx.workspaceId));
      const found = await findActiveHLAppointmentByContact(
        cfg,
        hlContactId,
        timeZone,
      );
      hlAppointmentId = found?.id ?? null;
    }
  }

  if (!hlAppointmentId) {
    return {
      ok: false,
      output: null,
      error: "No encontré una cita activa para reagendar",
    };
  }

  const res = await fetch(
    `https://services.leadconnectorhq.com/calendars/events/appointments/${hlAppointmentId}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Version: "v3",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ startTime: args.new_datetime_iso }),
    },
  );

  if (!res.ok) {
    const err = await res.text();
    return {
      ok: false,
      output: null,
      error: `HL API error: ${res.status} ${err.slice(0, 150)}`,
    };
  }

  // Only a local row we already had can be updated here — when the
  // appointment was resolved via the HighLevel fallback there was no local
  // row to update.
  if (appointmentRow) {
    const { error: updateError } = await supabase
      .from("appointments")
      .update({ scheduled_at: args.new_datetime_iso })
      .eq("id", appointmentRow.id);
    if (updateError) {
      console.warn(
        "[reschedule_highlevel] rescheduled in HighLevel but failed to update local record:",
        updateError,
      );
    }
  }

  return {
    ok: true,
    output: { rescheduled: true, new_datetime: args.new_datetime_iso },
  };
}

export const rescheduleHighLevelTool: Tool<Args> = {
  name: "reschedule_highlevel",
  description:
    "Reagenda la cita activa más próxima del contacto en HighLevel a un nuevo horario. Úsala solo cuando el cliente haya confirmado explícitamente el nuevo horario — considera llamar primero a check_availability para ofrecer un horario real. Solo confirma el cambio al cliente si esta herramienta responde con éxito — si falla o no encuentra una cita, dile la verdad, no inventes que se reagendó.",
  sensitivity: "write",
  schema,
  enabledFor: () => true,
  run,
};
