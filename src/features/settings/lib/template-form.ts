/**
 * template-form.ts — shared types + Zod schema for the WhatsApp template builder.
 *
 * Pure module (no "use server", no DB) so both the client form and the server
 * routes can import it. Text-header only for now (media headers are a later
 * add-on). Categories are stored lowercase (consistent with the existing
 * `templates` rows, `template_library`, and the CRUD API) and only uppercased
 * at the submission boundary via `buildTemplatePayload`.
 */

import { z } from "zod";

// Language is fixed to "es" for now (matches the provider accounts + the CRUD API
// literal). Kept as a constant so widening it later is a one-line change.
export const TEMPLATE_LANGUAGE = "es" as const;

// Stored lowercase. Meta (via YCloud or Kapso) only accepts the uppercase form
// on creation, so we uppercase at the submit boundary (see buildTemplatePayload).
export const TEMPLATE_CATEGORIES = ["utility", "marketing"] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<TemplateCategory, string> = {
  utility: "Utilidad",
  marketing: "Marketing",
};

export const templateButtonSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("quick_reply"),
    text: z.string().min(1).max(25),
  }),
  z.object({
    type: z.literal("url"),
    text: z.string().min(1).max(25),
    value: z.string().url().max(2000),
  }),
  z.object({
    type: z.literal("phone"),
    text: z.string().min(1).max(25),
    value: z.string().min(1).max(20),
  }),
]);
export type TemplateButton = z.infer<typeof templateButtonSchema>;

export const templateVariableSchema = z.object({
  index: z.number().int().min(1),
  example: z.string().max(200),
});
export type TemplateVariable = z.infer<typeof templateVariableSchema>;

export const createTemplateSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[a-z0-9_]+$/, "Solo minúsculas, números y guion bajo (_)"),
  category: z.enum(TEMPLATE_CATEGORIES),
  header_type: z.enum(["none", "text"]).default("none"),
  header_text: z.string().max(60).default(""),
  body_template: z.string().min(1).max(1024),
  body_variables: z.array(templateVariableSchema).max(20).default([]),
  footer_text: z.string().max(60).default(""),
  buttons: z.array(templateButtonSchema).max(3).default([]),
});
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

/** Returns the sorted, de-duplicated {{n}} indices used in a body string. */
export function detectBodyVariables(body: string): number[] {
  return Array.from(
    new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]))),
  ).sort((a, b) => a - b);
}

/** Replaces {{n}} with the matching example (or a placeholder) for previews. */
export function fillTemplatePreview(
  body: string,
  variables: TemplateVariable[],
): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, n) => {
    const v = variables.find((vv) => vv.index === Number(n));
    return v?.example ? v.example : `[${n}]`;
  });
}

/** Sanitises a free-text name into the [a-z0-9_] template name format. */
export function sanitizeTemplateName(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(new RegExp("[\\u0300-\\u036f]", "g"), "") // strip accents (ó → o)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

// ──────────────────────────────────────────────────────────────────────────────
// Template payload builder (pure) — Meta's message_templates shape, which both
// providers accept: YCloud (POST /v2/whatsapp/templates, wabaId in the body) and
// Kapso (POST /{waba_id}/message_templates, wabaId in the path).
// ──────────────────────────────────────────────────────────────────────────────

export type MetaTemplateButton =
  | { type: "QUICK_REPLY"; text: string }
  | { type: "URL"; text: string; url: string }
  | { type: "PHONE_NUMBER"; text: string; phone_number: string };

export interface MetaTemplateComponent {
  type: "HEADER" | "BODY" | "FOOTER" | "BUTTONS";
  format?: "TEXT";
  text?: string;
  example?: { header_text?: string[]; body_text?: string[][] };
  buttons?: MetaTemplateButton[];
}

export interface MetaTemplatePayload {
  name: string;
  language: string;
  category: string; // UPPERCASE
  components: MetaTemplateComponent[];
}

/** Looks up the user-provided example for a {{n}}, falling back to a sample. */
function exampleForIndex(variables: TemplateVariable[], index: number): string {
  const found = variables.find((v) => v.index === index)?.example?.trim();
  return found && found.length > 0 ? found : `Ejemplo ${index}`;
}

function toMetaButton(btn: TemplateButton): MetaTemplateButton {
  if (btn.type === "quick_reply") {
    return { type: "QUICK_REPLY", text: btn.text };
  }
  if (btn.type === "url") {
    return { type: "URL", text: btn.text, url: btn.value };
  }
  return { type: "PHONE_NUMBER", text: btn.text, phone_number: btn.value };
}

/**
 * Builds Meta's `components` array from builder input. Meta requires an
 * `example` for every component that contains a {{n}} variable, so we always
 * emit non-empty samples for header/body variables.
 */
export function buildTemplateComponents(
  input: CreateTemplateInput,
): MetaTemplateComponent[] {
  const components: MetaTemplateComponent[] = [];

  // HEADER (text only)
  if (input.header_type === "text" && input.header_text.trim()) {
    const headerVars = detectBodyVariables(input.header_text);
    const header: MetaTemplateComponent = {
      type: "HEADER",
      format: "TEXT",
      text: input.header_text,
    };
    if (headerVars.length > 0) {
      header.example = {
        header_text: headerVars.map((n) =>
          exampleForIndex(input.body_variables, n),
        ),
      };
    }
    components.push(header);
  }

  // BODY (required)
  const bodyVars = detectBodyVariables(input.body_template);
  const body: MetaTemplateComponent = { type: "BODY", text: input.body_template };
  if (bodyVars.length > 0) {
    body.example = {
      body_text: [
        bodyVars.map((n) => exampleForIndex(input.body_variables, n)),
      ],
    };
  }
  components.push(body);

  // FOOTER
  if (input.footer_text.trim()) {
    components.push({ type: "FOOTER", text: input.footer_text });
  }

  // BUTTONS
  if (input.buttons.length > 0) {
    components.push({
      type: "BUTTONS",
      buttons: input.buttons.map(toMetaButton),
    });
  }

  return components;
}

/**
 * Full create payload (category uppercased here). The WABA id is added by the
 * provider: YCloud takes it in the body, Kapso in the request path.
 */
export function buildTemplatePayload(
  input: CreateTemplateInput,
): MetaTemplatePayload {
  return {
    name: input.name,
    language: TEMPLATE_LANGUAGE,
    category: input.category.toUpperCase(),
    components: buildTemplateComponents(input),
  };
}
