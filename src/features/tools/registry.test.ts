import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { registry, sanitizeArgs } from "./registry.ts";
import type { Tool, ToolContext } from "./core/tool";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

const ctx: ToolContext = {
  workspaceId: "ws_1",
  conversationId: "conv_1",
  contactId: "contact_1",
};

function registerFailingTool(
  name: string,
  sensitivity: "read" | "write",
  failTimes: number,
): { callCount: () => number } {
  let calls = 0;
  const tool: Tool = {
    name,
    description: "test tool",
    sensitivity,
    schema: z.object({}),
    enabledFor: () => true,
    run: async () => {
      calls++;
      if (calls <= failTimes) throw new Error("boom");
      return { ok: true, output: { calls } };
    },
  };
  registry.register(tool);
  return { callCount: () => calls };
}

test("never retries a write tool, even when it throws", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(null, { status: 204 })) as typeof fetch;

  try {
    const { callCount } = registerFailingTool(
      "test_write_always_fails",
      "write",
      99,
    );

    const result = await registry.run("test_write_always_fails", {}, ctx, {
      retries: 3,
    });

    assert.equal(result.ok, false);
    assert.equal(callCount(), 1, "a write tool must be attempted exactly once");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("retries a non-write tool up to the configured retry count (pre-existing behavior)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(null, { status: 204 })) as typeof fetch;

  try {
    const { callCount } = registerFailingTool(
      "test_read_fails_twice",
      "read",
      2,
    );

    const result = await registry.run("test_read_fails_twice", {}, ctx, {
      retries: 2,
    });

    assert.equal(result.ok, true);
    assert.equal(
      callCount(),
      3,
      "should retry twice after the first failure, succeeding on the 3rd attempt",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runTool executes a Tool object directly, without it being registered", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(null, { status: 204 })) as typeof fetch;

  try {
    const unregisteredTool: Tool = {
      name: "never_registered",
      description: "test tool never added to the registry map",
      sensitivity: "read",
      schema: z.object({}),
      enabledFor: () => true,
      run: async () => ({ ok: true, output: "direct" }),
    };

    const result = await registry.runTool(unregisteredTool, {}, ctx);

    assert.equal(result.ok, true);
    assert.equal(result.output, "direct");
    assert.equal(
      registry.get("never_registered"),
      undefined,
      "runTool must not have registered the tool as a side effect",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sanitizeArgs redacts a key flagged sensitive by the tool, even without a matching secret-name pattern", () => {
  const result = sanitizeArgs(
    { codigo_cliente: "1234-5678", note: "hola" },
    ["codigo_cliente"],
  );
  assert.deepEqual(result, { codigo_cliente: "[REDACTED]", note: "hola" });
});

test("sanitizeArgs still redacts generic secret-shaped keys with no extra flags", () => {
  const result = sanitizeArgs({ api_token: "shh", city: "Santiago" });
  assert.deepEqual(result, { api_token: "[REDACTED]", city: "Santiago" });
});
