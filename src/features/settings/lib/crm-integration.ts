/**
 * Lógica pura de las secciones de CRM de Configuración → Integraciones. Vive fuera del
 * componente para poder probarla con node:test (sin jsdom). La regla de verdad es la del servidor
 * (índice uq_integrations_one_active_crm + 409 del PUT); esto evita ofrecer un botón que va a
 * fallar y no reenviar un token que no cambió.
 */

export type CrmName = "highlevel" | "hubspot";

const LABEL: Record<CrmName, string> = { highlevel: "HighLevel", hubspot: "HubSpot" };

export function crmBlockedBy(
  integrations: Array<{ provider: string; enabled: boolean }>,
  self: CrmName,
): string | null {
  const other: CrmName = self === "highlevel" ? "hubspot" : "highlevel";
  return integrations.some((i) => i.provider === other && i.enabled) ? LABEL[other] : null;
}

export function crmBlockedMessage(blockedBy: string, self: CrmName): string {
  return `Ya tienes ${blockedBy} conectado como CRM. Desactívalo antes de conectar ${LABEL[self]}.`;
}

export function crmControls(s: {
  blockedBy: string | null;
  enabled: boolean;
  saving: boolean;
  testing: boolean;
  /**
   * Solo la sección de HubSpot la pasa — el token del input difiere del
   * guardado. Probar con un token no guardado prueba el token VIEJO y confunde al admin.
   */
  tokenDirty?: boolean;
}): { canSave: boolean; canTest: boolean; showDisable: boolean; testHint: string | null } {
  const tokenDirty = s.tokenDirty === true;
  return {
    canSave: !s.blockedBy && !s.saving,
    canTest: !s.blockedBy && !s.testing && !tokenDirty,
    showDisable: s.enabled,
    testHint: tokenDirty ? "Guarda el token antes de probar" : null,
  };
}

/** Body del PUT de HubSpot. La credencial viaja SOLO si el usuario la editó: reenviar la máscara o el mismo token no cambia nada. */
export function hubSpotSaveBody(s: {
  token: string;
  tokenDirty: boolean;
  pipelineId: string;
  stageId: string;
}): {
  provider: "hubspot";
  enabled: true;
  credentials?: { hubspot_token: string };
  config: { pipeline_id: string; deal_stage_id: string };
} {
  const token = s.token.trim();
  return {
    provider: "hubspot",
    enabled: true,
    ...(s.tokenDirty && token ? { credentials: { hubspot_token: token } } : {}),
    config: { pipeline_id: s.pipelineId, deal_stage_id: s.stageId },
  };
}

export function crmDisableBody(provider: CrmName): { provider: CrmName; enabled: false } {
  return { provider, enabled: false };
}
