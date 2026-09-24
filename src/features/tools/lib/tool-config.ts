/**
 * tool-config.ts — shared (UI + server) Zod schemas and helpers for the
 * configurable tools: schedule_link (a scheduling URL) and custom_webhook
 * (a webhook URL + a payload built from variables).
 *
 * Pure module: no "use server", no DB — safe to import from client components.
 */

import { z } from "zod";

// ── Webhook payload variables ──────────────────────────────────────────────────

export type WebhookVariableCategory = "Contacto" | "Conversación" | "Negocio";

export interface WebhookVariableDef {
  /** Token written as {{token}} in a field value. */
  token: string;
  label: string;
  example: string;
  category: WebhookVariableCategory;
}

/** Variables the admin can drop into webhook payload field values. */
export const WEBHOOK_VARIABLES: WebhookVariableDef[] = [
  {
    token: "contact.name",
    label: "Nombre del contacto",
    example: "Juan Pérez",
    category: "Contacto",
  },
  {
    token: "contact.phone",
    label: "Teléfono",
    example: "+5219981234567",
    category: "Contacto",
  },
  {
    token: "contact.email",
    label: "Email",
    example: "juan@correo.com",
    category: "Contacto",
  },
  {
    token: "last_user_message",
    label: "Último mensaje",
    example: "Hola, quiero info",
    category: "Conversación",
  },
  {
    token: "conversation.id",
    label: "ID de conversación",
    example: "a1b2c3…",
    category: "Conversación",
  },
  {
    token: "note",
    label: "Nota del agente",
    example: "Interesado en blanqueamiento",
    category: "Conversación",
  },
  {
    token: "business.name",
    label: "Negocio",
    example: "Clínica Sonrisa",
    category: "Negocio",
  },
];

/** Distinct categories in display order. */
export const WEBHOOK_VARIABLE_CATEGORIES: WebhookVariableCategory[] = [
  "Contacto",
  "Conversación",
  "Negocio",
];

export type WebhookVariableValues = Record<string, string>;

/** Replaces {{token}} occurrences with the resolved value (missing → ""). */
export function resolveTemplate(
  template: string,
  values: WebhookVariableValues,
): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, token: string) => {
    const v = values[token];
    return typeof v === "string" ? v : "";
  });
}

// ── Config schemas (validated at the save boundary) ────────────────────────────

export const HTTPS_URL = z
  .string()
  .trim()
  .url("Debe ser una URL válida")
  .max(2000)
  .refine((u) => u.startsWith("https://"), "La URL debe ser HTTPS");

export const scheduleLinkConfigSchema = z.object({
  scheduling_link: HTTPS_URL,
});
export type ScheduleLinkConfig = z.infer<typeof scheduleLinkConfigSchema>;

export const webhookFieldSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-zA-Z0-9_]+$/, "Solo letras, números y guion bajo"),
  value: z.string().max(500),
});
export type WebhookField = z.infer<typeof webhookFieldSchema>;

export const webhookConfigSchema = z.object({
  webhook_url: HTTPS_URL,
  payload_fields: z.array(webhookFieldSchema).max(20).default([]),
});
export type WebhookConfig = z.infer<typeof webhookConfigSchema>;

/** Maps a tool key to its config schema (undefined = no configurable fields). */
export function configSchemaForTool(toolKey: string): z.ZodTypeAny | undefined {
  if (toolKey === "schedule_link") return scheduleLinkConfigSchema;
  if (toolKey === "custom_webhook") return webhookConfigSchema;
  return undefined;
}
