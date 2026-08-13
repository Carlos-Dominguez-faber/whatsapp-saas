/**
 * templates.ts — Template management: list, sync from Kapso, helpers.
 */

import { createClient as createSbClient } from "@supabase/supabase-js";
import { fetchKapsoTemplates } from "./kapso-client";
import { decryptCredentials } from "@/shared/lib/integration-secrets";

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
// Kapso API shape (Meta Graph raw response)
// ──────────────────────────────────────────────────────────────────────────────

interface KapsoTemplateComponent {
  type: string;
  text?: string;
  parameters?: unknown[];
  [key: string]: unknown;
}

interface KapsoTemplate {
  id?: string;
  name?: string;
  language?: string;
  category?: string;
  status?: string;
  components?: KapsoTemplateComponent[];
  [key: string]: unknown;
}

// Maps Meta status strings to our enum
const KAPSO_STATUS_MAP: Record<string, TemplateRow["status"]> = {
  APPROVED: "approved",
  PENDING: "submitted",
  PENDING_DELETION: "submitted",
  REJECTED: "rejected",
  PAUSED: "paused",
  DISABLED: "paused",
};

function mapKapsoStatus(raw: string): TemplateRow["status"] {
  return KAPSO_STATUS_MAP[raw.toUpperCase()] ?? "submitted";
}

// Extracts the body text from the Meta components array
function extractBodyText(components: KapsoTemplateComponent[]): string {
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
// syncTemplatesFromKapso
// ──────────────────────────────────────────────────────────────────────────────

export async function syncTemplatesFromKapso(
  workspaceId: string,
): Promise<{ synced: number; errors: number }> {
  const supabase = svc();

  // 1. Load Kapso integration credentials
  const { data: integration, error: intError } = await supabase
    .from("integrations")
    .select("credentials, config")
    .eq("workspace_id", workspaceId)
    .eq("provider", "kapso")
    .eq("enabled", true)
    .single();

  if (intError || !integration) {
    throw new Error(
      `[templates] Kapso integration not found: ${intError?.message}`,
    );
  }

  const credentials = await decryptCredentials(
    integration.credentials as Record<string, unknown>,
    workspaceId,
    "kapso",
  );
  const config = (integration.config ?? {}) as Record<string, unknown>;
  const apiKey = (credentials.kapso_api_key as string | undefined) ?? "";
  // Kapso's template endpoints are Meta's, so they are scoped to a WABA id.
  // It is configured per workspace — there is no way to discover it from the
  // API without already having it.
  const wabaId = (config.waba_id as string | undefined) ?? "";

  if (!apiKey || apiKey === "placeholder") {
    return { synced: 0, errors: 0 };
  }

  if (!wabaId) {
    throw new Error(
      "[templates] falta waba_id en la configuración de Kapso del workspace",
    );
  }

  // 2. Fetch templates from Kapso
  const records = await fetchKapsoTemplates(apiKey, wabaId);

  let synced = 0;
  let errors = 0;

  // 3. Upsert each template
  for (const raw of records) {
    try {
      const t = raw as KapsoTemplate;
      const name = typeof t.name === "string" ? t.name : "";
      const language = typeof t.language === "string" ? t.language : "es";
      const category = typeof t.category === "string" ? t.category : "UTILITY";
      const status = mapKapsoStatus(
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
