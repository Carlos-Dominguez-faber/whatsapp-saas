#!/usr/bin/env node
// ============================================================================
// scripts/encrypt-credentials.mjs — encrypt existing integrations.credentials
//
// Installations created before credential encryption store API keys and signing
// secrets as plaintext in integrations.credentials. This walks every row and
// encrypts the plaintext values in place, using the same AES-256-GCM helper the
// app uses (src/shared/lib/crypto.ts — imported, not reimplemented).
//
// Idempotent: already-encrypted values are skipped, so re-running is a no-op.
// The app reads plaintext and ciphertext alike, so running this is safe at any
// time and nothing breaks if you never run it — but until you do, the secrets
// sit in the clear.
//
// Usage:
//   node scripts/encrypt-credentials.mjs --dry-run   # show what would change
//   node scripts/encrypt-credentials.mjs             # apply
//
// Config (env vars, falling back to .env.local):
//   NEXT_PUBLIC_SUPABASE_URL   Supabase project URL   (required)
//   SUPABASE_SERVICE_ROLE_KEY  service_role key       (required)
//   ENCRYPTION_KEY             base64 32-byte key     (required)
//
// Console output is Spanish (the member reads it); code is English.
// ============================================================================

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = resolve(ROOT, ".env.local");

const ok = (m) => console.log(`✅ ${m}`);
const log = (m) => console.log(m);
function fail(m) {
  console.error(`❌ ${m}`);
  process.exit(1);
}

function envFile() {
  if (!existsSync(ENV_PATH)) return {};
  const out = {};
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/\r$/, "");
  }
  return out;
}

const FILE = envFile();
const cfg = (k, fallback) => process.env[k] || FILE[k] || fallback;

const SUPABASE_URL = (cfg("NEXT_PUBLIC_SUPABASE_URL") || "").replace(
  /\/+$/,
  "",
);
const SERVICE_KEY = cfg("SUPABASE_SERVICE_ROLE_KEY");
const DRY_RUN = process.argv.includes("--dry-run");

if (!SUPABASE_URL || /your-/.test(SUPABASE_URL))
  fail("Falta NEXT_PUBLIC_SUPABASE_URL (corre setup.mjs env primero).");
if (!SERVICE_KEY || /your-/.test(SERVICE_KEY))
  fail("Falta SUPABASE_SERVICE_ROLE_KEY.");

// crypto.ts reads ENCRYPTION_KEY from process.env at call time — make sure the
// .env.local fallback is visible to it before importing.
process.env.ENCRYPTION_KEY = cfg("ENCRYPTION_KEY");
process.env.ENCRYPTION_KEY_VERSION = cfg("ENCRYPTION_KEY_VERSION", "v1");
if (!process.env.ENCRYPTION_KEY || /your-/.test(process.env.ENCRYPTION_KEY))
  fail("Falta ENCRYPTION_KEY (corre setup.mjs env primero).");

// Node 23.6+ strips TypeScript types natively, so the app's own helper is the
// single source of truth for the cipher — no duplicated crypto here. Importing
// a .ts file from a non-"type":"module" package emits a perf warning that would
// only confuse whoever runs this; suppress just that one.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const code = rest.find(
    (a) => typeof a === "string" && a.startsWith("MODULE_"),
  );
  const opts = rest.find((a) => a && typeof a === "object");
  if (code === "MODULE_TYPELESS_PACKAGE_JSON") return;
  if (opts?.code === "MODULE_TYPELESS_PACKAGE_JSON") return;
  return emitWarning(warning, ...rest);
};

const { encrypt, isEncrypted } = await import(
  resolve(ROOT, "src/shared/lib/crypto.ts")
);

const baseHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

async function call(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { ...baseHeaders, Prefer: "return=minimal" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) fail(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

log(
  DRY_RUN
    ? "🔍 Simulación (--dry-run): no se escribe nada.\n"
    : "🔐 Cifrando credenciales existentes...\n",
);

const rows = await call(
  "GET",
  "integrations?select=id,workspace_id,provider,credentials",
);

if (!rows.length) {
  ok("No hay integraciones. Nada que hacer.");
  process.exit(0);
}

let changed = 0;
let alreadyDone = 0;

for (const row of rows) {
  const creds = row.credentials ?? {};
  const aad = `${row.workspace_id}:${row.provider}`;
  const next = {};
  const encryptedKeys = [];

  for (const [key, value] of Object.entries(creds)) {
    if (typeof value !== "string" || value === "" || isEncrypted(value)) {
      next[key] = value;
      continue;
    }
    next[key] = await encrypt(value, aad);
    encryptedKeys.push(key);
  }

  if (!encryptedKeys.length) {
    alreadyDone++;
    continue;
  }

  log(`  ${row.provider} (workspace ${row.workspace_id})`);
  log(`    cifra: ${encryptedKeys.join(", ")}`);

  if (!DRY_RUN) {
    await call("PATCH", `integrations?id=eq.${row.id}`, { credentials: next });
  }
  changed++;
}

log("");
if (DRY_RUN) {
  ok(
    `${changed} integración(es) se cifrarían, ${alreadyDone} ya está(n) al día.`,
  );
  log("Corre el script sin --dry-run para aplicarlo.");
} else {
  ok(
    `${changed} integración(es) cifradas, ${alreadyDone} ya estaba(n) al día.`,
  );
  if (changed)
    log(
      "\n⚠️  A partir de ahora, NO cambies ENCRYPTION_KEY: invalidaría estas credenciales.",
    );
}
