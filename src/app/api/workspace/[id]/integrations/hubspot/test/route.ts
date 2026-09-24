import { NextRequest, NextResponse } from "next/server";
import { createClient as svcClient } from "@supabase/supabase-js";
import { requireWorkspaceMember } from "@/lib/auth/workspace-access";
import {
  HS_API_VERSION,
  ensureHubSpotProperties,
  readHubSpotConfig,
  getHubSpotPortalId,
  hsFetch,
  hubSpotTokenFingerprint,
} from "@/features/inbox/services/hubspot-client";

/** Códigos → texto para el admin. Nunca el texto de HubSpot. */
const MESSAGES: Record<string, string> = {
  unauthorized: "El token de HubSpot no es válido. Revisa que lo copiaste completo.",
  missing_scope:
    "El token no tiene todos los permisos. Revisa los scopes de la app privada: contactos, negocios, propiedades de contactos y comunicaciones.",
  rate_limited: "HubSpot está limitando las consultas. Espera un minuto y vuelve a probar.",
  phone_property_conflict:
    "Ya existe en tu HubSpot una propiedad «whatsapp_phone» que no es de texto con valor único. Corrígela o renómbrala y vuelve a probar.",
  tags_property_conflict:
    "Ya existe en tu HubSpot una propiedad «whatsapp_tags» que no es de casillas de selección múltiple. Corrígela o renómbrala y vuelve a probar.",
  phone_property_create_rejected:
    "HubSpot no aceptó crear la propiedad «whatsapp_phone» en tu cuenta. Volver a probar no lo resuelve: avísanos para revisarlo.",
  tags_property_create_rejected:
    "HubSpot no aceptó crear la propiedad «whatsapp_tags» en tu cuenta. Volver a probar no lo resuelve: avísanos para revisarlo.",
};
const FALLBACK = "No pudimos conectar con HubSpot. Intenta de nuevo en unos minutos.";

// POST /api/workspace/[id]/integrations/hubspot/test
// Valida el token, identifica la cuenta (portal), crea/valida las propiedades del agente y marca
// la integración lista SOLO para el token probado. Admin: además de probar,
// ESCRIBE en la cuenta de HubSpot del cliente y en la config.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const auth = await requireWorkspaceMember(workspaceId, { minRole: "admin" });
  if (!auth.ok) return auth.response;

  // Distingue "no configurado" de "no se pudo leer" en vez de mostrarle
  // siempre "guarda primero el token" (readHubSpotConfig, no el wrapper público que las junta).
  const cfgResult = await readHubSpotConfig(workspaceId);
  if (!cfgResult.ok) {
    if (cfgResult.code === "not_configured") {
      return NextResponse.json({
        ok: false,
        error: "Guarda primero el token de HubSpot. Si ya lo guardaste, revisa que la integración esté activa.",
      });
    }
    if (cfgResult.code === "decrypt_failed") {
      return NextResponse.json({
        ok: false,
        error: "No pudimos leer el token guardado. Vuelve a pegarlo y guárdalo de nuevo.",
      });
    }
    console.error("[integrations/hubspot/test] readHubSpotConfig:", cfgResult.code);
    return NextResponse.json({
      ok: false,
      error: "No pudimos comprobar la conexión con HubSpot. Intenta de nuevo en unos minutos.",
    });
  }
  const cfg = cfgResult.config;
  const fail = (code: string) => {
    console.error("[integrations/hubspot/test]", code);
    return NextResponse.json({ ok: false, error: MESSAGES[code] ?? FALLBACK });
  };

  const probe = await hsFetch(cfg.token, `/crm/objects/${HS_API_VERSION}/contacts?limit=1`);
  if (!probe.ok) return fail(probe.code);
  const portal = await getHubSpotPortalId(cfg.token);
  if (!portal.ok) return fail(portal.code);
  const props = await ensureHubSpotProperties(cfg.token);
  if (!props.ok) return fail(props.code);

  const svc = svcClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data, error } = await svc.rpc("mark_hubspot_ready", {
    p_workspace_id: workspaceId,
    p_token_fingerprint: hubSpotTokenFingerprint(cfg.token),
    p_portal_id: portal.portalId,
  });
  if (error) {
    console.error("[integrations/hubspot/test] mark_hubspot_ready:", error.message);
    return NextResponse.json({ ok: false, error: "No pudimos guardar el estado de la conexión. Intenta de nuevo." });
  }
  const result = ((data as Array<{ updated: boolean; portal_changed: boolean }> | null) ?? [])[0];
  if (!result?.updated) {
    return NextResponse.json({ ok: false, error: "El token cambió mientras probábamos la conexión. Vuelve a probar." });
  }
  return NextResponse.json({ ok: true, portalChanged: result.portal_changed });
}
