import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

let businessInfoRow: { structured: Record<string, unknown> } | null = null;
let contactRow: { name: string | null; phone: string } | null = null;
let appointmentRow: { status: string; scheduled_at: string } | null = null;
/** `integrations` para `resolveWorkspaceTimezone` — vacío ⇒ default UTC. */
let integrationsRows: Array<{ provider: string; config: unknown }> = [];
let errorTables: string[] = [];
/** Toda tabla que se consulte queda registrada: `workspaces` NO debe aparecer. */
const queriedTables: string[] = [];

const fakeClient = {
  from(table: string) {
    queriedTables.push(table);
    return {
      select() {
        const chain: any = {
          eq: () => chain,
          in: async () => {
            if (errorTables.includes(table)) {
              return { data: null, error: { message: "connection refused" } };
            }
            return { data: integrationsRows, error: null };
          },
          maybeSingle: async () => {
            if (errorTables.includes(table)) {
              return { data: null, error: { message: "connection refused" } };
            }
            if (table === "business_info") return { data: businessInfoRow, error: null };
            if (table === "contacts") return { data: contactRow, error: null };
            if (table === "appointments") return { data: appointmentRow, error: null };
            return { data: null, error: null };
          },
        };
        return chain;
      },
    };
  },
};
mock.module("@supabase/supabase-js", {
  exports: { createClient: () => fakeClient },
});

const { resolveVariables, buildTemplateComponents, loadVariableContext } =
  await import("./variables.ts");

const ctx = {
  contactName: "María Pérez",
  contactPhone: "+15550000002",
  businessName: "Veterinaria Demo",
  appointment: null,
};

// ── Camino correcto ──────────────────────────────────────────────────────────

test("resuelve los 3 marcadores de contacto y negocio", () => {
  assert.deepEqual(
    resolveVariables(
      ["{{contact.name}}", "{{contact.phone}}", "{{business.name}}"],
      ctx,
    ),
    ["María Pérez", "+15550000002", "Veterinaria Demo"],
  );
});

test("los marcadores de cita quedan vacíos sin appointment en el contexto, nunca crudos", () => {
  assert.deepEqual(
    resolveVariables(["{{appointment.date}}", "{{appointment.time}}"], ctx),
    ["", ""],
  );
});

test("con appointment en el contexto, los marcadores de cita resuelven la fecha y hora", () => {
  assert.deepEqual(
    resolveVariables(["{{appointment.date}}", "{{appointment.time}}"], {
      ...ctx,
      appointment: {
        status: "confirmed",
        date: "martes 9 de septiembre",
        time: "15:00",
      },
    }),
    ["martes 9 de septiembre", "15:00"],
  );
});

test("un texto que no es marcador pasa literal", () => {
  assert.deepEqual(resolveVariables(["Hola", "{{ojo.raro}}", ""], ctx), [
    "Hola",
    "{{ojo.raro}}",
    "",
  ]);
});

test("buildTemplateComponents arma el shape plano que espera Kapso", () => {
  assert.deepEqual(buildTemplateComponents(["María Pérez", "Vet Demo"]), [
    {
      type: "body",
      parameters: [
        { type: "text", text: "María Pérez" },
        { type: "text", text: "Vet Demo" },
      ],
    },
  ]);
});

test("buildTemplateComponents devuelve undefined sin variables", () => {
  assert.equal(buildTemplateComponents([]), undefined);
});

test("businessName usa el nombre configurado en Ajustes → Negocio", async () => {
  businessInfoRow = { structured: { name: "Veterinaria Demo" } };
  contactRow = { name: "María", phone: "+15550000001" };
  errorTables = [];
  queriedTables.length = 0;
  const loaded = await loadVariableContext({
    workspaceId: "ws_1",
    contactId: "contact_1",
  });
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.ok && loaded.ctx, {
    contactName: "María",
    contactPhone: "+15550000001",
    businessName: "Veterinaria Demo",
    appointment: null,
  });
  assert.equal(
    queriedTables.includes("workspaces"),
    false,
    "workspaces.name es el nombre INTERNO de la cuenta: no se lee ni de respaldo",
  );
});

// ── {{appointment.date}} / {{appointment.time}} ─────────────────────────────

test("sin appointmentId no se consulta 'appointments' ni 'integrations' (otros disparadores)", async () => {
  businessInfoRow = { structured: { name: "Veterinaria Demo" } };
  contactRow = { name: "María", phone: "+15550000001" };
  errorTables = [];
  queriedTables.length = 0;
  const loaded = await loadVariableContext({
    workspaceId: "ws_1",
    contactId: "contact_1",
  });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.ok && loaded.ctx.appointment, null);
  assert.equal(queriedTables.includes("appointments"), false);
  assert.equal(queriedTables.includes("integrations"), false);
});

test("con appointmentId y cita legible, la fecha y hora salen formateadas en la zona del workspace", async () => {
  businessInfoRow = { structured: { name: "Veterinaria Demo" } };
  contactRow = { name: "María", phone: "+15550000001" };
  // 2026-09-08T23:00:00Z = martes 8 de septiembre 20:00 en America/Santiago.
  appointmentRow = { status: "confirmed", scheduled_at: "2026-09-08T23:00:00.000Z" };
  integrationsRows = [
    { provider: "highlevel", config: { timezone: "America/Santiago" } },
  ];
  errorTables = [];

  const loaded = await loadVariableContext({
    workspaceId: "ws_1",
    contactId: "contact_1",
    appointmentId: "appt_1",
  });
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.ok && loaded.ctx.appointment, {
    status: "confirmed",
    date: "martes 8 de septiembre",
    time: "20:00",
  });
});

test("con una zona horaria inválida NO se formatea en UTC: appointment queda null y el run no despacha", async () => {
  businessInfoRow = { structured: { name: "Veterinaria Demo" } };
  contactRow = { name: "María", phone: "+15550000001" };
  appointmentRow = { status: "confirmed", scheduled_at: "2026-09-08T23:00:00.000Z" };
  // "Santiago" en vez de "America/Santiago": zona escrita pero inválida, así
  // que `resolveWorkspaceTimezone` devuelve null. Degradar a UTC formatearía
  // "miércoles 9 de septiembre, 23:00" para una cita que es el martes a las
  // 20:00 — el cliente llegaría un día tarde por culpa nuestra. Sin cita
  // resuelta el ejecutor cierra `missing_appointment` y no manda nada.
  integrationsRows = [{ provider: "highlevel", config: { timezone: "Santiago" } }];
  errorTables = [];

  const loaded = await loadVariableContext({
    workspaceId: "ws_1",
    contactId: "contact_1",
    appointmentId: "appt_1",
  });
  assert.equal(loaded.ok, true);
  assert.equal(
    loaded.ok && loaded.ctx.appointment,
    null,
    "el ?? \"UTC\" está prohibido por contrato: sin zona confiable no se resuelve la cita",
  );
});

test("con appointmentId pero la cita no existe (borrada o cross-workspace), appointment queda null", async () => {
  businessInfoRow = { structured: { name: "Veterinaria Demo" } };
  contactRow = { name: "María", phone: "+15550000001" };
  appointmentRow = null;
  errorTables = [];

  const loaded = await loadVariableContext({
    workspaceId: "ws_1",
    contactId: "contact_1",
    appointmentId: "appt_borrada",
  });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.ok && loaded.ctx.appointment, null);
});

test("un error leyendo 'appointments' devuelve ok:false para que el run reintente", async () => {
  businessInfoRow = { structured: { name: "Veterinaria Demo" } };
  contactRow = { name: "María", phone: "+15550000001" };
  appointmentRow = { status: "confirmed", scheduled_at: "2026-09-08T23:00:00.000Z" };
  errorTables = ["appointments"];

  const loaded = await loadVariableContext({
    workspaceId: "ws_1",
    contactId: "contact_1",
    appointmentId: "appt_1",
  });
  assert.equal(loaded.ok, false);
});

// ── Caminos de error ─────────────────────────────────────────────────────────

test("un contacto sin nombre no deja el marcador crudo en el mensaje", () => {
  assert.deepEqual(
    resolveVariables(["{{contact.name}}"], { ...ctx, contactName: null }),
    [""],
  );
});

test("sin business_info, businessName queda null: NUNCA cae al nombre del workspace", async () => {
  businessInfoRow = null;
  contactRow = null;
  errorTables = [];
  queriedTables.length = 0;
  const loaded = await loadVariableContext({
    workspaceId: "ws_1",
    contactId: null,
  });
  assert.equal(loaded.ok, true);
  assert.equal(
    loaded.ok && loaded.ctx.businessName,
    null,
    "'Cliente 3 - prueba' no puede llegarle a un cliente por WhatsApp",
  );
  assert.equal(loaded.ok && loaded.ctx.contactName, null);
  assert.equal(queriedTables.includes("workspaces"), false);
});

test("un name en blanco en business_info cuenta como ausente", async () => {
  businessInfoRow = { structured: { name: "   " } };
  errorTables = [];
  const loaded = await loadVariableContext({
    workspaceId: "ws_1",
    contactId: null,
  });
  assert.equal(loaded.ok && loaded.ctx.businessName, null);
});

test("un error de lectura NO se traga: devuelve ok:false para que el run reintente", async () => {
  for (const table of ["business_info", "contacts"]) {
    businessInfoRow = { structured: { name: "Veterinaria Demo" } };
    contactRow = { name: "María", phone: "+15550000001" };
    errorTables = [table];
    const loaded = await loadVariableContext({
      workspaceId: "ws_1",
      contactId: "contact_1",
    });
    assert.equal(
      loaded.ok,
      false,
      `${table} caído se confundía con "no configurado" y se enviaba igual`,
    );
  }
});
