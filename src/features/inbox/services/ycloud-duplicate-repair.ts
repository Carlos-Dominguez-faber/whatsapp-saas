import type { NormalizedInbound } from "./ycloud-webhook-handler";

export interface ExistingInboundSnapshot {
  type: string;
  body: string | null;
  meta: Record<string, unknown> | null;
}

export interface DuplicateRepairPatch {
  type?: string;
  body?: string | null;
  meta?: Record<string, unknown>;
}

function contentQuality(body: string | null): number {
  const value = body?.trim() ?? "";
  if (!value) return 0;
  if (value === "[Multimedia]") return 1;
  if (
    value.startsWith("[Mensaje de WhatsApp no compatible:") ||
    value === "[Mensaje de texto vacío o no compatible]"
  ) {
    return 2;
  }
  if (value.startsWith("[") && value.endsWith("]")) return 3;
  return 4;
}

export function buildInboundMeta(
  normalized: NormalizedInbound,
  existing: Record<string, unknown> | null = null,
): Record<string, unknown> {
  const meta: Record<string, unknown> = { ...(existing ?? {}) };
  if (normalized.customerName) meta.from_name = normalized.customerName;
  meta.raw_ycloud_type = normalized.rawType;

  if (normalized.rawSubtype) {
    meta.raw_ycloud_subtype = normalized.rawSubtype;
  } else {
    delete meta.raw_ycloud_subtype;
  }
  if (normalized.diagnosticCodes.length > 0) {
    meta.provider_error_codes = normalized.diagnosticCodes;
  } else {
    delete meta.provider_error_codes;
  }

  return meta;
}

/**
 * Builds a conservative repair for a duplicate webhook.
 *
 * A second provider route may arrive after a legacy handler inserted the same
 * wamid as `[Multimedia]`. The duplicate remains idempotent, but a higher-quality
 * body/type and sanitized diagnostics may repair that row without buffering or
 * replying a second time.
 */
export function buildDuplicateRepairPatch(
  existing: ExistingInboundSnapshot,
  normalized: NormalizedInbound,
): DuplicateRepairPatch | null {
  const patch: DuplicateRepairPatch = {};
  const existingMeta = existing.meta ?? {};
  const nextMeta = buildInboundMeta(normalized, existingMeta);

  if (contentQuality(normalized.text) > contentQuality(existing.body)) {
    patch.body = normalized.text;
  }

  if (existing.type === "text" && normalized.type !== "text") {
    patch.type = normalized.type;
  }

  if (JSON.stringify(nextMeta) !== JSON.stringify(existingMeta)) {
    patch.meta = nextMeta;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}
