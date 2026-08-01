#!/usr/bin/env node
// ============================================================================
// scripts/setup.mjs — deterministic installer orchestrator (Node-only, no deps)
//
// The agent (see INSTALAR.md) invokes these subcommands for the mechanical work
// and keeps the interactive bits (asking for keys, vercel login, deploy) to
// itself. Console output is Spanish (the member reads it); code is English.
//
// Commands:
//   env            Generate secrets + write/update .env.local from pasted keys
//   db-push [ref]  supabase link (ref derived from the URL) + db push
//   set-app-url U  Set NEXT_PUBLIC_APP_URL to the prod URL (run after deploy)
//   cron-sql       Fill supabase/cron/schedule-buffer-flush.sql with real values
//   vercel-env     Push .env.local vars to Vercel production (best effort)
//   doctor         Check prerequisites + which keys are still missing
//   help           Show this usage
// ============================================================================

import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = resolve(ROOT, ".env.local");
const EXAMPLE_PATH = resolve(ROOT, ".env.local.example");
const CRON_TPL = resolve(ROOT, "supabase/cron/schedule-buffer-flush.sql");
const CRON_FILLED = resolve(ROOT, "supabase/cron/schedule-buffer-flush.filled.sql");
const SUPABASE_API = "https://api.supabase.com"; // Management API base

// Secrets we generate locally — never asked for, never rotated on re-run.
const GENERATED = {
  ENCRYPTION_KEY: () => randomBytes(32).toString("base64"),
  BUFFER_PROCESS_SECRET: () => randomBytes(32).toString("hex"),
  CRON_SECRET: () => randomBytes(32).toString("hex"),
};

// Keys the member pastes; the agent passes them as same-named env vars.
const PASTED = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_DEFAULT_MODEL",
];
// NOTE: Kapso is NOT an env var — each workspace's API key + webhook signing
// secret live in the app (Settings → Integraciones), encrypted per-tenant.

// ── tiny ui helpers ─────────────────────────────────────────────────────────
const log = (m) => console.log(m);
const ok = (m) => console.log(`✅ ${m}`);
const warn = (m) => console.log(`⚠️  ${m}`);
function fail(m) {
  console.error(`❌ ${m}`);
  process.exit(1);
}

// A value is a placeholder if it is empty or still carries the example "your-" hint.
// Generated base64/hex secrets never contain "your-", so re-runs keep them intact.
const isPlaceholder = (v) => !v || v.trim() === "" || /your-/.test(v);

// ── .env parsing / writing ──────────────────────────────────────────────────
function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/\r$/, "");
  }
  return out;
}

function readEnvFile(path) {
  return existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
}

// Rewrite .env.local in place, preserving comments/structure from the template,
// replacing only the KEY=value lines we have a final value for.
function rewriteEnv(finalValues) {
  const base = existsSync(ENV_PATH) ? ENV_PATH : EXAMPLE_PATH;
  if (!existsSync(base)) fail(`No encuentro ${base}. ¿Estás en la raíz del repo?`);
  const seen = new Set();
  const lines = readFileSync(base, "utf8").split("\n").map((line) => {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && finalValues[m[1]] !== undefined) {
      seen.add(m[1]);
      return `${m[1]}=${finalValues[m[1]]}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(finalValues)) {
    if (!seen.has(k)) lines.push(`${k}=${v}`);
  }
  writeFileSync(ENV_PATH, lines.join("\n"));
}

// ── shell helpers ───────────────────────────────────────────────────────────
function run(cmd, opts = {}) {
  log(`$ ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: "inherit", ...opts });
}

function hasCli(name) {
  try {
    execSync(`command -v ${name}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function ensureCli(name, hint) {
  if (!hasCli(name)) fail(`Falta el CLI "${name}". Instálalo: ${hint}`);
}

// Derive the Supabase project ref from the project URL.
// https://abcdefghijkl.supabase.co  ->  abcdefghijkl
function deriveRef(url) {
  const m = /^https:\/\/([a-z0-9]+)\.supabase\./i.exec(url || "");
  return m ? m[1] : null;
}

// ── Supabase Management API (optional automation — needs SUPABASE_ACCESS_TOKEN) ─
const mgmtToken = () => process.env.SUPABASE_ACCESS_TOKEN || "";

async function mgmtCall(method, path, body) {
  const res = await fetch(`${SUPABASE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${mgmtToken()}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, ok: res.ok, data };
}

const remoteSql = (ref, query) =>
  mgmtCall("POST", `/v1/projects/${ref}/database/query`, { query });

// Shared cron inputs: prod URL + CRON_SECRET, validated (fails if not ready).
function cronInputs() {
  const env = readEnvFile(ENV_PATH);
  const appUrl = (env.NEXT_PUBLIC_APP_URL || "").replace(/\/+$/, "");
  const secret = env.CRON_SECRET;
  if (isPlaceholder(appUrl) || /localhost/.test(appUrl)) {
    fail("NEXT_PUBLIC_APP_URL no es una URL de prod. Corre set-app-url <url> después del deploy.");
  }
  if (isPlaceholder(secret)) fail("CRON_SECRET no generado. Corre 'env' primero.");
  return { env, appUrl, secret };
}

function fillCronSql(appUrl, secret) {
  if (!existsSync(CRON_TPL)) fail(`No encuentro la plantilla ${CRON_TPL}`);
  return readFileSync(CRON_TPL, "utf8")
    .replaceAll("__APP_URL__", appUrl)
    .replaceAll("__CRON_SECRET__", secret);
}

// ── commands ────────────────────────────────────────────────────────────────
function cmdEnv() {
  const current = readEnvFile(existsSync(ENV_PATH) ? ENV_PATH : EXAMPLE_PATH);
  const final = {};

  // Generated secrets: keep if already real, generate only when placeholder.
  let generatedCount = 0;
  for (const [k, gen] of Object.entries(GENERATED)) {
    if (isPlaceholder(current[k])) {
      final[k] = gen();
      generatedCount++;
    } else {
      final[k] = current[k];
    }
  }
  // Encryption key version default.
  final.ENCRYPTION_KEY_VERSION = isPlaceholder(current.ENCRYPTION_KEY_VERSION)
    ? "v1"
    : current.ENCRYPTION_KEY_VERSION;

  // Pasted keys: take them from the environment when provided & non-placeholder.
  for (const k of PASTED) {
    const v = process.env[k];
    if (v && !isPlaceholder(v)) final[k] = v;
  }

  rewriteEnv(final);
  ok(`.env.local escrito. ${generatedCount} secret(s) generado(s) este run.`);

  // Report what is still missing so the agent knows what to ask next.
  const after = readEnvFile(ENV_PATH);
  const pending = PASTED.filter((k) => isPlaceholder(after[k]));
  if (pending.length) {
    warn(`Faltan estas keys por pegar: ${pending.join(", ")}`);
  } else {
    ok("Todas las keys requeridas están presentes.");
  }
  log("➡️  NEXT_PUBLIC_APP_URL se setea después del deploy con: set-app-url <url>");
}

function cmdDbPush(args) {
  ensureCli("supabase", "https://supabase.com/docs/guides/cli");
  const env = readEnvFile(ENV_PATH);
  const ref = args[0] || deriveRef(env.NEXT_PUBLIC_SUPABASE_URL);
  if (!ref) {
    fail("No pude derivar el project-ref desde NEXT_PUBLIC_SUPABASE_URL. Pásalo: db-push <ref>");
  }
  log(`Linking Supabase project: ${ref}`);
  log("(Si pide la DB password y corres esto sin interacción, exporta SUPABASE_DB_PASSWORD primero.)");
  run(`supabase link --project-ref ${ref}`);
  run("supabase db push");
  ok("Migraciones aplicadas (incluye pg_cron + pg_net).");
  log("➡️  Después del deploy: set-app-url <url> y luego cron-sql para agendar el buffer-flush.");
}

function cmdSetAppUrl(args) {
  let url = args[0];
  if (!url) fail("Uso: set-app-url https://tu-app.vercel.app");
  url = url.replace(/\/+$/, ""); // strip trailing slash
  if (!/^https:\/\//.test(url)) fail("La URL debe empezar con https://");
  rewriteEnv({ NEXT_PUBLIC_APP_URL: url });
  ok(`NEXT_PUBLIC_APP_URL = ${url}`);
  log("➡️  Acuérdate de setear esta misma URL en Vercel (vercel-env) y en Supabase → Auth → Site URL.");
}

function cmdCronSql() {
  const { appUrl, secret } = cronInputs();
  const filled = fillCronSql(appUrl, secret);
  writeFileSync(CRON_FILLED, filled);
  ok(`SQL del cron generado: ${CRON_FILLED}`);
  log("➡️  Pega el siguiente SQL en Supabase → SQL Editor → Run:\n");
  log(filled);
}

async function cmdCronApply() {
  const { env, appUrl, secret } = cronInputs();
  const ref = deriveRef(env.NEXT_PUBLIC_SUPABASE_URL);
  if (!ref) fail("No pude derivar el project-ref de NEXT_PUBLIC_SUPABASE_URL.");
  if (!mgmtToken()) {
    warn("Sin SUPABASE_ACCESS_TOKEN — usa el camino manual:");
    log("   node scripts/setup.mjs cron-sql   (y pega el SQL en el SQL Editor)");
    return;
  }
  const r1 = await remoteSql(ref, fillCronSql(appUrl, secret));
  if (!r1.ok) fail(`No pude agendar el cron ${r1.status}: ${JSON.stringify(r1.data)}`);
  const r2 = await remoteSql(
    ref,
    "select jobname, schedule, active from cron.job where jobname = 'buffer-flush';",
  );
  ok("Cron buffer-flush agendado vía Management API.");
  log(`Verificación: ${JSON.stringify(r2.data)}`);
}

async function cmdSiteUrl() {
  const env = readEnvFile(ENV_PATH);
  const appUrl = (env.NEXT_PUBLIC_APP_URL || "").replace(/\/+$/, "");
  if (isPlaceholder(appUrl) || /localhost/.test(appUrl)) {
    fail("NEXT_PUBLIC_APP_URL no es prod. Corre set-app-url <url> primero.");
  }
  const ref = deriveRef(env.NEXT_PUBLIC_SUPABASE_URL);
  if (!ref) fail("No pude derivar el project-ref de NEXT_PUBLIC_SUPABASE_URL.");
  if (!mgmtToken()) {
    warn("Sin SUPABASE_ACCESS_TOKEN — hazlo manual en Supabase → Authentication → URL Configuration:");
    log(`   Site URL     = ${appUrl}`);
    log(`   Redirect URL = ${appUrl}/**`);
    return;
  }
  const res = await mgmtCall("PATCH", `/v1/projects/${ref}/config/auth`, {
    site_url: appUrl,
    uri_allow_list: `${appUrl}/**`,
  });
  if (!res.ok) fail(`Management API (config/auth) falló ${res.status}: ${JSON.stringify(res.data)}`);
  ok(`Site URL = ${appUrl} · Redirect = ${appUrl}/** (vía Management API)`);
}

function cmdVercelEnv() {
  ensureCli("vercel", "npm i -g vercel");
  const env = readEnvFile(ENV_PATH);
  const skip = new Set(["NODE_ENV"]);
  const pushed = [];
  const failed = [];
  for (const [k, v] of Object.entries(env)) {
    if (skip.has(k) || isPlaceholder(v)) continue;
    // Don't push a localhost APP_URL to prod — set-app-url runs after deploy.
    if (k === "NEXT_PUBLIC_APP_URL" && /localhost/.test(v)) continue;
    try {
      execSync(`vercel env add ${k} production`, {
        cwd: ROOT,
        input: `${v}\n`,
        stdio: ["pipe", "ignore", "ignore"],
      });
      pushed.push(k);
    } catch {
      failed.push(k); // most commonly: the var already exists in Vercel
    }
  }
  ok(`Vars enviadas a Vercel production: ${pushed.join(", ") || "(ninguna)"}`);
  if (failed.length) {
    warn(`No se pudieron agregar (probablemente ya existen): ${failed.join(", ")}`);
    log("   Revísalas/actualízalas en el dashboard de Vercel → Settings → Environment Variables.");
  }
  log("➡️  Tras esto, redeploy con: vercel --prod");
}

function cmdDoctor() {
  log("── Prerequisitos ──");
  for (const [cli, hint] of [
    ["node", "https://nodejs.org"],
    ["supabase", "https://supabase.com/docs/guides/cli"],
    ["vercel", "npm i -g vercel"],
  ]) {
    log(`${hasCli(cli) ? "✅" : "❌"} ${cli}${hasCli(cli) ? "" : `  (instala: ${hint})`}`);
  }
  log("\n── .env.local ──");
  if (!existsSync(ENV_PATH)) {
    warn("No existe todavía. Corre: node scripts/setup.mjs env");
    return;
  }
  const env = readEnvFile(ENV_PATH);
  const required = [...Object.keys(GENERATED), ...PASTED];
  for (const k of required) {
    log(`${isPlaceholder(env[k]) ? "❌" : "✅"} ${k}`);
  }
  const appReady = !isPlaceholder(env.NEXT_PUBLIC_APP_URL) && !/localhost/.test(env.NEXT_PUBLIC_APP_URL || "");
  log(`${appReady ? "✅" : "⏳"} NEXT_PUBLIC_APP_URL${appReady ? "" : "  (se setea post-deploy)"}`);
}

function usage() {
  log(`setup.mjs — orquestador de instalación (Node puro, sin deps)

Uso: node scripts/setup.mjs <comando>

  env            Genera secrets + escribe .env.local desde las keys pegadas
  db-push [ref]  supabase link (ref derivado de la URL) + db push
  set-app-url U  Setea NEXT_PUBLIC_APP_URL a la URL de prod (post-deploy)
  cron-sql       Imprime el SQL del cron para pegar en el SQL Editor (manual)
  cron-apply     Agenda el cron vía Management API (necesita SUPABASE_ACCESS_TOKEN)
  site-url       Setea Site URL + Redirect en Supabase vía Management API (idem)
  vercel-env     Empuja las vars de .env.local a Vercel production
  doctor         Revisa prerequisitos y qué keys faltan
  help           Muestra esta ayuda

Las keys pegadas se pasan como variables de entorno, p.ej.:
  NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/setup.mjs env

site-url / cron-apply usan un token de Management API (NO se guarda en .env.local):
  SUPABASE_ACCESS_TOKEN=sbp_... node scripts/setup.mjs site-url`);
}

// ── dispatch ────────────────────────────────────────────────────────────────
const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "env":
    cmdEnv();
    break;
  case "db-push":
    cmdDbPush(args);
    break;
  case "set-app-url":
    cmdSetAppUrl(args);
    break;
  case "cron-sql":
    cmdCronSql();
    break;
  case "cron-apply":
    await cmdCronApply();
    break;
  case "site-url":
    await cmdSiteUrl();
    break;
  case "vercel-env":
    cmdVercelEnv();
    break;
  case "doctor":
    cmdDoctor();
    break;
  case "help":
  case undefined:
    usage();
    break;
  default:
    fail(`Comando desconocido: ${cmd}\nCorre: node scripts/setup.mjs help`);
}
