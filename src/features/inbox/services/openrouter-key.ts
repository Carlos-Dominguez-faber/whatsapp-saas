import { createClient as svcClient, type SupabaseClient } from "@supabase/supabase-js";
import { decryptCredentials } from "@/shared/lib/integration-secrets";

/**
 * Which OpenRouter key a workspace's calls run on, for callers that must not
 * fall back silently (the topic classifier):
 * - its own key;
 * - the platform's (OPENROUTER_API_KEY) when it has none — possibly "", which
 *   the caller treats as a dead platform key;
 * - its own key, configured but impossible to decrypt: an error of THAT key.
 *   Charging the agency's key for it would be wrong;
 * - a failed lookup (the database).
 * getOpenRouterApiKey (openrouter.ts), which the bot uses, keeps its silent
 * fallback to the platform key.
 */
export type OpenRouterKeyResolution =
  | { scope: "own"; key: string }
  | { scope: "platform"; key: string }
  | { scope: "own"; key: null; problem: "unreadable" }
  | { scope: null; key: null; problem: "lookup_failed" };

export async function resolveOpenRouterKey(
  workspaceId: string,
  db: SupabaseClient = svcClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!),
): Promise<OpenRouterKeyResolution> {
  const { data, error } = await db
    .from("integrations")
    .select("credentials")
    .eq("workspace_id", workspaceId)
    .eq("provider", "openrouter")
    .maybeSingle();
  if (error) return { scope: null, key: null, problem: "lookup_failed" };
  const credentials = (data?.credentials as Record<string, unknown> | null) ?? null;
  const stored = credentials?.openrouter_api_key;
  if (stored === undefined || stored === null || stored === "") {
    return { scope: "platform", key: process.env.OPENROUTER_API_KEY ?? "" };
  }
  try {
    const key = (await decryptCredentials(credentials, workspaceId, "openrouter")).openrouter_api_key;
    if (typeof key === "string" && key.length > 0) return { scope: "own", key };
  } catch {
    // Falls through: configured, not usable.
  }
  return { scope: "own", key: null, problem: "unreadable" };
}
