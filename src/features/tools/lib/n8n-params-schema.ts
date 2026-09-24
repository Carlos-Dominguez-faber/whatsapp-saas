import { z } from "zod";

export interface N8nToolParameter {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "enum";
  required: boolean;
  description: string;
  enum_options?: string[];
  /** Redacted in tool_call logs regardless of key name — see registry.ts. */
  sensitive?: boolean;
}

/** Builds the Zod schema the LLM sees for a dynamic n8n tool's arguments. */
export function buildZodSchema(
  parameters: N8nToolParameter[],
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const p of parameters) {
    let field: z.ZodTypeAny;
    switch (p.type) {
      case "string":
        field = z.string().max(2000);
        break;
      case "number":
        field = z.number().finite();
        break;
      case "boolean":
        field = z.boolean();
        break;
      case "enum": {
        const options = p.enum_options ?? [];
        field =
          options.length > 0
            ? z.enum(options as [string, ...string[]])
            : z.string().max(2000);
        break;
      }
    }
    field = field.describe(p.description);
    shape[p.key] = p.required ? field : field.optional();
  }

  return z.object(shape);
}

/** Parameter keys the admin marked sensitive — always redacted in logs. */
export function sensitiveArgKeys(parameters: N8nToolParameter[]): string[] {
  return parameters.filter((p) => p.sensitive).map((p) => p.key);
}
