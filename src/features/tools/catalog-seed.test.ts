import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { registry } from "./index.ts";

// getEnabledTools() only offers a registered tool when a public.tools catalog
// row backs its tool_configs row, so a tool registered in code but never
// seeded by a migration is dead code: it can't be shown or enabled.
test("every registered tool has a public.tools seed in some migration", () => {
  const dir = new URL("../../../supabase/migrations/", import.meta.url);
  const seeds = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(new URL(f, dir), "utf8"))
    .filter((sql) => /INSERT INTO (public\.)?tools\b/i.test(sql))
    .join("\n");

  const missing = registry
    .list()
    .map((t) => t.name)
    .filter((name) => !seeds.includes(`('${name}'`));

  assert.deepEqual(missing, [], `tools without a catalog seed: ${missing.join(", ")}`);
});
