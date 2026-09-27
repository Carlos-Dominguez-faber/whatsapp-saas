import { createClient as createSbClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult, ToolRunOptions } from "../core/tool";
import { resolveCalendarId } from "../lib/calendar-id.ts";
import { formatWithOffset } from "@/shared/lib/timezone";
import {
  APPOINTMENT_TOOL_TIMEOUT_MS,
  confirmedInstantError,
  hasTimeToWrite,
  HL_API,
  HL_VERSION_EVENTS,
  hlTimeZone,
  locateAppointmentAt,
  noteForTeam,
  parseConfirmedInstant,
  UnknownOutcomeError,
  WRITE_TIMEOUT_MS,
} from "../lib/hl-appointment.ts";

const schema = z.object({
  datetime_iso: z
    .string()
    .describe(
      "Inicio de la cita, copiado exactamente de check_availability (ISO 8601 con su offset, ej: 2026-06-12T10:00:00-06:00).",
    ),
  calendar_id: z
    .string()
    .optional()
    .describe(
      "ID del calendario de HighLevel (usa el del workspace si se omite)",
    ),
  contact_name: z
    .string()
    .optional()
    .describe("Nombre del contacto para la cita"),
  contact_phone: z
    .string()
    .optional()
    .describe(
      "Teléfono del contacto en E.164 (ej: +5215512345678). Solo se usa en el playground de prueba; en una conversación real se agenda al contacto del chat.",
    ),
});

type Args = z.infer<typeof schema>;

interface ContactRow {
  hl_contact_id: string | null;
  phone: string;
  name: string | null;
}

interface HLAppointmentResponse {
  id?: string;
  appointment?: { id?: string };
}

/**
 * HighLevel's wording when the slot is taken ("The slot you have selected is
 * no longer available"). Unverified against a live account: see the PR.
 */
const SLOT_TAKEN = /\bslot\b[^.]{0,60}\b(?:no longer available|not available|unavailable|already booked)\b/i;

const UNKNOWN_BOOKING =
  "No pude confirmar si la cita quedó agendada. No le digas al cliente que se agendó ni que falló: dile que una persona del equipo lo confirmará.";

async function run(args: Args, ctx: ToolContext, opts?: ToolRunOptions): Promise<ToolResult> {
  const startedAt = Date.now();
  const budgetMs = opts?.timeoutMs ?? APPOINTMENT_TOOL_TIMEOUT_MS;
  const { getHLConfig, upsertHLContactByPhone, linkHLContact } =
    await import("../../inbox/services/highlevel-client.ts");
  const { getBusinessInfo } = await import("../../inbox/services/business-info.ts");
  const { schedulingTimeZone } = await import("../../inbox/services/scheduling-timezone.ts");

  const cfg = await getHLConfig(ctx.workspaceId);
  if (!cfg) {
    return {
      ok: false,
      output: null,
      error: "HighLevel no está conectado para este workspace",
    };
  }

  const calendarId = resolveCalendarId(cfg.calendarId, args.calendar_id);
  if (!calendarId) {
    return {
      ok: false,
      output: null,
      error: "No hay un calendario de HighLevel configurado",
    };
  }

  // The slot as check_availability wrote it, in the same zone: a time copied
  // from another zone is refused, not guessed.
  const zone = schedulingTimeZone(await getBusinessInfo(ctx.workspaceId), cfg.timezone);
  const start = parseConfirmedInstant(args.datetime_iso, zone);
  if ("error" in start) {
    return { ok: false, output: null, error: confirmedInstantError(start.error, zone) };
  }
  if (start.ms < Date.now()) {
    return { ok: false, output: null, error: "Ese horario ya pasó; ofrécele uno futuro." };
  }
  const startTime = formatWithOffset(start.ms, zone);

  const supabase = createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // Resolve the contact. In a real conversation it is always the chat's own
  // contact: a phone the model passes is honored only in the playground,
  // which has no contact, so the model can't book on someone else's number.
  let phone = ctx.contactId ? null : (args.contact_phone ?? null);
  let name = args.contact_name ?? null;
  let hlContactId: string | null = null;
  let dbContactId: string | null = null;

  if (!phone && ctx.contactId) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("hl_contact_id, phone, name")
      .eq("id", ctx.contactId)
      .eq("workspace_id", ctx.workspaceId)
      .single();
    const contactRow = contact as ContactRow | null;
    if (contactRow?.phone) {
      phone = contactRow.phone;
      name = name ?? contactRow.name;
      hlContactId = contactRow.hl_contact_id;
      dbContactId = ctx.contactId;
    }
  }

  if (!phone) {
    return {
      ok: false,
      output: null,
      error: "Falta el teléfono del contacto para agendar",
    };
  }

  // Ensure the contact exists in HighLevel (create/upsert by phone if needed).
  if (!hlContactId) {
    hlContactId = await upsertHLContactByPhone(cfg, { name, phone });
    if (hlContactId && dbContactId) {
      // A conflict (another local contact already holds this HighLevel id) is
      // logged and evented by linkHLContact; the booking still goes ahead.
      await linkHLContact(supabase, ctx.workspaceId, dbContactId, hlContactId);
    }
  }

  if (!hlContactId) {
    return {
      ok: false,
      output: null,
      error: "No se pudo crear el contacto en HighLevel",
    };
  }

  // A taken slot may be the contact's own booking, made by an earlier call
  // whose answer never arrived: HighLevel says whose it is.
  const slotTaken = async (): Promise<ToolResult> => {
    const other: ToolResult = {
      ok: false,
      output: null,
      error: "Ese horario ya no está disponible, así que la cita NO se agendó. Consulta otra vez check_availability y ofrécele al cliente otro horario.",
    };
    if (!dbContactId) return other;
    let located;
    try {
      located = await locateAppointmentAt({
        supabase,
        cfg: { ...cfg, calendarId },
        workspaceId: ctx.workspaceId,
        contactId: dbContactId,
        instantMs: start.ms,
        hlZone: hlTimeZone(cfg, zone),
      });
    } catch (err) {
      console.error("[schedule_highlevel] slot owner lookup failed:", err);
      located = { kind: "unconfirmed" as const };
    }
    if (located.kind === "found") {
      return {
        ok: true,
        output: {
          appointment_id: located.appointment.id,
          datetime: formatWithOffset(located.appointment.startMs, zone),
          already_booked: true,
        },
      };
    }
    if (located.kind === "unconfirmed" || located.kind === "ambiguous") {
      await noteForTeam(
        supabase,
        ctx,
        "hl_appointment_unconfirmed",
        `HighLevel dijo que el horario del ${startTime} ya está ocupado y no se pudo confirmar si es la cita del cliente. Revísalo tú.`,
      );
      return {
        ok: false,
        output: { needs_human: true },
        error: "No pude confirmar si ese horario quedó a nombre del cliente. No le digas que se agendó ni que falló: dile que una persona del equipo lo confirmará.",
      };
    }
    return other;
  };

  // Nothing was written yet: saying so is true.
  if (!hasTimeToWrite(startedAt, budgetMs)) {
    return {
      ok: false,
      output: null,
      error: "El calendario tardó demasiado, así que la cita NO se agendó. Dile al cliente que lo intentas de nuevo en un momento.",
    };
  }

  let res: Response;
  try {
    res = await fetch(`${HL_API}/calendars/events/appointments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        // POST /calendars/events/appointments, HighLevel's OpenAPI spec.
        Version: HL_VERSION_EVENTS,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        calendarId,
        locationId: cfg.locationId,
        contactId: hlContactId,
        startTime,
        title: `Cita${args.contact_name ? ` — ${args.contact_name}` : ""}`,
      }),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
  } catch (err) {
    // Sent, and no answer: the booking may exist.
    console.error("[schedule_highlevel] booking got no answer:", err);
    throw new UnknownOutcomeError(UNKNOWN_BOOKING);
  }

  if (!res.ok) {
    // The raw body is HighLevel's own wording (English, internal ids): log
    // it, but give the model a plain reason it can relay.
    const detail = (await res.text()).slice(0, 300);
    console.error(`[schedule_highlevel] HighLevel ${res.status}:`, detail);
    if (res.status >= 500) throw new UnknownOutcomeError(UNKNOWN_BOOKING);
    if (SLOT_TAKEN.test(detail)) return slotTaken();
    // Credentials, the calendar or the request itself: a person fixes it.
    await noteForTeam(
      supabase,
      ctx,
      "hl_appointment_failed",
      `HighLevel rechazó agendar la cita del ${startTime} (error ${res.status}). Revisa la integración.`,
    );
    return {
      ok: false,
      output: { needs_human: true },
      error: `El calendario de HighLevel respondió con un error (${res.status}); la cita NO se agendó. Dile al cliente que una persona del equipo lo revisará.`,
    };
  }

  const data = (await res.json()) as HLAppointmentResponse;
  const appointmentId = data.id ?? data.appointment?.id ?? null;

  const { error: insertError } = await supabase.from("appointments").insert({
    workspace_id: ctx.workspaceId,
    contact_id: dbContactId,
    conversation_id: ctx.conversationId,
    scheduled_at: new Date(start.ms).toISOString(),
    status: "booked",
    hl_appointment_id: appointmentId,
  });
  if (insertError) {
    // The booking already exists in HighLevel and can't be undone by this
    // failure alone — don't error out to the user over a cita that actually
    // did get booked. But do surface it visibly (not just console.warn):
    // without the local row, a workspace with no calendar configured can't
    // find it to cancel or reschedule (with one, HighLevel is asked).
    console.warn(
      "[schedule_highlevel] failed to persist appointment:",
      insertError,
    );
    await supabase.from("events").insert({
      type: "appointment_persist_failed",
      level: "error",
      workspace_id: ctx.workspaceId,
      conversation_id: ctx.conversationId,
      payload: {
        provider: "highlevel",
        hl_appointment_id: appointmentId,
        contact_id: dbContactId,
        scheduled_at: new Date(start.ms).toISOString(),
        error: insertError.message,
      },
    });
  }

  return {
    ok: true,
    output: {
      appointment_id: appointmentId,
      datetime: startTime,
    },
  };
}

export const scheduleHighLevelTool: Tool<Args> = {
  name: "schedule_highlevel",
  description:
    "Reserva una cita directamente en el calendario de HighLevel. Úsalo cuando el cliente confirme una fecha y hora específicas. Llama primero a check_availability para ofrecer horarios reales.",
  sensitivity: "write",
  schema,
  enabledFor: () => true,
  run,
  // Contact upsert + booking, each bounded, inside the registry's budget.
  preferredTimeoutMs: APPOINTMENT_TOOL_TIMEOUT_MS,
};
