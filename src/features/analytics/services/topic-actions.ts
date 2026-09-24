"use server";

import { createClient as createSbClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { checkWorkspaceMember } from "@/lib/auth/workspace-access";
import { TopicInputSchema } from "../lib/schemas";

export interface InsightTopic {
  id: string;
  name: string;
  description: string;
  status: "active" | "archived";
  backfill_status: "pending" | "done" | "expired";
  created_at: string;
}

export type TopicActionResult<T> =
  | { data: T }
  | { error: string; fieldErrors?: Partial<Record<"name" | "description", string>> };

const TOPIC_COLUMNS = "id, name, description, status, backfill_status, created_at";
const MSG_FORBIDDEN = "No tienes permiso para gestionar temas en este espacio.";
const MSG_SESSION = "Tu sesión expiró. Vuelve a iniciar sesión.";
const MSG_CAP = "Llegaste al máximo de 10 temas activos. Archiva uno para crear otro.";
const MSG_NOT_FOUND = "Ese tema no existe o ya está archivado.";
const MSG_GENERIC = "No se pudo guardar el tema. Intenta de nuevo en unos minutos.";
const MSG_INVALID = "Revisa los datos del tema.";

function svc() {
  return createSbClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

// Es un endpoint HTTP: verifica la membresía ella misma (manager o superior).
async function authorize(workspaceId: string) {
  const member = await checkWorkspaceMember(workspaceId, { minRole: "manager" });
  if (member.ok) return member;
  return { error: member.status === 401 ? MSG_SESSION : MSG_FORBIDDEN } as const;
}

function parseInput(input: unknown) {
  const parsed = TopicInputSchema.safeParse(input);
  if (parsed.success) return parsed;
  const fieldErrors: Partial<Record<"name" | "description", string>> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if ((field === "name" || field === "description") && !fieldErrors[field]) {
      fieldErrors[field] = issue.message;
    }
  }
  return { success: false as const, result: { error: MSG_INVALID, fieldErrors } };
}

function dbError(op: string, error: { code?: string; message: string }): { error: string } {
  if (error.message.includes("insight_topics_cap")) return { error: MSG_CAP };
  console.error(`[topic-actions] ${op} failed`, error.code ?? "unknown");
  return { error: MSG_GENERIC };
}

const isUuid = (v: string) => z.uuid().safeParse(v).success;

export async function createTopicAction(
  workspaceId: string,
  input: unknown,
): Promise<TopicActionResult<InsightTopic>> {
  const auth = await authorize(workspaceId);
  if ("error" in auth) return { error: auth.error };

  const parsed = parseInput(input);
  if (!parsed.success) return parsed.result;

  const { data, error } = await svc()
    .from("insight_topics")
    .insert({ workspace_id: workspaceId, ...parsed.data, created_by: auth.userId })
    .select(TOPIC_COLUMNS)
    .single();
  if (error) return dbError("create", error);

  revalidatePath("/analisis");
  return { data: data as InsightTopic };
}

export async function updateTopicAction(
  workspaceId: string,
  topicId: string,
  input: unknown,
): Promise<TopicActionResult<InsightTopic>> {
  if (!isUuid(topicId)) return { error: MSG_NOT_FOUND };
  const auth = await authorize(workspaceId);
  if ("error" in auth) return { error: auth.error };

  const parsed = parseInput(input);
  if (!parsed.success) return parsed.result;

  // Editar no reprocesa; solo nombre y descripción.
  const { data, error } = await svc()
    .from("insight_topics")
    .update({ name: parsed.data.name, description: parsed.data.description })
    .eq("id", topicId)
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .select(TOPIC_COLUMNS)
    .maybeSingle();
  if (error) return dbError("update", error);
  if (!data) return { error: MSG_NOT_FOUND };

  revalidatePath("/analisis");
  return { data: data as InsightTopic };
}

export async function archiveTopicAction(
  workspaceId: string,
  topicId: string,
): Promise<TopicActionResult<{ id: string }>> {
  if (!isUuid(topicId)) return { error: MSG_NOT_FOUND };
  const auth = await authorize(workspaceId);
  if ("error" in auth) return { error: auth.error };

  // Archivar conserva los datos; no hay acción de reactivar.
  const { data, error } = await svc()
    .from("insight_topics")
    .update({ status: "archived" })
    .eq("id", topicId)
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .select("id")
    .maybeSingle();
  if (error) return dbError("archive", error);
  if (!data) return { error: MSG_NOT_FOUND };

  revalidatePath("/analisis");
  return { data: { id: (data as { id: string }).id } };
}
