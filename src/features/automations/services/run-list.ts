/**
 * The runs panel of the Automations tab: the workspace's automation runs,
 * newest first, with the rule and the contact each one acted on. Read with
 * the service role; the caller has already checked the member's role, and
 * every read is scoped to the workspace (the embeds follow the runs'
 * workspace-consistent references, so they can't reach another workspace).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export const RUN_FILTERS = ["all", "failed", "skipped", "done", "pending"] as const;
export type RunFilter = (typeof RUN_FILTERS)[number];

export const RUNS_PAGE_SIZE = 50;

export interface RunListItem {
  id: string;
  status: string;
  error: string | null;
  trigger_type: string;
  attempts: number;
  created_at: string;
  finished_at: string | null;
  conversation_id: string | null;
  rule: { name: string } | null;
  contact: { name: string | null; phone: string } | null;
}

/**
 * Where the next page starts: the last run shown. Runs expanded together share
 * created_at to the microsecond, so the id breaks the tie; a timestamp alone
 * would skip the rest of a batch cut by the page.
 */
export interface RunCursor {
  at: string;
  id: string;
}

export interface RunPage {
  runs: RunListItem[];
  /** Pass back as `before` / `beforeId` for the next page; null on the last one. */
  nextBefore: RunCursor | null;
}

export function parseRunFilter(value: string | null): RunFilter {
  return (RUN_FILTERS as readonly string[]).includes(value ?? "") ? (value as RunFilter) : "all";
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The cursor from the query string, or null. Both parts go into a filter, so
 * they're checked by shape (the timestamp keeps its microseconds: rounding
 * it would skip runs).
 */
export function parseCursor(at: string | null, id: string | null): RunCursor | null {
  if (!at || !id || !ISO_TIMESTAMP.test(at) || !UUID.test(id)) return null;
  return Number.isNaN(Date.parse(at)) ? null : { at, id };
}

export async function listAutomationRuns(
  db: SupabaseClient,
  workspaceId: string,
  opts: { filter: RunFilter; before: RunCursor | null },
): Promise<RunPage> {
  let query = db
    .from("automation_runs")
    .select(
      "id, status, error, trigger_type, attempts, created_at, finished_at, conversation_id, rule:automation_rules(name), contact:contacts(name, phone)",
    )
    .eq("workspace_id", workspaceId);
  if (opts.filter === "pending") query = query.in("status", ["pending", "processing"]);
  else if (opts.filter !== "all") query = query.eq("status", opts.filter);
  if (opts.before) {
    const { at, id } = opts.before;
    query = query.or(`created_at.lt.${at},and(created_at.eq.${at},id.lt.${id})`);
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(RUNS_PAGE_SIZE);
  if (error) throw new Error(`automation runs: ${error.message}`);

  const runs = (data ?? []) as unknown as RunListItem[];
  return {
    runs,
    nextBefore:
      runs.length === RUNS_PAGE_SIZE
        ? { at: runs[runs.length - 1].created_at, id: runs[runs.length - 1].id }
        : null,
  };
}
