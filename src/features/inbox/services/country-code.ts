import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_COUNTRY_CODE } from "./phone";

/**
 * The workspace's country code for numbers written without one (Configuración
 * → Negocio), or Mexico's when it isn't set or isn't a code.
 */
export async function workspaceCountryCode(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<string> {
  const { data } = await supabase
    .from("business_info")
    .select("structured")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const code = (data?.structured as { default_country_code?: unknown } | null)
    ?.default_country_code;
  return typeof code === "string" && /^\d{1,4}$/.test(code) ? code : DEFAULT_COUNTRY_CODE;
}
