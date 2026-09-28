/**
 * Schema único de una regla de automatización.
 *
 * Antes había dos copias casi iguales (server actions y route handler) y la
 * lógica condicional por tipo vivía solo en el cliente, así que la API aceptaba
 * cualquier `trigger_config`. Acá la validación es por combinación: una unión
 * discriminada por `trigger_type` y otra por `action_type`, intersectadas con
 * los campos base.
 *
 * Los disparadores y las acciones de abajo son exactamente los CHECK de
 * `automation_rules` (20260609000002), más `appointment_upcoming` (barrido por
 * tiempo, no evento; migración 20260908000000).
 *
 * ALMACENABLE ≠ CREABLE. `TRIGGER_TYPES` son los 7 valores que el CHECK acepta
 * y que pueden existir hoy en la base; los diccionarios exhaustivos de la UI se
 * declaran sobre ellos y tienen que seguir cubriéndolos, o una regla legacy
 * rompe el typecheck y renderiza `undefined`. `EXECUTABLE_TRIGGER_TYPES` son
 * los 5 que el motor ejecuta de verdad, y son los únicos que este schema
 * acepta: `inactivity_24h` y `window_closing` siguen sin barrido, así que
 * crear una regla de esos tipos es prometer algo que nunca corre. Las filas
 * legacy no se tocan ni se migran; simplemente nada las encola.
 */

import { z } from "zod";

/** Todo lo que el CHECK de `automation_rules` acepta (incluye filas legacy). */
export const TRIGGER_TYPES = [
  "first_message",
  "inactivity_24h",
  "window_closing",
  "handoff_requested",
  "lead_qualified",
  "keyword_match",
  "appointment_upcoming",
] as const;

/** Lo que el motor ejecuta de verdad — lo único creable desde la API y la UI. */
export const EXECUTABLE_TRIGGER_TYPES = [
  "first_message",
  "keyword_match",
  "handoff_requested",
  "lead_qualified",
  "appointment_upcoming",
] as const;

export const ACTION_TYPES = [
  "send_template",
  "assign_agent",
  "add_tag",
  "close_conversation",
  "handoff_human",
] as const;

export type TriggerType = (typeof TRIGGER_TYPES)[number];
export type ExecutableTriggerType = (typeof EXECUTABLE_TRIGGER_TYPES)[number];
export type ActionType = (typeof ACTION_TYPES)[number];

/**
 * Marcadores que el motor sabe resolver. Los dos de cita solo tienen dato en
 * runs de `appointment_upcoming`; en los demás disparadores resuelven a cadena
 * vacía.
 */
export const TEMPLATE_VARIABLES = [
  "{{contact.name}}",
  "{{contact.phone}}",
  "{{appointment.date}}",
  "{{appointment.time}}",
  "{{business.name}}",
] as const;

const NoConfig = z.object({}).default({});

/**
 * Solo los 5 disparadores ejecutables. `inactivity_24h`, `window_closing`,
 * `appointment_reminder` (nombre legacy, nunca se creó) y cualquier
 * otro valor caen en el mensaje del tercer argumento: son reglas que no
 * correrían nunca.
 *
 * Las palabras clave se validan NO VACÍAS tras `trim`: `"lo que sea".includes("")`
 * es `true`, así que una regla con `keywords: [""]` dispararía con cada mensaje
 * entrante. Esto solo cubre las reglas nuevas — las heredadas las filtra
 * `ruleMatches` en ejecución (expand.ts).
 */
const TriggerVariant = z.discriminatedUnion(
  "trigger_type",
  [
    z.object({
      trigger_type: z.literal("keyword_match"),
      trigger_config: z.object({
        keywords: z
          .array(
            z.string().trim().min(1, "Las palabras clave no pueden estar vacías"),
          )
          .min(1, "Agrega al menos una palabra clave"),
      }),
    }),
    z.object({ trigger_type: z.literal("first_message"), trigger_config: NoConfig }),
    z.object({ trigger_type: z.literal("handoff_requested"), trigger_config: NoConfig }),
    z.object({ trigger_type: z.literal("lead_qualified"), trigger_config: NoConfig }),
    z.object({
      trigger_type: z.literal("appointment_upcoming"),
      // `.refine()` sobre `trigger_config` (no sobre todo el miembro de la
      // unión): `discriminatedUnion` necesita que cada miembro siga siendo un
      // `ZodObject` plano para leer el literal de `trigger_type` — envolver el
      // objeto completo en un refine rompe esa lectura.
      //
      // Sin este refine, `quiet_start=22, quiet_end=8` (o `quiet_start ===
      // quiet_end`) pasan el 422 y dejan la regla en silencio total: el guard
      // de `scanTimeTriggers` es `hour < quietStart || hour >= quietEnd`, que
      // con esos valores es falso para toda hora del día (o una tautología si
      // son iguales). El operador ve la regla activa y nunca sale nada — ni
      // warn, ni run, ni evento.
      trigger_config: z
        .object({
          hours_before: z
            .number("Indica la anticipación en horas")
            .int("La anticipación debe ser un número entero de horas")
            .min(1, "La anticipación mínima es 1 hora")
            .max(168, "La anticipación máxima es 168 horas"),
          quiet_start: z
            .number("La hora de inicio de la ventana debe ser un número")
            .int("La hora de inicio de la ventana debe ser un entero")
            .min(0, "La hora de inicio de la ventana debe ser entre 0 y 23")
            .max(23, "La hora de inicio de la ventana debe ser entre 0 y 23")
            .default(8),
          quiet_end: z
            .number("La hora de fin de la ventana debe ser un número")
            .int("La hora de fin de la ventana debe ser un entero")
            .min(0, "La hora de fin de la ventana debe ser entre 0 y 23")
            .max(23, "La hora de fin de la ventana debe ser entre 0 y 23")
            .default(22),
        })
        .refine((cfg) => cfg.quiet_start < cfg.quiet_end, {
          message: "La hora de inicio debe ser anterior a la de término",
          path: ["quiet_end"],
        }),
    }),
  ],
  { error: "Ese disparador todavía no está disponible" },
);

const ActionVariant = z.discriminatedUnion(
  "action_type",
  [
    z.object({
      action_type: z.literal("send_template"),
      action_config: z.object({
        // El mensaje va también en `z.string(...)`: sin él, un `template_name`
        // AUSENTE cae en el "expected string, received undefined" de zod, que
        // `firstErrorMessage` descarta por estar en inglés. Mismo motivo en
        // `user_id`, `tag`, `name` e `id`.
        template_name: z
          .string("Elige una plantilla aprobada")
          .trim()
          .min(1, "Elige una plantilla aprobada"),
        variables: z
          .array(z.string())
          .max(10, "Máximo 10 variables por plantilla")
          .optional(),
      }),
    }),
    z.object({
      action_type: z.literal("assign_agent"),
      action_config: z.object({
        user_id: z.uuid("Elige un miembro del equipo"),
      }),
    }),
    z.object({
      action_type: z.literal("add_tag"),
      action_config: z.object({
        tag: z
          .string("Escribe el nombre de la etiqueta")
          .trim()
          .min(1, "Escribe el nombre de la etiqueta")
          .max(40, "La etiqueta no puede superar 40 caracteres"),
      }),
    }),
    z.object({ action_type: z.literal("close_conversation"), action_config: NoConfig }),
    z.object({ action_type: z.literal("handoff_human"), action_config: NoConfig }),
  ],
  { error: "Esa acción todavía no está disponible" },
);

const BaseFields = z.object({
  id: z.uuid("ID de regla inválido").optional(),
  name: z
    .string("El nombre es obligatorio")
    .trim()
    .min(1, "El nombre es obligatorio")
    .max(120, "El nombre no puede superar 120 caracteres"),
  enabled: z.boolean().default(true),
});

/**
 * Intersección de los tres pedazos. Ninguna clave se repite entre ellos, así
 * que el merge de zod es un merge de objetos plano y el resultado conserva
 * base + trigger + action (lo cubre el test "conserva TODOS los campos").
 */
export const AutomationRuleInputSchema = BaseFields.and(TriggerVariant).and(
  ActionVariant,
);

export type AutomationRuleInput = z.infer<typeof AutomationRuleInputSchema>;

/** El mismo schema, pero con `id` obligatorio (PATCH y update). */
export const AutomationRuleUpdateSchema = AutomationRuleInputSchema.and(
  z.object({ id: z.uuid("ID de regla inválido") }),
);

/**
 * Primer mensaje de error en español, listo para un toast. Nunca devuelve el
 * texto crudo de zod para uniones sin match (que es en inglés y no le dice nada
 * al operador).
 */
export function firstErrorMessage(err: z.ZodError): string {
  const issue = err.issues[0];
  if (!issue) return "Revisa los datos de la regla";
  const message = issue.message;
  if (!message || /^Invalid|^Expected|^Required/i.test(message)) {
    return "Revisa los datos de la regla";
  }
  return message;
}
