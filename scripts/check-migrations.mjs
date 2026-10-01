#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────────────────
// Checks the migrations a branch adds against its base branch (CI runs it on
// every pull request, see .github/workflows/migrations.yml):
//
//   1. every new file is named <14-digit version>_<name>.sql;
//   2. its version is newer than the newest migration on the base branch's tip.
//      An older one is skipped by `supabase db push` on every install already
//      at the base (it would need --include-all, which installs don't run);
//   3. no two migrations end up sharing a version.
//
// Usage: node scripts/check-migrations.mjs [base-ref]   (default: origin/main)
// ──────────────────────────────────────────────────────────────────────────────
import { execFileSync } from "node:child_process";

const DIR = "supabase/migrations";
const VERSION = /^\d{14}$/;
const base = process.argv[2] || process.env.BASE_REF || "origin/main";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const lines = (out) => (out ? out.split("\n") : []);
const sqlFiles = (paths) => paths.filter((p) => p.endsWith(".sql"));
const versionOf = (path) => path.split("/").pop().split("_")[0];

const baseFiles = sqlFiles(lines(git("ls-tree", "--name-only", base, `${DIR}/`)));
const headFiles = sqlFiles(lines(git("ls-tree", "--name-only", "HEAD", `${DIR}/`)));
// Three dots: only what this branch added since it left the base, not what
// the base gained in the meantime.
const added = sqlFiles(
  lines(git("diff", "--name-only", "--diff-filter=A", `${base}...HEAD`, "--", DIR)),
);

const newest = baseFiles.map(versionOf).filter((v) => VERSION.test(v)).sort().at(-1) ?? "";
const errors = [];

for (const file of added) {
  const version = versionOf(file);
  if (!VERSION.test(version)) {
    errors.push(`${file}: el nombre debe empezar con 14 dígitos (AAAAMMDDhhmmss_nombre.sql).`);
  } else if (version <= newest) {
    errors.push(
      `${file}: la versión ${version} no es mayor que la última de ${base} (${newest}). ` +
        "Renómbrala con un timestamp más nuevo: si no, `supabase db push` la salta en las instalaciones que ya están al día.",
    );
  }
}

const seen = new Map();
for (const file of headFiles) {
  const version = versionOf(file);
  if (seen.has(version)) {
    errors.push(`${file} y ${seen.get(version)} comparten la versión ${version}.`);
  } else {
    seen.set(version, file);
  }
}

if (errors.length > 0) {
  console.error(`❌ Migraciones: ${errors.length} problema(s) contra ${base}:`);
  for (const e of errors) console.error(`   - ${e}`);
  process.exit(1);
}
console.log(
  `✅ Migraciones: ${added.length} nueva(s), todas posteriores a ${newest || "(ninguna)"} en ${base}.`,
);
