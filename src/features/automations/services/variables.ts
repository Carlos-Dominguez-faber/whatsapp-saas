/**
 * Resolución de las `variables` de una acción send_template.
 *
 * Cada ítem de `action_config.variables` es texto literal o uno de los cinco
 * marcadores fijos. Un marcador desconocido NO es un error: se manda tal cual,
 * porque es indistinguible de un texto que el operador quiso poner entre
 * llaves. Un marcador CONOCIDO sin dato detrás se resuelve a "" — nunca se le
 * muestra `{{contact.name}}` a un cliente por WhatsApp.
 *
 * `{{appointment.date}}` y `{{appointment.time}}` resuelven en la zona horaria del workspace (`resolveWorkspaceTimezone`) y en
 * español natural ("martes 9 de septiembre" / "15:00"). Solo se cargan cuando
 * el caller pasa `appointmentId` — el ejecutor solo lo hace para runs de
 * `appointment_upcoming` — así que los demás disparadores no pagan una
 * consulta que no necesitan y siguen resolviendo esos dos marcadores a `null`
 * (→ "" en `resolveVariables`).
 */

import { createClient as createSbClient } from "@supabase/supabase-js";
import { resolveWorkspaceTimezone } from "../lib/workspace-timezone";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export interface VariableContext {
  contactName: string | null;
  contactPhone: string | null;
  /**
   * `business_info.structured.name`, y NADA más. `null` significa "el workspace
   * no completó Ajustes → Negocio", y el ejecutor lo trata como error de
   * configuración (`missing_business_name`).
   *
   * No hay respaldo a `workspaces.name` a propósito: ese es el nombre INTERNO
   * de la cuenta (a menudo algo como "Cliente 3 - prueba"). Mandárselo
   * a un cliente final por WhatsApp es una fuga de nomenclatura interna, no un
   * modo degradado aceptable.
   */
  businessName: string | null;
  /**
   * Cita del run. `null` cuando el caller no pasó `appointmentId`
   * (disparador sin cita) o cuando la fila ya no se pudo leer o formatear
   * (cita borrada, cross-workspace, `scheduled_at` inválida). El ejecutor
   * trata ese `null` como "no se puede armar el recordatorio": cierra el run
   * en vez de mandar la plantilla con la fecha vacía.
   *
   * `status` es el valor crudo de `appointments.status` — el guard de
   * "¿sigue booked/confirmed justo antes de enviar?" vive en el ejecutor, acá
   * solo se entrega el dato.
   */
  appointment: { status: string; date: string; time: string } | null;
}

/**
 * Un error de lectura NO es "no configurado". Distinguirlos es lo que impide
 * que una base caída termine mandando una plantilla con datos equivocados: el
 * ejecutor reintenta con `ok: false` y falla con `missing_business_name` cuando
 * `ok: true` pero el nombre no está.
 */
export type VariableContextResult =
  | { ok: true; ctx: VariableContext }
  | { ok: false; error: string };

/** Los marcadores conocidos. Cualquier otro string sale idéntico. */
export function resolveVariables(
  variables: string[],
  ctx: VariableContext,
): string[] {
  return variables.map((raw) => {
    switch (raw) {
      case "{{contact.name}}":
        return ctx.contactName ?? "";
      case "{{contact.phone}}":
        return ctx.contactPhone ?? "";
      case "{{business.name}}":
        // El ejecutor no llega acá sin nombre (falla antes con
        // missing_business_name); el ?? "" es el cinturón, nunca el respaldo.
        return ctx.businessName ?? "";
      case "{{appointment.date}}":
        return ctx.appointment?.date ?? "";
      case "{{appointment.time}}":
        return ctx.appointment?.time ?? "";
      default:
        return raw;
    }
  });
}

/**
 * "martes 9 de septiembre" — sin coma. `formatToParts` (no una plantilla de `format()`) porque el orden y
 * la puntuación de "weekday, day de month" en `es-CL` no son estables entre
 * runtimes de Node.
 */
function formatAppointmentDate(iso: string, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("es-CL", {
      timeZone: tz,
      weekday: "long",
      day: "numeric",
      month: "long",
    }).formatToParts(new Date(iso));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const weekday = get("weekday");
    const day = get("day");
    const month = get("month");
    if (!weekday || !day || !month) return "";
    return `${weekday} ${day} de ${month}`;
  } catch {
    // scheduled_at inválida o Intl no pudo formatear: el caller lo trata
    // igual que "cita ausente", nunca manda "" en el WhatsApp.
    return "";
  }
}

/** "15:00" — 24 horas, sin AM/PM, para un cliente final chileno. */
function formatAppointmentTime(iso: string, tz: string): string {
  try {
    const value = new Intl.DateTimeFormat("es-CL", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(iso));
    // "24:00" es la forma en que algunas builds de ICU escriben medianoche
    // con hour12:false; "00:00" es la hora real.
    return value === "24:00" ? "00:00" : value;
  } catch {
    return "";
  }
}

/**
 * Shape exacto que espera `dispatchTemplate` → `sendTemplate`: array PLANO de
 * { type: "text", text } dentro de un único componente de body.
 */
export function buildTemplateComponents(
  values: string[],
):
  | Array<{ type: "body"; parameters: Array<{ type: "text"; text: string }> }>
  | undefined {
  if (values.length === 0) return undefined;
  return [
    {
      type: "body",
      parameters: values.map((text) => ({ type: "text" as const, text })),
    },
  ];
}

/**
 * Carga de una vez todo lo que los marcadores pueden necesitar.
 *
 * Dos lecturas, y el error de CUALQUIERA corta con `ok: false`. Antes las dos
 * descartaban su `error` y devolvían `null`, que es exactamente lo mismo que
 * devuelve "no está configurado": con la base caída se mandaba la plantilla
 * igual, con el respaldo equivocado adentro.
 */
export async function loadVariableContext(params: {
  workspaceId: string;
  contactId: string | null;
  /**
   * `appointments.id` (= `automation_events.subject_id` del evento que
   * originó el run). Solo lo pasa el ejecutor para runs de
   * `appointment_upcoming`; ausente o `null` ⇒ no se consulta `appointments`
   * ni `integrations` (zona horaria), y `ctx.appointment` sale `null`.
   */
  appointmentId?: string | null;
}): Promise<VariableContextResult> {
  const supabase = svc();

  const [contactRes, businessRes, appointmentRes] = await Promise.all([
    params.contactId
      ? supabase
          .from("contacts")
          .select("name, phone")
          .eq("id", params.contactId)
          .eq("workspace_id", params.workspaceId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    // {{business.name}} sale SOLO de lo que el cliente configuró en Ajustes →
    // Negocio. workspaces.name no se consulta ni de respaldo: es el nombre
    // interno de la cuenta.
    supabase
      .from("business_info")
      .select("structured")
      .eq("workspace_id", params.workspaceId)
      .maybeSingle(),
    params.appointmentId
      ? supabase
          .from("appointments")
          .select("status, scheduled_at")
          .eq("id", params.appointmentId)
          .eq("workspace_id", params.workspaceId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (contactRes.error) {
    console.error(
      "[automations] no pude leer el contacto para las variables:",
      contactRes.error.message,
    );
    return { ok: false, error: "no pude leer el contacto" };
  }
  if (businessRes.error) {
    console.error(
      "[automations] no pude leer business_info:",
      businessRes.error.message,
    );
    return { ok: false, error: "no pude leer los datos del negocio" };
  }
  if (appointmentRes.error) {
    console.error(
      "[automations] no pude leer la cita para las variables:",
      appointmentRes.error.message,
    );
    return { ok: false, error: "no pude leer la cita" };
  }

  const contact = contactRes.data as
    | { name: string | null; phone: string }
    | null;
  const structured = (
    businessRes.data as { structured?: Record<string, unknown> } | null
  )?.structured;
  const configuredName =
    typeof structured?.name === "string" && structured.name.trim()
      ? structured.name.trim()
      : null;

  let appointment: VariableContext["appointment"] = null;
  const appointmentRow = appointmentRes.data as
    | { status: string; scheduled_at: string }
    | null;
  if (params.appointmentId && appointmentRow) {
    const tz = await resolveWorkspaceTimezone(supabase, params.workspaceId);
    // `null` significa "no sé la zona con certeza" (config inválida o lectura
    // caída), y acá NO se degrada a UTC — el `?? "UTC"` está prohibido por
    // contrato. Una hora corrida en el WhatsApp hace que el cliente llegue
    // tarde por culpa nuestra; sin cita resuelta el run cierra
    // `missing_appointment` y no despacha, que es el resultado correcto.
    if (tz !== null) {
      const date = formatAppointmentDate(appointmentRow.scheduled_at, tz);
      const time = formatAppointmentTime(appointmentRow.scheduled_at, tz);
      // Si el formateo falla (fecha inválida en la fila) `appointment` queda
      // `null`: el ejecutor lo trata igual que "cita ausente", nunca manda la
      // plantilla con la fecha vacía.
      if (date && time) {
        appointment = { status: appointmentRow.status, date, time };
      }
    }
  }

  return {
    ok: true,
    ctx: {
      contactName: contact?.name ?? null,
      contactPhone: contact?.phone ?? null,
      businessName: configuredName,
      appointment,
    },
  };
}
