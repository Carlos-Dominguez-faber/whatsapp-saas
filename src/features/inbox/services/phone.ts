/**
 * phone.ts — phone numbers as the app stores and compares them.
 *
 * Pure module (no `@/`, no Supabase) so it runs under `node --test`.
 */

/** Default country code when a workspace hasn't configured one (Mexico). */
export const DEFAULT_COUNTRY_CODE = "52";

/**
 * A phone value as read from config or JSON: strings as they are, finite
 * numbers as their digits, anything else null. Never throws.
 */
export function phoneString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Normalises a phone string to E.164 format.
 * - Trims whitespace and separators, prepends '+' if missing; `00` (the
 *   international prefix) counts as '+'.
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
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
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

/**
 * The digits of a number written WITH its country code — `+52 998…`,
 * `0052 998…`, or 11 to 15 digits not starting with a trunk `0` — or null for
 * a national number (`998 123 4567`, `(998) 123-4567`) or something that
 * isn't a number. A national number's country is a guess: `555 123 4567` is
 * Mexican in a workspace coded 52, and yet it may be a US line.
 */
export function internationalDigits(phone: string): string | null {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  let international: string | null = null;
  if (trimmed.startsWith("+")) international = digits;
  else if (digits.startsWith("00")) international = digits.slice(2);
  else if (digits.length >= 11 && !digits.startsWith("0")) international = digits;
  return international && international.length >= 8 && international.length <= 15
    ? international
    : null;
}

/**
 * Whether a number someone typed for one of the account's OWN WhatsApp lines
 * (settings) is `own`, as the provider lists it. With a country code, the
 * same line (samePhone); without one, its digits must end `own`'s — only
 * safe against the handful of lines one account has, never to find a
 * contact.
 */
export function matchesOwnNumber(typed: string, own: string): boolean {
  const international = internationalDigits(typed);
  if (international) return samePhone(`+${international}`, own);
  const national = typed.replace(/\D/g, "").replace(/^0+/, "");
  if (national.length < 7) return false;
  return [phoneKey(own), normalizePhone(own).slice(1)].some((digits) =>
    digits.endsWith(national),
  );
}

export type DestinationCheck =
  /** No number configured: nothing to compare. */
  | "unconfigured"
  /** Configured without a country code (or no destination): not enforced. */
  | "unenforced"
  | "match"
  | "mismatch";

/**
 * Whether an inbound event's destination is the workspace's configured
 * number. Enforced only when the configured number carries its own country
 * code: completing a national one with a guessed code could reject every
 * message of a correctly connected number.
 */
export function checkDestination(
  configured: unknown,
  destination: unknown,
): DestinationCheck {
  const configuredPhone = phoneString(configured);
  if (!configuredPhone) return "unconfigured";
  const international = internationalDigits(configuredPhone);
  const destinationPhone = phoneString(destination);
  if (!international || !destinationPhone) return "unenforced";
  return samePhone(`+${international}`, destinationPhone) ? "match" : "mismatch";
}

/**
 * The forms the same line can be stored in: E.164 plus, for Mexican and
 * Argentinian mobiles, the variant with (or without) the extra mobile digit.
 * For looking a number up where it was stored as written.
 */
export function phoneVariants(phone: string, defaultCountryCode?: string): string[] {
  const key = phoneKey(phone, defaultCountryCode);
  const variants = new Set([`+${key}`, normalizePhone(phone, defaultCountryCode)]);
  if (key.length === 12 && key.startsWith("52")) variants.add(`+521${key.slice(2)}`);
  if (key.length === 12 && key.startsWith("54")) variants.add(`+549${key.slice(2)}`);
  return [...variants];
}

/**
 * Digits of a national (significant) number, per country code: the lengths a
 * number written without its country code can have there. Countries not
 * listed have no known format.
 */
const NATIONAL_NUMBER_LENGTHS: Record<string, number[]> = {
  "1": [10], // United States, Canada, Dominican Republic…
  "34": [9], // Spain
  "51": [9], // Peru
  "52": [10], // Mexico
  "53": [8], // Cuba
  "54": [10], // Argentina
  "55": [10, 11], // Brazil
  "56": [9], // Chile
  "57": [10], // Colombia
  "58": [10], // Venezuela
  "502": [8], // Guatemala
  "503": [8], // El Salvador
  "504": [8], // Honduras
  "505": [8], // Nicaragua
  "506": [8], // Costa Rica
  "507": [8], // Panama
  "591": [8], // Bolivia
  "593": [9], // Ecuador
  "595": [9], // Paraguay
  "598": [8], // Uruguay
};

/**
 * The national number inside `digits` (written without a country code), or
 * null when no reading fits the country's lengths. Besides the number as
 * written, it tries it without what people put in front: the trunk `0`; in
 * Mexico the old mobile prefixes `044`/`045` and the `1` (as in `+52 1`); in
 * Argentina the mobile `9` (as in `+54 9`) and the `15` written after the
 * area code; in the US and Canada the `1`.
 */
function nationalNumber(digits: string, countryCode: string): string | null {
  const lengths = NATIONAL_NUMBER_LENGTHS[countryCode];
  if (!lengths) return null;
  const noTrunk = digits.replace(/^0/, "");
  const readings = [digits, noTrunk];
  if (countryCode === "52") {
    readings.push(digits.replace(/^04[45]/, ""), noTrunk.replace(/^1/, ""));
  }
  if (countryCode === "54") {
    readings.push(noTrunk.replace(/^9/, ""));
    // Area code (2 to 4 digits) + 15 + number: 12 digits.
    for (let at = 2; at <= 4; at++) {
      if (noTrunk.length === 12 && noTrunk.slice(at, at + 2) === "15") {
        readings.push(noTrunk.slice(0, at) + noTrunk.slice(at + 2));
      }
    }
  }
  if (countryCode === "1") readings.push(digits.replace(/^1/, ""));
  return readings.find((n) => lengths.includes(n.length)) ?? null;
}

/**
 * A number from another system (HighLevel) in E.164, or null when it can't be
 * placed with certainty. One written with `+` or `00` keeps its code. One
 * written without is read as a national number of the workspace's country
 * first (its length must fit, once the usual prefixes are dropped); failing
 * that, bare digits count as international only if they start with the
 * workspace's own country code. Anything else stays unmatched rather than
 * becoming a junk number.
 */
export function phoneWithCountryCode(
  phone: string,
  defaultCountryCode: string,
): string | null {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+") || digits.startsWith("00")) {
    const international = internationalDigits(trimmed);
    return international ? `+${international}` : null;
  }
  const national = nationalNumber(digits, defaultCountryCode);
  if (national) return `+${defaultCountryCode}${national}`;
  if (
    digits.startsWith(defaultCountryCode) &&
    nationalNumber(digits.slice(defaultCountryCode.length), defaultCountryCode)
  ) {
    return `+${digits}`;
  }
  return null;
}
