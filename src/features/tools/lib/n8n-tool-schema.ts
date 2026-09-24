// Shared Zod schema for a single n8n tool parameter, used by the create/update
// request validators in src/app/api/workspace/[id]/n8n-tools/**. Validates what
// an admin sends via the API — NOT the schema the LLM sees when invoking the
// tool (that's buildZodSchema in ./n8n-params-schema.ts, a different module).

import { z } from "zod";

export const N8nParameterSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^[a-zA-Z0-9_]+$/, "Solo letras, números y guion bajo"),
    label: z.string().trim().min(1).max(120),
    type: z.enum(["string", "number", "boolean", "enum"]),
    required: z.boolean(),
    description: z.string().trim().min(1).max(500),
    enum_options: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
    sensitive: z.boolean().optional(),
  })
  .refine((p) => p.type !== "enum" || (p.enum_options?.length ?? 0) > 0, {
    message: "Los parámetros tipo enum requieren al menos una opción",
    path: ["enum_options"],
  });
