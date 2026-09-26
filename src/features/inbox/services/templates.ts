/**
 * templates.ts — Template management: list, sync from the workspace's WhatsApp
 * provider (YCloud or Kapso), helpers.
 */

import { createClient as createSbClient } from "@supabase/supabase-js";
import { fetchYCloudTemplates } from "./ycloud-client";
import { fetchKapsoTemplates } from "./kapso-client";
import {
  decryptWhatsAppCredentials,
  loadWhatsAppIntegration,
  whatsappApiKey,
  WHATSAPP_NOT_CONNECTED,
  type WhatsAppProvider,
} from "./whatsapp-provider";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface TemplateRow {
  id: string;
  workspace_id: string;
  name: string;
  language: string;
  category: string;
  status: "draft" | "submitted" | "approved" | "rejected" | "paused";
  body_template: string;
  components: Record<string, unknown>;
  variables: unknown[];
  // Rich fields (Phase 4) — header text only for now.
  header_type: "none" | "text";
  header_text: string | null;
  footer_text: string | null;
  buttons: unknown[];
  submitted_at: string | null;
  approved_at: string | null;
  provider_template_id: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Meta template shape (raw response — both providers relay Meta's)
// ──────────────────────────────────────────────────────────────────────────────

interface MetaTemplateComponent {
  type: string;
  text?: string;
  parameters?: unknown[];
  [key: string]: unknown;
}

interface MetaTemplate {
  id?: string;
  name?: string;
  language?: string;
  category?: string;
  status?: string;
  components?: MetaTemplateComponent[];
  [key: string]: unknown;
}

// Maps Meta status strings to our enum
const META_STATUS_MAP: Record<string, TemplateRow["status"]> = {
  APPROVED: "approved",
  PENDING: "submitted",
  PENDING_DELETION: "submitted",
  REJECTED: "rejected",
  PAUSED: "paused",
  DISABLED: "paused",
};

function mapTemplateStatus(raw: string): TemplateRow["status"] {
  return META_STATUS_MAP[raw.toUpperCase()] ?? "submitted";
}

// templates.category is CHECK-constrained to lowercase; Meta reports UPPERCASE.
const TEMPLATE_CATEGORIES = new Set(["marketing", "utility", "authentication"]);
function normalizeCategory(raw: unknown): string {
  const value = typeof raw === "string" ? raw.toLowerCase() : "";
  return TEMPLATE_CATEGORIES.has(value) ? value : "utility";
}

// Extracts the body text from the Meta components array
function extractBodyText(components: MetaTemplateComponent[]): string {
  const bodyComp = components.find((c) => c.type?.toUpperCase() === "BODY");
  return typeof bodyComp?.text === "string" ? bodyComp.text : "";
}

// ──────────────────────────────────────────────────────────────────────────────
// listTemplates
// ──────────────────────────────────────────────────────────────────────────────

export async function listTemplates(
  workspaceId: string,
  status?: string,
): Promise<TemplateRow[]> {
  const supabase = svc();

  let query = supabase
    .from("templates")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("name", { ascending: true });

  if (status) {
    query = query.eq("status", status);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`[templates] listTemplates error: ${error.message}`);
  }

  return (data ?? []) as TemplateRow[];
}

// ──────────────────────────────────────────────────────────────────────────────
// syncTemplates — pulls the workspace's templates from its WhatsApp provider
// ──────────────────────────────────────────────────────────────────────────────

async function fetchProviderTemplates(
  provider: WhatsAppProvider,
  apiKey: string,
  config: Record<string, unknown>,
): Promise<unknown[]> {
  if (provider === "kapso") {
    // Kapso's template endpoints are Meta's, scoped to a WABA id in the path.
    // It is configured per workspace — the API can't discover it without it.
    const wabaId = (config.waba_id as string | undefined) ?? "";
    if (!wabaId) {
      throw new Error(
        "[templates] falta waba_id en la configuración de Kapso del workspace",
      );
    }
    return fetchKapsoTemplates(apiKey, wabaId);
  }
  return fetchYCloudTemplates(apiKey);
}

export async function syncTemplates(
  workspaceId: string,
): Promise<{ synced: number; errors: number }> {
  const supabase = svc();

  // 1. Load the workspace's WhatsApp integration
  const whatsapp = await loadWhatsAppIntegration(supabase, workspaceId);
  if (!whatsapp) {
    throw new Error(`[templates] ${WHATSAPP_NOT_CONNECTED}`);
  }

  const credentials = await decryptWhatsAppCredentials(whatsapp, workspaceId);
  const apiKey = whatsappApiKey(whatsapp.provider, credentials);

  if (!apiKey || apiKey === "placeholder") {
    return { synced: 0, errors: 0 };
  }

  // 2. Fetch templates from the provider
  const records = await fetchProviderTemplates(
    whatsapp.provider,
    apiKey,
    whatsapp.config,
  );

  let synced = 0;
  let errors = 0;

  // 3. Upsert each template
  for (const raw of records) {
    try {
      const t = raw as MetaTemplate;
      const name = typeof t.name === "string" ? t.name : "";
      const language = typeof t.language === "string" ? t.language : "es";
      const category = normalizeCategory(t.category);
      const status = mapTemplateStatus(
        typeof t.status === "string" ? t.status : "PENDING",
      );
      const components = Array.isArray(t.components) ? t.components : [];
      const bodyTemplate = extractBodyText(components);
      const variables = extractTemplateVariables(bodyTemplate);

      const { error: upsertError } = await supabase.from("templates").upsert(
        {
          workspace_id: workspaceId,
          name,
          language,
          category,
          status,
          body_template: bodyTemplate,
          components: t.components ?? {},
          variables,
          provider_template_id: typeof t.id === "string" ? t.id : null,
          rejection_reason: null,
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: "workspace_id,name,language",
          ignoreDuplicates: false,
        },
      );

      if (upsertError) {
        console.error("[templates] upsert error:", upsertError.message, {
          name,
        });
        errors++;
      } else {
        synced++;
      }
    } catch (err) {
      console.error("[templates] record processing error:", err);
      errors++;
    }
  }

  return { synced, errors };
}

// ──────────────────────────────────────────────────────────────────────────────
// extractTemplateVariables
// Returns positional placeholders found in a template body: ["1", "2", ...]
// ──────────────────────────────────────────────────────────────────────────────

export function extractTemplateVariables(bodyTemplate: string): string[] {
  const matches = bodyTemplate.matchAll(/\{\{(\d+)\}\}/g);
  const seen = new Set<string>();
  const result: string[] = [];

  for (const match of matches) {
    const pos = match[1];
    if (pos && !seen.has(pos)) {
      seen.add(pos);
      result.push(pos);
    }
  }

  // Return sorted by numeric value: ["1", "2", "3", ...]
  return result.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

// ──────────────────────────────────────────────────────────────────────────────
// fillTemplateVariables
// Replaces {{1}}, {{2}}, ... with provided values array (index 0 → {{1}})
// ──────────────────────────────────────────────────────────────────────────────

export function fillTemplateVariables(
  bodyTemplate: string,
  values: string[],
): string {
  let result = bodyTemplate;

  values.forEach((value, index) => {
    const placeholder = `{{${index + 1}}}`;
    result = result.replaceAll(placeholder, value);
  });

  return result;
}
