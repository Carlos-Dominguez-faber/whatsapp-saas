/**
 * AES-256-GCM symmetric encryption helper.
 * Key is loaded from ENCRYPTION_KEY env var (base64-encoded 32-byte key).
 * Key version is loaded from ENCRYPTION_KEY_VERSION (default: "v1").
 *
 * Ciphertext format: `enc:<version>:<ivB64>:<ciphertextB64>`
 * The `enc:` prefix makes encrypted values unambiguously distinguishable from
 * plaintext, which is what lets readers tolerate not-yet-migrated rows.
 *
 * Every call takes an `aad` (additional authenticated data) string that is
 * authenticated but not encrypted. Binding a ciphertext to its owner — e.g.
 * "<workspaceId>:<provider>" — means a blob copied from one tenant's row into
 * another's fails to decrypt instead of silently working.
 *
 * Usage:
 *   const cipher = await encrypt("plaintext", `${workspaceId}:ycloud`)
 *   const plain  = await decrypt(cipher, `${workspaceId}:ycloud`)
 */

const ALG = "AES-GCM";
const IV_BYTES = 12; // 96-bit IV recommended for GCM
const KEY_VERSION = process.env.ENCRYPTION_KEY_VERSION ?? "v1";
const PREFIX = "enc";

/** Copy a Buffer/Uint8Array into a plain ArrayBuffer so crypto.subtle accepts it. */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}

function getKeyMaterial(): ArrayBuffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY env var is not set");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32)
    throw new Error(
      `ENCRYPTION_KEY must be 32 bytes (got ${buf.length}). Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  return toArrayBuffer(buf);
}

let _cryptoKey: CryptoKey | null = null;

async function getCryptoKey(): Promise<CryptoKey> {
  if (_cryptoKey) return _cryptoKey;
  const raw = getKeyMaterial();
  _cryptoKey = await crypto.subtle.importKey("raw", raw, { name: ALG }, false, [
    "encrypt",
    "decrypt",
  ]);
  return _cryptoKey;
}

/** True when `value` was produced by {@link encrypt} (vs. a legacy plaintext value). */
export function isEncrypted(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(`${PREFIX}:`);
}

/** Encrypts a UTF-8 string, binding the ciphertext to `aad`. */
export async function encrypt(plaintext: string, aad: string): Promise<string> {
  const key = await getCryptoKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipherBuf = await crypto.subtle.encrypt(
    { name: ALG, iv, additionalData: new TextEncoder().encode(aad) },
    key,
    new TextEncoder().encode(plaintext),
  );
  const ivB64 = Buffer.from(iv).toString("base64");
  const ctB64 = Buffer.from(cipherBuf).toString("base64");
  return `${PREFIX}:${KEY_VERSION}:${ivB64}:${ctB64}`;
}

/**
 * Decrypts a ciphertext produced by {@link encrypt}. `aad` must match the value
 * used at encryption time or GCM authentication fails and this throws.
 */
export async function decrypt(
  ciphertext: string,
  aad: string,
): Promise<string> {
  const parts = ciphertext.split(":");
  if (parts.length !== 4 || parts[0] !== PREFIX)
    throw new Error("Invalid ciphertext format");
  const [, , ivB64, ctB64] = parts;
  const key = await getCryptoKey();
  const plainBuf = await crypto.subtle.decrypt(
    {
      name: ALG,
      iv: toArrayBuffer(Buffer.from(ivB64, "base64")),
      additionalData: new TextEncoder().encode(aad),
    },
    key,
    toArrayBuffer(Buffer.from(ctB64, "base64")),
  );
  return new TextDecoder().decode(plainBuf);
}
