import assert from "node:assert/strict";
import { test } from "node:test";

const {
  templateListItems,
  templateOfficialId,
  fetchYCloudTemplates,
  resolveWabaId,
  WabaNotFoundError,
} = await import("./ycloud-client.ts");

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

function withPhoneNumberPages(pages: Array<Array<{ phoneNumber: string; wabaId: string }>>) {
  const urls: URL[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    const n = Number(url.searchParams.get("page"));
    const total = pages.reduce((sum, p) => sum + p.length, 0);
    return new Response(JSON.stringify({ items: pages[n - 1] ?? [], total }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { urls, restore: () => (globalThis.fetch = original) };
}

const numbers = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({
    phoneNumber: `+1555${String(from + i).padStart(7, "0")}`,
    wabaId: `waba_other_${from + i}`,
  }));

test("the WABA is the configured number's, even written as +52 when YCloud has +52 1", async () => {
  const { restore } = withPhoneNumberPages([
    [
      { phoneNumber: "+15550000001", wabaId: "waba_us" },
      { phoneNumber: "+5219981234567", wabaId: "waba_mx" },
    ],
  ]);
  try {
    assert.equal(await resolveWabaId("key", "+529981234567"), "waba_mx");
    assert.equal(await resolveWabaId("key", "998 123 4567"), "waba_mx", "national format");
  } finally {
    restore();
  }
});

test("the WABA lookup reads every page of numbers", async () => {
  const { urls, restore } = withPhoneNumberPages([
    numbers(100),
    [{ phoneNumber: "+5219981234567", wabaId: "waba_mx" }],
  ]);
  try {
    assert.equal(await resolveWabaId("key", "+529981234567"), "waba_mx");
  } finally {
    restore();
  }
  assert.equal(urls.length, 2);
});

test("a number not on the account throws: never another number's WABA", async () => {
  const { restore } = withPhoneNumberPages([[{ phoneNumber: "+15550000001", wabaId: "waba_us" }]]);
  try {
    await assert.rejects(resolveWabaId("key", "+529981234567"), WabaNotFoundError);
  } finally {
    restore();
  }
});
