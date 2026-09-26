/**
 * phone.ts — phone numbers as the app stores and compares them.
 *
 * Pure module (no `@/`, no Supabase) so it runs under `node --test`.
 */

/** Default country code when a workspace hasn't configured one (Mexico). */
export const DEFAULT_COUNTRY_CODE = "52";

/**
 * Normalises a phone string to E.164 format.
 * - Trims whitespace and separators, prepends '+' if missing.
 * - When the number arrives WITHOUT a country code (no '+', national length
 *   ≤ 10 digits), prepends the workspace's `defaultCountryCode`.
 */
export function normalizePhone(
  phone: string,
  defaultCountryCode?: string,
): string {
  const trimmed = phone.trim().replace(/[\s\-().]/g, "");
  if (trimmed.startsWith("+")) return `+${trimmed.slice(1).replace(/\D/g, "")}`;
  const digits = trimmed.replace(/\D/g, "");
  if (defaultCountryCode && digits.length > 0 && digits.length <= 10) {
    return `+${defaultCountryCode}${digits}`;
  }
  return `+${digits}`;
}

/**
 * A key for deciding whether two numbers are the same line, whatever format
 * each system wrote it in. Compare keys, never raw strings.
 *
 * Besides formatting, two countries write the same mobile two ways:
 * - Mexico: `+52 1 998…` (the old mobile prefix, which WhatsApp still sends)
 *   and `+52 998…`.
 * - Argentina: `+54 9 11…` (WhatsApp) and `+54 11…`.
 * The key drops that digit, so both forms match in either direction.
 */
export function phoneKey(phone: string, defaultCountryCode?: string): string {
  let digits = normalizePhone(phone, defaultCountryCode).slice(1);
  if (digits.length === 13 && (digits.startsWith("521") || digits.startsWith("549"))) {
    digits = digits.slice(0, 2) + digits.slice(3);
  }
  return digits;
}

/** True when both numbers are the same line (see phoneKey). */
export function samePhone(
  a: string,
  b: string,
  defaultCountryCode?: string,
): boolean {
  return phoneKey(a, defaultCountryCode) === phoneKey(b, defaultCountryCode);
}
