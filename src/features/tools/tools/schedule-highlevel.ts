import { createClient as createSbClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../core/tool";

const schema = z.object({
  datetime_iso: z
    .string()
    .describe(
      "Inicio de la cita en ISO 8601 con zona horaria, ej: 2026-06-12T10:00:00-06:00",
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
      "Teléfono del contacto en E.164 (ej: +5215512345678). Úsalo cuando el contacto no venga del chat (p. ej. en el playground de prueba).",
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

async function run(args: Args, ctx: ToolContext): Promise<ToolResult> {
  const { getHLConfig, upsertHLContactByPhone, linkHLContact } =
    await import("../../inbox/services/highlevel-client");

  const cfg = await getHLConfig(ctx.workspaceId);
  if (!cfg) {
    return {
      ok: false,
      output: null,
      error: "HighLevel no está conectado para este workspace",
    };
  }

  const calendarId = args.calendar_id ?? cfg.calendarId;
  if (!calendarId) {
    return {
      ok: false,
      output: null,
      error: "No hay un calendario de HighLevel configurado",
    };
  }

  const supabase = createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // Resolve the contact: prefer an explicit phone arg (playground / when the
  // contact isn't synced), otherwise read the chat's contact from the DB.
  let phone = args.contact_phone ?? null;
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

  const res = await fetch(
    "https://services.leadconnectorhq.com/calendars/events/appointments",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Version: "2021-07-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        calendarId,
        locationId: cfg.locationId,
        contactId: hlContactId,
        startTime: args.datetime_iso,
        title: `Cita${args.contact_name ? ` — ${args.contact_name}` : ""}`,
      }),
    },
  );

  if (!res.ok) {
    // The raw body is HighLevel's own wording (English, internal ids): log
    // it, but give the model a plain reason it can relay.
    console.error(
      `[schedule_highlevel] HighLevel ${res.status}:`,
      (await res.text()).slice(0, 300),
    );
    return {
      ok: false,
      output: null,
      error: `El calendario de HighLevel respondió con un error (${res.status}); no se pudo agendar la cita. Dile al cliente que lo revisarás o pásalo a una persona.`,
    };
  }

  const data = (await res.json()) as HLAppointmentResponse;
  return {
    ok: true,
    output: {
      appointment_id: data.id ?? data.appointment?.id,
      datetime: args.datetime_iso,
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
};
