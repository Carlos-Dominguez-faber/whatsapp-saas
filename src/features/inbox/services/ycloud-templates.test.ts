import assert from "node:assert/strict";
import { test } from "node:test";

const { templateListItems, templateOfficialId } = await import(
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
