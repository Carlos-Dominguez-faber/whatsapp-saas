import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AutomationRuleInputSchema,
  AutomationRuleUpdateSchema,
  TRIGGER_TYPES,
  EXECUTABLE_TRIGGER_TYPES,
  ACTION_TYPES,
  firstErrorMessage,
  type ExecutableTriggerType,
  type ActionType,
} from "./rule-schema.ts";

const UUID = "3f9a1c2e-1111-4a2b-9c3d-4e5f60718293";

function base(extra: Record<string, unknown>) {
  return { name: "Regla", enabled: true, ...extra };
}

// ── Camino correcto ──────────────────────────────────────────────────────────

test("distingue los 6 disparadores ALMACENABLES de los 4 EJECUTABLES", () => {
  assert.deepEqual(
    [...TRIGGER_TYPES],
    [
      "first_message",
      "inactivity_24h",
      "window_closing",
      "handoff_requested",
      "lead_qualified",
      "keyword_match",
      "appointment_upcoming",
    ],
    "los CHECK de automation_rules solo se amplían con migración: hay filas legacy",
  );
  assert.deepEqual(
    [...EXECUTABLE_TRIGGER_TYPES],
    [
      "first_message",
      "keyword_match",
      "handoff_requested",
      "lead_qualified",
      "appointment_upcoming",
    ],
    "inactivity_24h y window_closing siguen sin barrido, así que no se pueden crear",
  );
  assert.deepEqual(
    [...ACTION_TYPES],
    [
      "send_template",
      "assign_agent",
      "add_tag",
      "close_conversation",
      "handoff_human",
    ],
  );
});

test("una regla válida conserva TODOS los campos (base + trigger + action)", () => {
  const parsed = AutomationRuleInputSchema.safeParse(
    base({
      trigger_type: "keyword_match",
      trigger_config: { keywords: ["precio", "  cotización  "] },
      action_type: "add_tag",
      action_config: { tag: " interesado " },
    }),
  );
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.deepEqual(parsed.data, {
    name: "Regla",
    enabled: true,
    trigger_type: "keyword_match",
    trigger_config: { keywords: ["precio", "cotización"] },
    action_type: "add_tag",
    action_config: { tag: "interesado" },
  });
});

test("acepta variables de plantilla, incluida una desconocida como literal", () => {
  const parsed = AutomationRuleInputSchema.parse(
    base({
      trigger_type: "first_message",
      trigger_config: {},
      action_type: "send_template",
      action_config: {
        template_name: "bienvenida",
        variables: ["{{contact.name}}", "{{no.existe}}", "texto suelto"],
      },
    }),
  );
  // Se compara el `action_config` entero y no solo `.variables`: el tipo
  // inferido es una unión por `action_type` y `.variables` no existe en todas
  // las ramas, así que acceder al campo suelto no compila.
  assert.deepEqual(parsed.action_config, {
    template_name: "bienvenida",
    variables: ["{{contact.name}}", "{{no.existe}}", "texto suelto"],
  });
});

test("acepta un user_id uuid en assign_agent", () => {
  const parsed = AutomationRuleInputSchema.safeParse(
    base({
      trigger_type: "first_message",
      trigger_config: {},
      action_type: "assign_agent",
      action_config: { user_id: UUID },
    }),
  );
  assert.ok(parsed.success);
});

test("AutomationRuleUpdateSchema exige el id", () => {
  const sinId = AutomationRuleUpdateSchema.safeParse(
    base({
      trigger_type: "first_message",
      trigger_config: {},
      action_type: "handoff_human",
      action_config: {},
    }),
  );
  assert.equal(sinId.success, false);

  const conId = AutomationRuleUpdateSchema.safeParse(
    base({
      id: UUID,
      trigger_type: "first_message",
      trigger_config: {},
      action_type: "handoff_human",
      action_config: {},
    }),
  );
  assert.ok(conId.success);
});

// ── Caminos de error ─────────────────────────────────────────────────────────

test("rechaza los disparadores por tiempo que no tienen ejecutor", () => {
  for (const triggerType of ["inactivity_24h", "window_closing"]) {
    const parsed = AutomationRuleInputSchema.safeParse(
      base({
        trigger_type: triggerType,
        trigger_config: { hours: 24 },
        action_type: "handoff_human",
        action_config: {},
      }),
    );
    assert.equal(
      parsed.success,
      false,
      `${triggerType} se pudo crear y nunca correría`,
    );
    assert.equal(
      firstErrorMessage(parsed.error!),
      "Ese disparador todavía no está disponible",
    );
  }
});

test("rechaza un user_id que no es uuid en assign_agent", () => {
  const parsed = AutomationRuleInputSchema.safeParse(
    base({
      trigger_type: "first_message",
      trigger_config: {},
      action_type: "assign_agent",
      action_config: { user_id: "yo-mismo" },
    }),
  );
  assert.equal(parsed.success, false);
  assert.equal(firstErrorMessage(parsed.error!), "Elige un miembro del equipo");
});

test("rechaza keyword_match sin palabras clave", () => {
  const parsed = AutomationRuleInputSchema.safeParse(
    base({
      trigger_type: "keyword_match",
      trigger_config: { keywords: [] },
      action_type: "handoff_human",
      action_config: {},
    }),
  );
  assert.equal(parsed.success, false);
  assert.equal(
    firstErrorMessage(parsed.error!),
    "Agrega al menos una palabra clave",
  );
});

test("rechaza palabras clave vacías o de solo espacios", () => {
  // `"lo que sea".includes("")` es true: una keyword vacía dispara con CADA
  // mensaje entrante.
  for (const keywords of [[""], ["   "], ["precio", ""]]) {
    const parsed = AutomationRuleInputSchema.safeParse(
      base({
        trigger_type: "keyword_match",
        trigger_config: { keywords },
        action_type: "handoff_human",
        action_config: {},
      }),
    );
    assert.equal(
      parsed.success,
      false,
      `${JSON.stringify(keywords)} matchearía todos los mensajes`,
    );
  }
});

test("appointment_upcoming acepta la anticipación y aplica los defaults de la ventana", () => {
  const parsed = AutomationRuleInputSchema.safeParse(
    base({
      trigger_type: "appointment_upcoming",
      trigger_config: { hours_before: 24 },
      action_type: "send_template",
      action_config: { template_name: "recordatorio_cita_24h" },
    }),
  );
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  // Sin ventana explícita, 8–22. Un default distinto manda recordatorios
  // de madrugada sin que nadie lo haya pedido.
  assert.deepEqual(parsed.data!.trigger_config, {
    hours_before: 24,
    quiet_start: 8,
    quiet_end: 22,
  });
});

test("rechaza una anticipación que no sea un entero de 1 a 168", () => {
  for (const hours_before of ["24", 0, 169, 2.5, -1, undefined, null]) {
    const parsed = AutomationRuleInputSchema.safeParse(
      base({
        trigger_type: "appointment_upcoming",
        trigger_config: { hours_before },
        action_type: "send_template",
        action_config: { template_name: "recordatorio_cita_24h" },
      }),
    );
    assert.equal(
      parsed.success,
      false,
      `hours_before=${JSON.stringify(hours_before)} tendría que rechazarse`,
    );
    assert.match(firstErrorMessage(parsed.error!), /anticipación/i);
  }
});

test("rechaza una ventana horaria fuera de 0–23", () => {
  for (const quiet of [{ quiet_start: 24 }, { quiet_end: -1 }, { quiet_start: 9.5 }]) {
    const parsed = AutomationRuleInputSchema.safeParse(
      base({
        trigger_type: "appointment_upcoming",
        trigger_config: { hours_before: 2, ...quiet },
        action_type: "send_template",
        action_config: { template_name: "recordatorio_cita_2h" },
      }),
    );
    assert.equal(
      parsed.success,
      false,
      `${JSON.stringify(quiet)} tendría que rechazarse`,
    );
  }
});

test("acepta la ventana horaria por defecto y una 8/22 explícita", () => {
  for (const quiet of [{}, { quiet_start: 8, quiet_end: 22 }]) {
    const parsed = AutomationRuleInputSchema.safeParse(
      base({
        trigger_type: "appointment_upcoming",
        trigger_config: { hours_before: 2, ...quiet },
        action_type: "send_template",
        action_config: { template_name: "recordatorio_cita_2h" },
      }),
    );
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  }
});

test("rechaza una ventana que cruza medianoche o con inicio == fin", () => {
  // quiet_start=22/quiet_end=8 y quiet_start===quiet_end pasaban el 422 y
  // dejaban la regla en silencio total: el guard de scanTimeTriggers
  // (`hour < quietStart || hour >= quietEnd`) es falso para toda hora del día
  // en el primer caso, y una tautología en el segundo.
  for (const quiet of [
    { quiet_start: 22, quiet_end: 8 },
    { quiet_start: 8, quiet_end: 8 },
  ]) {
    const parsed = AutomationRuleInputSchema.safeParse(
      base({
        trigger_type: "appointment_upcoming",
        trigger_config: { hours_before: 2, ...quiet },
        action_type: "send_template",
        action_config: { template_name: "recordatorio_cita_2h" },
      }),
    );
    assert.equal(
      parsed.success,
      false,
      `${JSON.stringify(quiet)} tendría que rechazarse`,
    );
    assert.equal(
      firstErrorMessage(parsed.error!),
      "La hora de inicio debe ser anterior a la de término",
    );
  }
});

test("rechaza send_template sin nombre de plantilla", () => {
  const parsed = AutomationRuleInputSchema.safeParse(
    base({
      trigger_type: "first_message",
      trigger_config: {},
      action_type: "send_template",
      action_config: {},
    }),
  );
  assert.equal(parsed.success, false);
  assert.equal(firstErrorMessage(parsed.error!), "Elige una plantilla aprobada");
});

test("rechaza más de 10 variables", () => {
  const parsed = AutomationRuleInputSchema.safeParse(
    base({
      trigger_type: "first_message",
      trigger_config: {},
      action_type: "send_template",
      action_config: {
        template_name: "bienvenida",
        variables: Array.from({ length: 11 }, () => "{{contact.name}}"),
      },
    }),
  );
  assert.equal(parsed.success, false);
  assert.equal(
    firstErrorMessage(parsed.error!),
    "Máximo 10 variables por plantilla",
  );
});

test("rechaza los tipos que todavía no existen", () => {
  for (const rule of [
    base({
      trigger_type: "appointment_reminder",
      trigger_config: {},
      action_type: "add_tag",
      action_config: { tag: "x" },
    }),
    base({
      trigger_type: "first_message",
      trigger_config: {},
      action_type: "call_n8n",
      action_config: {},
    }),
  ]) {
    assert.equal(AutomationRuleInputSchema.safeParse(rule).success, false);
  }
});

// ── Arrays vs. schema: que no se puedan desalinear en silencio ──
//
// `EXECUTABLE_TRIGGER_TYPES` y `ACTION_TYPES` son arrays sueltos; las ramas de
// `AutomationRuleInputSchema` son literales escritos a mano por separado. Los
// tests de arriba comparan los arrays contra listas también escritas a mano,
// así que fijan los arrays pero no su acuerdo con el schema: se puede agregar
// un valor a un lado sin tocar el otro y el typecheck queda mudo. Estos tests
// recorren los arrays exportados y llaman al schema, así que agregar un valor
// a un lado sin el otro rompe un test (el formulario arma el selector desde
// `EXECUTABLE_TRIGGER_TYPES`: si se desalinean, la UI ofrece un disparador que
// la API rechaza, o esconde uno que sí acepta).

const TRIGGER_CONFIG_BY_TYPE: Record<ExecutableTriggerType, Record<string, unknown>> = {
  first_message: {},
  keyword_match: { keywords: ["hola"] },
  handoff_requested: {},
  lead_qualified: {},
  appointment_upcoming: { hours_before: 24 },
};

const ACTION_CONFIG_BY_TYPE: Record<ActionType, Record<string, unknown>> = {
  send_template: { template_name: "bienvenida" },
  assign_agent: { user_id: UUID },
  add_tag: { tag: "interesado" },
  close_conversation: {},
  handoff_human: {},
};

test("cada valor de EXECUTABLE_TRIGGER_TYPES tiene una rama válida en el schema", () => {
  for (const triggerType of EXECUTABLE_TRIGGER_TYPES) {
    const parsed = AutomationRuleInputSchema.safeParse(
      base({
        trigger_type: triggerType,
        trigger_config: TRIGGER_CONFIG_BY_TYPE[triggerType],
        action_type: "handoff_human",
        action_config: {},
      }),
    );
    assert.ok(
      parsed.success,
      `${triggerType} está en EXECUTABLE_TRIGGER_TYPES pero el schema lo rechaza: ${JSON.stringify(parsed.error?.issues)}`,
    );
  }
});

test("cada valor de ACTION_TYPES tiene una rama válida en el schema", () => {
  for (const actionType of ACTION_TYPES) {
    const parsed = AutomationRuleInputSchema.safeParse(
      base({
        trigger_type: "first_message",
        trigger_config: {},
        action_type: actionType,
        action_config: ACTION_CONFIG_BY_TYPE[actionType],
      }),
    );
    assert.ok(
      parsed.success,
      `${actionType} está en ACTION_TYPES pero el schema lo rechaza: ${JSON.stringify(parsed.error?.issues)}`,
    );
  }
});

test("los disparadores ALMACENABLES que no son EJECUTABLES quedan fuera del schema (derivado de los arrays, no hardcodeado)", () => {
  const noEjecutables = TRIGGER_TYPES.filter(
    (triggerType) =>
      !(EXECUTABLE_TRIGGER_TYPES as readonly string[]).includes(triggerType),
  );
  // Si esto queda vacío el test de abajo no prueba nada: hoy son
  // `inactivity_24h` y `window_closing`, pero no se hardcodean acá.
  assert.ok(noEjecutables.length > 0, "la resta de los arrays no debería quedar vacía");
  for (const triggerType of noEjecutables) {
    const parsed = AutomationRuleInputSchema.safeParse(
      base({
        trigger_type: triggerType,
        trigger_config: {},
        action_type: "handoff_human",
        action_config: {},
      }),
    );
    assert.equal(
      parsed.success,
      false,
      `${triggerType} está en TRIGGER_TYPES pero no en EXECUTABLE_TRIGGER_TYPES: el schema no debería aceptarlo`,
    );
  }
});

// ── Bordes baratos ───────────────────────────────────────────────────────────

test("enabled omitido toma el default true", () => {
  const parsed = AutomationRuleInputSchema.safeParse({
    name: "Regla",
    trigger_type: "first_message",
    trigger_config: {},
    action_type: "handoff_human",
    action_config: {},
  });
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.equal(parsed.data.enabled, true);
});

test("trigger_config con basura en un disparador sin config se acepta y se limpia (comportamiento actual, no `.strict()`)", () => {
  // `first_message` usa `z.object({})`, que no es estricto: hoy acepta
  // cualquier campo extra y lo descarta en vez de rechazar la regla. Este test
  // fija ESE comportamiento a propósito, para que un futuro cambio a
  // `.strict()` sea una decisión explícita y no un silencio.
  const parsed = AutomationRuleInputSchema.safeParse(
    base({
      trigger_type: "first_message",
      trigger_config: { hours: 24 },
      action_type: "handoff_human",
      action_config: {},
    }),
  );
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.deepEqual(parsed.data.trigger_config, {});
});

test("rechaza un nombre vacío", () => {
  const parsed = AutomationRuleInputSchema.safeParse({
    name: "   ",
    trigger_type: "first_message",
    trigger_config: {},
    action_type: "handoff_human",
    action_config: {},
  });
  assert.equal(parsed.success, false);
  assert.equal(firstErrorMessage(parsed.error!), "El nombre es obligatorio");
});
