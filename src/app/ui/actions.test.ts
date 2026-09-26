import assert from "node:assert/strict";
import { test, mock } from "node:test";

const writes: string[] = [];
mock.module("fs/promises", {
  exports: {
    appendFile: async (path: string) => void writes.push(`append:${path}`),
    writeFile: async (path: string) => void writes.push(`write:${path}`),
    readFile: async () => "# UI Feedback",
  },
});
mock.module("fs", { exports: { existsSync: () => true } });

const { saveFeedback, getFeedback, clearFeedback } = await import("./actions.ts");
const env = process.env as Record<string, string | undefined>;

test("in production every action refuses and nothing touches the file", async () => {
  const previous = env.NODE_ENV;
  env.NODE_ENV = "production";
  try {
    writes.length = 0;
    await assert.rejects(() => saveFeedback("Botones", "feedback"), /only available in development/);
    await assert.rejects(() => getFeedback(), /only available in development/);
    await assert.rejects(() => clearFeedback(), /only available in development/);
    assert.deepEqual(writes, []);
  } finally {
    env.NODE_ENV = previous;
  }
});

test("in development the actions still work", async () => {
  const previous = env.NODE_ENV;
  env.NODE_ENV = "development";
  try {
    writes.length = 0;
    await saveFeedback("Botones", "más contraste");
    assert.equal(writes.length, 1);
    assert.equal(await getFeedback(), "# UI Feedback");
  } finally {
    env.NODE_ENV = previous;
  }
});
