/**
 * Encryption boundary for `integrations.credentials`.
 *
 * Every write to that column must go through {@link encryptCredentials} and
 * every read that needs a usable secret through {@link decryptCredentials}.
 * Values are encrypted individually (not the whole JSONB blob) so non-secret
 * bookkeeping keys stay greppable and the column keeps its object shape.
 *
 * Ciphertexts are bound to `<workspaceId>:<provider>`, so a row copied between
 * tenants or providers fails to decrypt rather than silently working.
 *
 * Reads tolerate plaintext: an installation that predates encryption keeps
 * working, and `scripts/encrypt-credentials.mjs` migrates it in place. Writes
 * are never tolerant — they always encrypt.
 */

import { encrypt, decrypt, isEncrypted } from "./crypto";

type Creds = Record<string, unknown> | null | undefined;

function aadFor(workspaceId: string, provider: string): string {
  return `${workspaceId}:${provider}`;
}

/** Encrypts every non-empty string value. Non-string values pass through. */
export async function encryptCredentials(
  creds: Creds,
  workspaceId: string,
  provider: string,
): Promise<Record<string, unknown>> {
  if (!creds) return {};
  const aad = aadFor(workspaceId, provider);
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(creds)) {
    if (typeof value !== "string" || value === "") {
      out[key] = value;
      continue;
    }
    // Already-encrypted values (e.g. a merge of stored + incoming) are kept
    // as-is instead of being double-wrapped.
    out[key] = isEncrypted(value) ? value : await encrypt(value, aad);
  }

  return out;
}

/**
 * Decrypts every encrypted string value; plaintext values pass through so
 * pre-migration rows keep working.
 *
 * A value that looks encrypted but fails to decrypt is a real problem (wrong
 * ENCRYPTION_KEY, or a blob moved between tenants), so it throws rather than
 * silently returning a broken credential to an outbound API call.
 */
export async function decryptCredentials(
  creds: Creds,
  workspaceId: string,
  provider: string,
): Promise<Record<string, unknown>> {
  if (!creds) return {};
  const aad = aadFor(workspaceId, provider);
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(creds)) {
    if (!isEncrypted(value)) {
      out[key] = value;
      continue;
    }
    try {
      out[key] = await decrypt(value, aad);
    } catch {
      throw new Error(
        `[integration-secrets] Could not decrypt "${key}" for workspace ${workspaceId}/${provider}. ` +
          `Check ENCRYPTION_KEY — rotating it invalidates every stored credential.`,
      );
    }
  }

  return out;
}
