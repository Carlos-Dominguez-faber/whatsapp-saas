import { z } from "zod";
import { decrypt, encrypt, isEncrypted } from "@/shared/lib/crypto";

/**
 * The auth header of an n8n tool is a secret: stored encrypted at rest with
 * the same AES-256-GCM helper as integration credentials, bound to its
 * workspace so a row copied to another workspace doesn't decrypt.
 */
export function n8nAuthAad(workspaceId: string): string {
  return `${workspaceId}:n8n_tool`;
}

export async function encryptN8nAuth(
  workspaceId: string,
  value: string,
): Promise<string> {
  return encrypt(value, n8nAuthAad(workspaceId));
}

/**
 * The stored value in clear. Rows written before encryption hold plaintext
 * (scripts/encrypt-credentials.mjs migrates them) and are returned as-is.
 * Throws when a ciphertext doesn't decrypt (e.g. ENCRYPTION_KEY changed).
 */
export async function decryptN8nAuth(
  workspaceId: string,
  stored: string,
): Promise<string> {
  return isEncrypted(stored) ? decrypt(stored, n8nAuthAad(workspaceId)) : stored;
}

/**
 * Header names the admin can't use for auth: they describe the request
 * itself, and letting a tool set them would break or smuggle it.
 */
const FORBIDDEN_AUTH_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-connection",
  "expect",
  "cookie",
]);

export function isAllowedAuthHeaderName(name: string): boolean {
  return !FORBIDDEN_AUTH_HEADERS.has(name.trim().toLowerCase());
}

/**
 * An auth header's value: no line breaks or other control characters, which
 * would let the value inject extra headers (or break the request) when sent.
 */
export const AUTH_HEADER_VALUE = z
  .string()
  .max(2000)
  .regex(
    /^[^\x00-\x08\x0a-\x1f\x7f]*$/,
    "El valor del header no puede tener saltos de línea ni caracteres de control",
  );
