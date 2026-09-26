import assert from "node:assert/strict";
import { test } from "node:test";

const { templateListItems, templateOfficialId, fetchYCloudTemplates } = await import(
  "./ycloud-client.ts"
);

function quietWarn<T>(fn: () => T): { result: T; warnings: unknown[][] } {
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

test("the template list is read from `items`, YCloud's paginated shape", () => {
  const { result, warnings } = quietWarn(() =>
    templateListItems({ offset: 0, limit: 100, items: [{ name: "a" }] }),
  );
  assert.deepEqual(result, [{ name: "a" }]);
  assert.equal(warnings.length, 0);
});

test("`records` still works, with a warning", () => {
  const { result, warnings } = quietWarn(() =>
    templateListItems({ records: [{ name: "b" }] }),
  );
  assert.deepEqual(result, [{ name: "b" }]);
  assert.equal(warnings.length, 1);
});

test("an unknown envelope syncs nothing and logs its keys, not its content", () => {
  const { result, warnings } = quietWarn(() =>
    templateListItems({ data: [{ name: "secret-name" }], total: 1 }),
  );
  assert.deepEqual(result, []);
  assert.equal(warnings.length, 1);
  assert.ok(!JSON.stringify(warnings).includes("secret-name"));
  assert.deepEqual(templateListItems(null), []);
});

test("Meta's template id comes from officialTemplateId, with id as the fallback", () => {
  assert.equal(
    templateOfficialId({ id: "yc_1", officialTemplateId: "1234567890" }),
    "1234567890",
  );
  assert.equal(templateOfficialId({ id: "987" }), "987");
  assert.equal(templateOfficialId({ officialTemplateId: "" }), null);
  assert.equal(templateOfficialId(undefined), null);
});

function withTemplatePages(pages: unknown[][], total?: number) {
  const urls: URL[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    const page = Number(url.searchParams.get("page"));
    return new Response(
      JSON.stringify({ items: pages[page - 1] ?? [], ...(total !== undefined ? { total } : {}) }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { urls, restore: () => (globalThis.fetch = original) };
}

const page = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ name: `t${from + i}` }));

test("only the workspace's WABA is listed, every page of it", async () => {
  const { urls, restore } = withTemplatePages([page(100), page(100, 100), page(20, 200)], 220);
  try {
    const result = await fetchYCloudTemplates("key", "waba_1");
    assert.equal(result.items.length, 220);
    assert.equal(result.truncated, false);
  } finally {
    restore();
  }
  assert.equal(urls.length, 3);
  for (const url of urls) {
    assert.equal(url.searchParams.get("filter.wabaId"), "waba_1");
    assert.equal(url.searchParams.get("limit"), "100");
  }
});

test("a list longer than the page cap is flagged as cut", async () => {
  const pages = Array.from({ length: 12 }, (_, i) => page(100, i * 100));
  const { restore } = withTemplatePages(pages, 1200);
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await fetchYCloudTemplates("key", "waba_1");
    assert.equal(result.items.length, 1000);
    assert.equal(result.truncated, true);
  } finally {
    console.warn = originalWarn;
    restore();
  }
});
