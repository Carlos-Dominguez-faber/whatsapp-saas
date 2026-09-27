/**
 * True when a Supabase/PostgREST error means the SQL function `fnName` does not
 * exist yet — the signature of code deployed before `setup.mjs db-push`.
 * Callers use it to degrade instead of silencing the agent.
 *
 * PostgREST answers PGRST202 in two cases: the function is missing, or it
 * exists with other parameter names. In the second case its hint names the
 * same function with its parameters ("Perhaps you meant to call the function
 * public.fn(a, b)"); that is a code bug, not a pending migration, so it does
 * not count. 42883 is Postgres' own undefined_function.
 */
export function isMissingFunctionError(
  error: unknown,
  fnName: string,
  opts: {
    /**
     * Also count a PGRST202 whose hint names `fnName` with other parameters:
     * an older version of the function is installed and the migration that
     * replaces it hasn't run yet. Only for functions known to have shipped
     * with another signature (e.g. #9's 4-parameter
     * upsert_batch_and_link_message).
     */
    acceptOtherSignature?: boolean;
  } = {},
): boolean {
  const e = error as { code?: unknown; message?: unknown; hint?: unknown } | null;
  if (!e) return false;
  if (e.code === "42883") {
    return typeof e.message === "string" && e.message.includes(fnName);
  }
  if (e.code !== "PGRST202") return false;
  if (opts.acceptOtherSignature) return true;
  const hint = typeof e.hint === "string" ? e.hint : "";
  return !hint.includes(`.${fnName}(`);
}

const reported = new Set<string>();

/**
 * Logs, once per server instance, that `fnName` is missing and which fallback
 * is in use — at error level, so it stands out in the Vercel logs.
 */
export function reportMissingFunctionOnce(fnName: string, fallback: string): void {
  if (reported.has(fnName)) return;
  reported.add(fnName);
  console.error(
    `[db] ${fnName} is missing — run \`setup.mjs db-push\`. Until then: ${fallback}`,
  );
}
