import { createClient as createSbClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult, ToolRunOptions } from "../core/tool";
import { resolveCalendarId } from "../lib/calendar-id.ts";
import { formatWithOffset } from "@/shared/lib/timezone";
import {
  APPOINTMENT_TOOL_TIMEOUT_MS,
  confirmedInstantError,
  hasTimeToLookUp,
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
      "Solo en el chat de prueba: el teléfono de prueba tal como el usuario lo escribió en el chat. En una conversación real se agenda al contacto del chat y esto se ignora.",
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

/**
 * How recent the contact's own booking at that time must be to be this
 * tool's earlier call, whose answer was lost: older, it's one they already
 * had (a parent booking for a child), and no new one was made.
 */
const OWN_RETRY_WINDOW_MS = 10 * 60_000;

/** Digit runs that look like a phone number, as typed in a chat message. */
const PHONE_LIKE = /\+?\d[\d\s().-]{6,}\d/g;

/**
 * The playground has no contact: it books on a phone the tester typed in
 * this conversation, never one the model came up with (a real person's
 * number would get a real appointment and HighLevel's confirmations). Both
 * are read as a person writes them (placePhone, with the workspace's
 * country: "1 55 1234 5678" is a Mexican mobile, not a US number) and must
 * be the same line. Returns the TYPED number's E.164, or null.
 */
function phoneTypedByTester(
  phone: string,
  userMessages: string[],
  countryCode: string,
  phones: {
    placePhone: (p: string, cc?: string) => { e164: string } | null;
    samePhone: (a: string, b: string, cc?: string) => boolean;
  },
): string | null {
  const wanted = phones.placePhone(phone, countryCode);
  if (!wanted) return null;
  for (const message of userMessages) {
    for (const typed of message.match(PHONE_LIKE) ?? []) {
      const placed = phones.placePhone(typed, countryCode);
      if (placed && phones.samePhone(placed.e164, wanted.e164)) return placed.e164;
    }
  }
  return null;
}

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
  // contact. Only the playground, which has none, books on a phone passed
  // here — and only one the tester typed in this conversation.
  let phone: string | null = null;
  let name = args.contact_name ?? null;
  const playground = !ctx.contactId ? ctx.playground : undefined;
  let traceId: string | null = null;
  if (playground) {
    const { placePhone, samePhone } = await import("../../inbox/services/phone.ts");
    const { workspaceCountryCode } = await import("../../inbox/services/country-code.ts");
    const typed = args.contact_phone
      ? phoneTypedByTester(
          args.contact_phone,
          playground.userMessages,
          await workspaceCountryCode(supabase, ctx.workspaceId),
          { placePhone, samePhone },
        )
      : null;
    if (!typed) {
      return {
        ok: false,
        output: null,
        error: "Para probar el agendado, escribe en el chat el teléfono de prueba.",
      };
    }
    // The number as the tester wrote it, never the model's version of it.
    phone = typed;
    // An existing HighLevel contact on that number keeps its name.
    name = null;

    // A real appointment from the playground leaves who, what and where
    // before anything is written in HighLevel; without that trace, nothing is.
    const { data: trace, error: traceError } = await supabase
      .from("events")
      .insert({
        type: "playground_write",
        level: "warn",
        workspace_id: ctx.workspaceId,
        payload: {
          user_id: playground.userId,
          tool: "schedule_highlevel",
          phone,
          start_time: startTime,
          calendar_id: calendarId,
          outcome: "attempted",
        },
      })
      .select("id")
      .single();
    if (traceError || !trace) {
      console.error("[schedule_highlevel] playground trace failed:", traceError?.message);
      return {
        ok: false,
        output: null,
        error: "No pude registrar la prueba, así que la cita NO se agendó. Inténtalo de nuevo.",
      };
    }
    traceId = (trace as { id: string }).id;
  }
  /** The playground trace's outcome. Never throws. */
  const traceOutcome = async (outcome: string, extra: Record<string, unknown> = {}) => {
    if (!traceId || !playground) return;
    const { error } = await supabase
      .from("events")
      .update({
        payload: {
          user_id: playground.userId,
          tool: "schedule_highlevel",
          phone,
          start_time: startTime,
          calendar_id: calendarId,
          outcome,
          ...extra,
        },
      })
      .eq("id", traceId)
      .eq("workspace_id", ctx.workspaceId);
    if (error) console.warn("[schedule_highlevel] playground trace outcome failed:", error.message);
  };
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
    hlContactId = await upsertHLContactByPhone(cfg, playground ? { phone } : { name, phone });
    if (hlContactId && dbContactId) {
      // A conflict (another local contact already holds this HighLevel id) is
      // logged and evented by linkHLContact; the booking still goes ahead.
      await linkHLContact(supabase, ctx.workspaceId, dbContactId, hlContactId);
    }
  }

  if (!hlContactId) {
    await traceOutcome("not_sent", { reason: "contact_upsert_failed" });
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
    // Without a contact, or the time to ask, "not booked" is still true.
    if (!dbContactId || !hasTimeToLookUp(startedAt, budgetMs)) return other;
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
      const { appointment } = located;
      const datetime = formatWithOffset(appointment.startMs, zone);
      const age = appointment.addedMs === null ? null : Date.now() - appointment.addedMs;
      // A minute of clock skew either way.
      if (age !== null && age >= -60_000 && age <= OWN_RETRY_WINDOW_MS) {
        return {
          ok: true,
          output: { appointment_id: appointment.id, datetime, already_booked: true },
        };
      }
      return {
        ok: false,
        output: { existing_appointment: datetime },
        error: "El cliente ya tenía una cita a esa hora, así que no se creó otra. Confírmale que esa sigue en pie o, si quería otra cita, ofrécele otro horario.",
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
    await traceOutcome("not_sent", { reason: "no_time" });
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
        title: `${playground ? "[Prueba] " : ""}Cita${args.contact_name ? ` — ${args.contact_name}` : ""}`,
      }),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
  } catch (err) {
    // Sent, and no answer: the booking may exist.
    console.error("[schedule_highlevel] booking got no answer:", err);
    await traceOutcome("unknown");
    throw new UnknownOutcomeError(UNKNOWN_BOOKING);
  }

  if (!res.ok) {
    // The raw body is HighLevel's own wording (English, internal ids): log
    // it, but give the model a plain reason it can relay.
    const detail = (await res.text()).slice(0, 300);
    console.error(`[schedule_highlevel] HighLevel ${res.status}:`, detail);
    if (res.status >= 500) {
      await traceOutcome("unknown", { status: res.status });
      throw new UnknownOutcomeError(UNKNOWN_BOOKING);
    }
    await traceOutcome("refused", { status: res.status });
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

  // Booked: whatever happens next, the answer is success.
  let appointmentId: string | null = null;
  try {
    const data = (await res.json()) as HLAppointmentResponse;
    appointmentId = data.id ?? data.appointment?.id ?? null;
  } catch (err) {
    console.error("[schedule_highlevel] booked, but the answer couldn't be read:", err);
  }
  if (!appointmentId) {
    await noteForTeam(
      supabase,
      ctx,
      "hl_appointment_unconfirmed",
      `HighLevel agendó la cita del ${startTime} pero no devolvió su id. Revisa que esté en el calendario.`,
    );
  }

  // One local row per HighLevel appointment: an earlier read may have
  // written it already.
  const row = {
    workspace_id: ctx.workspaceId,
    contact_id: dbContactId,
    // The playground has no conversation.
    conversation_id: ctx.conversationId || null,
    scheduled_at: new Date(start.ms).toISOString(),
    status: "booked",
    hl_appointment_id: appointmentId,
  };
  const { error: insertError } = appointmentId
    ? await supabase.from("appointments").upsert(row, { onConflict: "workspace_id,hl_appointment_id" })
    : await supabase.from("appointments").insert(row);
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
      conversation_id: ctx.conversationId || null,
      payload: {
        provider: "highlevel",
        hl_appointment_id: appointmentId,
        contact_id: dbContactId,
        scheduled_at: new Date(start.ms).toISOString(),
        error: insertError.message,
      },
    });
  }

  await traceOutcome("booked", { appointment_id: appointmentId });
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
