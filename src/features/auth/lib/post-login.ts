/**
 * Where a person lands after signing in. Only /probar may be asked for (the
 * link an admin shares with someone who will test the agent); anything else,
 * a full URL included, lands in the inbox, so `next` can never send a login
 * to another site.
 */
export const PROBAR_PATH = "/probar";

export function postLoginPath(next: unknown): string {
  return next === PROBAR_PATH ? PROBAR_PATH : "/inbox";
}
