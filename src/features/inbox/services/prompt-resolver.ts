// F7: Prompt resolver — hierarchy-based system prompt selection.
// Resolves the most specific published prompt for a given context.

import { createClient as createSbClient } from "@supabase/supabase-js";
import type { PromptGuardrails } from "./prompt-builder";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export interface ResolvedPrompt {
  body: string;
  promptId: string;
  versionId: string;
  scope: string;
  guardrails: PromptGuardrails | null;
}

// Most-specific scopes first — first match wins
const SCOPE_PRIORITY = [
  "mode",
  "segment",
  "campaign",
  "number",
  "global",
] as const;

type Scope = (typeof SCOPE_PRIORITY)[number];

export interface PromptContext {
  number?: string;
  segment?: string;
  campaign?: string;
  mode?: string;
}

/**
 * Resolves the most specific active+published system prompt for a workspace.
 * Tries each scope in priority order (mode > segment > campaign > number > global).
 * Returns null when no published prompt exists — caller should use a default.
 */
export async function resolveSystemPrompt(
  workspaceId: string,
  context: PromptContext,
): Promise<ResolvedPrompt | null> {
  const supabase = svc();

  for (const scope of SCOPE_PRIORITY) {
    const scopeRef = context[scope as keyof PromptContext];

    // Build the query base
    let query = supabase
      .from("prompts")
      .select(
        `
        id,
        scope,
        active_version_id,
        prompt_versions!active_version_id (
          id,
          body,
          state,
          guardrails
        )
      `,
      )
      .eq("workspace_id", workspaceId)
      .eq("scope", scope)
      .not("active_version_id", "is", null);

    // For non-global scopes, filter by scope_ref when provided
    if (scope !== "global" && scopeRef) {
      query = query.eq("scope_ref", scopeRef);
    } else if (scope !== "global" && !scopeRef) {
      // No ref for this scope in context — skip it
      continue;
    }

    const { data, error } = await query.limit(1).maybeSingle();

    if (error) {
      console.error(`[prompt-resolver] scope=${scope} query error:`, error);
      continue;
    }

    if (!data) continue;

    // Validate the joined version is published.
    // Supabase returns the FK-hint join as an array; cast through unknown to
    // avoid TS overlap error, then normalise to a single object or null.
    type VersionRow = {
      id: string;
      body: string;
      state: string;
      guardrails: PromptGuardrails | null;
    };
    const rawVersion = data.prompt_versions as unknown;
    const version: VersionRow | null = Array.isArray(rawVersion)
      ? ((rawVersion[0] as VersionRow) ?? null)
      : (rawVersion as VersionRow | null);

    if (!version || version.state !== "published") continue;

    return {
      body: version.body,
      promptId: data.id as string,
      versionId: version.id,
      scope: data.scope as string,
      guardrails: version.guardrails ?? null,
    };
  }

  return null;
}

/**
 * Publishes a specific prompt version.
 * Sets the version to published, updates active_version_id on the prompt,
 * and marks all other versions of that prompt as draft.
 *
 * `workspaceId` is required and filters every write: this function runs
 * with `service_role` (no RLS), so the tenant scoping has to happen here or
 * a caller could publish a version belonging to another workspace.
 *
 * Returns `false` (without touching `prompts` or demoting other versions)
 * if `promptId`/`versionId` don't belong to `workspaceId` — the caller
 * should treat that as "not found", not attempt the rest of the publish.
 */
export async function publishPromptVersion(
  workspaceId: string,
  promptId: string,
  versionId: string,
): Promise<boolean> {
  const supabase = svc();

  // Mark the target version as published
  const { data: versionRows, error: versionError } = await supabase
    .from("prompt_versions")
    .update({
      state: "published",
      published_at: new Date().toISOString(),
    })
    .eq("id", versionId)
    .eq("prompt_id", promptId)
    .eq("workspace_id", workspaceId)
    .select("id");

  if (versionError) {
    throw new Error(
      `[prompt-resolver] failed to publish version: ${versionError.message}`,
    );
  }

  if (!versionRows || versionRows.length === 0) {
    return false;
  }

  // Set active_version_id on the parent prompt
  const { error: promptError } = await supabase
    .from("prompts")
    .update({ active_version_id: versionId })
    .eq("id", promptId)
    .eq("workspace_id", workspaceId);

  if (promptError) {
    throw new Error(
      `[prompt-resolver] failed to set active_version_id: ${promptError.message}`,
    );
  }

  // Demote all other versions of this prompt back to draft
  const { error: demoteError } = await supabase
    .from("prompt_versions")
    .update({ state: "draft" })
    .eq("prompt_id", promptId)
    .eq("workspace_id", workspaceId)
    .neq("id", versionId);

  if (demoteError) {
    // Non-fatal — log but don't throw; the published version is already set
    console.error(
      "[prompt-resolver] failed to demote old versions:",
      demoteError,
    );
  }

  return true;
}

/**
 * Creates a new draft version for a prompt.
 * Auto-increments the version number based on the latest existing version.
 * Returns the new version id.
 */
export async function createPromptVersion(
  workspaceId: string,
  promptId: string,
  body: string,
  variables?: unknown[],
  guardrails?: PromptGuardrails | null,
): Promise<string> {
  const supabase = svc();

  // Get the current max version number for this prompt
  const { data: existing } = await supabase
    .from("prompt_versions")
    .select("version")
    .eq("prompt_id", promptId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextVersion =
    existing && typeof existing.version === "number" ? existing.version + 1 : 1;

  const { data, error } = await supabase
    .from("prompt_versions")
    .insert({
      workspace_id: workspaceId,
      prompt_id: promptId,
      version: nextVersion,
      state: "draft",
      body,
      variables: variables ?? [],
      guardrails: guardrails ?? {},
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(
      `[prompt-resolver] failed to create version: ${error?.message}`,
    );
  }

  return data.id as string;
}

/**
 * Lists all prompts for a workspace, joining **all** their versions — drafts
 * included, no solo la activa. Esa es la razón del hint `!prompt_id` de abajo:
 * el otro hint posible (`!active_version_id`) devolvería únicamente la activa.
 *
 * Las versiones embebidas vienen SIN orden garantizado; hoy no hay ningún
 * consumidor de este endpoint, así que el orden se decide cuando aparezca el
 * primero (`.order("version", { referencedTable: "prompt_versions" })`).
 */
export async function listPrompts(workspaceId: string): Promise<unknown[]> {
  const supabase = svc();

  // El `!prompt_id` NO es decorativo: hay dos FK entre `prompts` y
  // `prompt_versions` (`prompt_versions.prompt_id` y `prompts.active_version_id`,
  // las dos de `20260608000000_foundation.sql`), así que sin el hint PostgREST
  // no sabe cuál usar y responde PGRST201 — la consulta entera falla. Es la
  // relación padre→hijo la que se quiere: todas las versiones del prompt.
  const { data, error } = await supabase
    .from("prompts")
    .select(
      `
      id,
      name,
      scope,
      scope_ref,
      active_version_id,
      created_at,
      prompt_versions!prompt_id (
        id,
        version,
        state,
        body,
        published_at,
        created_at
      )
    `,
    )
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`[prompt-resolver] listPrompts error: ${error.message}`);
  }

  return data ?? [];
}

/**
 * Upserts a global-scope prompt for a workspace.
 * Returns the prompt id — creates if missing, returns existing id otherwise.
 */
export async function upsertGlobalPrompt(
  workspaceId: string,
  name: string,
): Promise<string> {
  const supabase = svc();

  const { data, error } = await supabase
    .from("prompts")
    .upsert(
      { workspace_id: workspaceId, scope: "global", name },
      { onConflict: "workspace_id,scope,scope_ref" },
    )
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(
      `[prompt-resolver] upsertGlobalPrompt error: ${error?.message}`,
    );
  }

  return data.id as string;
}
