/**
 * True when a Supabase/PostgREST error means the SQL function itself does not
 * exist: PGRST202 (PostgREST cannot find it in its schema cache) or 42883
 * (Postgres: undefined_function).
 *
 * That is the signature of code deployed before `setup.mjs db-push`. Callers
 * use it to tell "the migration has not run yet" apart from a real database
 * error, so a missing function degrades instead of silencing the agent.
 */
export function isMissingFunctionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "PGRST202" || code === "42883";
}
