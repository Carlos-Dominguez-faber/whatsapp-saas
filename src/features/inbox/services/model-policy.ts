import type { SupabaseClient } from "@supabase/supabase-js";
import { isCatalogModel } from "@/features/agents/lib/model-catalog";
import { readWorkspaceOpenRouterKey } from "./openrouter";
import { emitEventOncePerDay } from "./daily-events";

/** The model the platform falls back to (OPENROUTER_DEFAULT_MODEL). */
export function platformDefaultModel(): string {
  return process.env.OPENROUTER_DEFAULT_MODEL ?? "openai/gpt-4o-mini";
}

/**
 * The model a call for `workspaceId` may actually use.
 *
 * Route checks keep new saves inside the catalog, but a model can still reach
 * a call from elsewhere: a legacy `config.model`, a value saved before the
 * catalog was enforced, or a direct write that RLS allows (a manager can
 * update agents.model). So the resolved model is checked here, at spend time:
 *   - a workspace with its own OpenRouter key pays for itself: any model;
 *   - on the platform key, a model outside the catalog is replaced by the
 *     platform default, with one model_outside_catalog event per day.
 */
export async function enforceModelPolicy(
  supabase: SupabaseClient,
  workspaceId: string,
  model: string,
  source: "agent_turn" | "agent_test_chat",
): Promise<string> {
  const fallback = platformDefaultModel();
  if (model === fallback || isCatalogModel(model)) return model;
  if (await readWorkspaceOpenRouterKey(workspaceId)) return model;

  console.warn(
    `[model-policy] workspace=${workspaceId} ${model} is outside the catalog on the platform key; using ${fallback}`,
  );
  await emitEventOncePerDay(supabase, workspaceId, "model_outside_catalog", "warn", {
    model,
    replaced_with: fallback,
    source,
  });
  return fallback;
}
