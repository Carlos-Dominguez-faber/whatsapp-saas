import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { registry } from "./registry.ts";
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

test("normalizes empty-string conversationId/contactId (playground sentinel) to null before the tool ever sees them", async () => {
  const captured: { ctx: ToolContext | null } = { ctx: null };
  const tool: Tool = {
    name: "test_captures_ctx",
    description: "test tool that records the ctx it received",
    sensitivity: "write",
    schema: z.object({}),
    enabledFor: () => true,
    run: async (_args, receivedCtxArg) => {
      captured.ctx = receivedCtxArg;
      return { ok: true, output: null };
    },
  };
  registry.register(tool);

  const playgroundCtx: ToolContext = {
    workspaceId: "ws_1",
    conversationId: "",
    contactId: "",
  };
  const result = await registry.run("test_captures_ctx", {}, playgroundCtx);

  assert.equal(result.ok, true);
  assert.equal(captured.ctx?.conversationId, null);
  assert.equal(captured.ctx?.contactId, null);
});

test("leaves a real conversationId/contactId untouched", async () => {
  const captured: { ctx: ToolContext | null } = { ctx: null };
  const tool: Tool = {
    name: "test_captures_real_ctx",
    description: "test tool that records the ctx it received",
    sensitivity: "write",
    schema: z.object({}),
    enabledFor: () => true,
    run: async (_args, receivedCtxArg) => {
      captured.ctx = receivedCtxArg;
      return { ok: true, output: null };
    },
  };
  registry.register(tool);

  const result = await registry.run("test_captures_real_ctx", {}, ctx);

  assert.equal(result.ok, true);
  assert.equal(captured.ctx?.conversationId, "conv_1");
  assert.equal(captured.ctx?.contactId, "contact_1");
});
