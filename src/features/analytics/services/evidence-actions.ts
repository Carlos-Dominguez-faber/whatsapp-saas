"use server";

import { createClient as createSbClient } from "@supabase/supabase-js";
import { checkWorkspaceMember } from "@/lib/auth/workspace-access";
import { EvidenceInputSchema } from "../lib/schemas";

export interface EvidenceRow {
  conversation_id: string;
  contact_name: string | null;
  contact_phone: string;
  detected_at: string;
  evidence_body: string | null;
}

const PAGE_SIZE = 20;

function svc() {
  return createSbClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

export async function getEvidenceAction(
  workspaceId: string,
  input: unknown,
): Promise<{ data: EvidenceRow[]; hasMore: boolean } | { error: string }> {
  const member = await checkWorkspaceMember(workspaceId, { minRole: "viewer" });
  if (!member.ok) return { error: "No tienes acceso al análisis de este espacio." };

  const parsed = EvidenceInputSchema.safeParse(input);
  if (!parsed.success) return { error: "No se pudo abrir la evidencia con esos filtros." };
  const v = parsed.data;

  const { data, error } = await svc().rpc("get_insight_evidence", {
    p_workspace_id: workspaceId,
    p_topic_id: v.topicId,
    p_from: v.fromIso,
    p_to: v.toIso,
    p_outcome: v.outcome,
    p_tag: v.outcome === "tag" ? (v.tag ?? null) : null,
    p_limit: PAGE_SIZE + 1,
    p_offset: v.page * PAGE_SIZE,
  });
  if (error) {
    console.error("[analisis] evidence failed", error.code);
    return { error: "No se pudo cargar la evidencia, intenta de nuevo en unos minutos." };
  }

  const rows = (data ?? []) as EvidenceRow[];
  return { data: rows.slice(0, PAGE_SIZE), hasMore: rows.length > PAGE_SIZE };
}
