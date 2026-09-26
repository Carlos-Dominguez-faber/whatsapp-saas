// Node ESM customization hook: resolves the "@/*" TypeScript path alias
// (tsconfig.json → "@/*": ["./src/*"]) at test-runtime, since plain
// `node --test` has no bundler to apply tsconfig `paths`. Only test files
// need this — the Next.js build already resolves the alias on its own.
import { existsSync } from "node:fs";
import path from "node:path";

const SRC_ROOT = new URL("../src/", import.meta.url);
const EXTENSIONS = [".ts", ".tsx", "/index.ts"];

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const rel = specifier.slice(2);
    const base = new URL(rel, SRC_ROOT);

    if (path.extname(base.pathname)) {
      return nextResolve(base.href, context);
    }

    for (const ext of EXTENSIONS) {
      const candidate = new URL(rel + ext, SRC_ROOT);
      if (existsSync(candidate)) {
        return nextResolve(candidate.href, context);
      }
    }

    throw new Error(`resolve-alias-hook: no file found for "${specifier}" under src/`);
  }

  // Sibling/relative TS imports written without an extension (the project's
  // own convention, e.g. `./cost-tracker` from decision-engine.ts) — Node's
  // ESM resolver requires the extension when there's no bundler to infer it.
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    !path.extname(specifier)
  ) {
    for (const ext of EXTENSIONS) {
      const candidate = new URL(specifier + ext, context.parentURL);
      if (existsSync(candidate)) {
        return nextResolve(candidate.href, context);
      }
    }
  }

  // Next.js subpath exports (next/server, next/headers, ...) have no
  // package.json "exports" map, so Node's ESM resolver — unlike Next's own
  // bundler — won't auto-append an extension to the extensionless specifier
  // these files use. Retry with ".js" before giving up.
  if (specifier.startsWith("next/") && !path.extname(specifier)) {
    try {
      return await nextResolve(`${specifier}.js`, context);
    } catch {
      // fall through to the original specifier's own error
    }
  }

  return nextResolve(specifier, context);
}
