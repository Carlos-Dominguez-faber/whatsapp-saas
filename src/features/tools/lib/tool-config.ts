/**
 * tool-config.ts — shared (UI + server) Zod schemas and helpers for the
 * configurable tools: schedule_link (a scheduling URL).
 *
 * Pure module: no "use server", no DB — safe to import from client components.
 */

import { z } from "zod";

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

/** Maps a tool key to its config schema (undefined = no configurable fields). */
export function configSchemaForTool(toolKey: string): z.ZodTypeAny | undefined {
  if (toolKey === "schedule_link") return scheduleLinkConfigSchema;
  return undefined;
}
