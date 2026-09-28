import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { registry, sanitizeArgs, WRITE_TIMEOUT_ERROR } from "./registry.ts";
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

test("onStart runs before the tool, and its callId pairs it with onExecuted", async () => {
  const seen: string[] = [];
  let startId = "";
  registry.register({
    name: "test_write_ok",
    description: "test tool",
    sensitivity: "write",
    schema: z.object({}),
    enabledFor: () => true,
    run: async () => {
      seen.push("run");
      return { ok: true, output: null };
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
  try {
    await registry.run("test_write_ok", {}, ctx, {
      onStart: (s) => {
        seen.push(`start:${s.sensitivity}`);
        startId = s.callId;
      },
      onExecuted: (e) => {
        seen.push(`executed:${e.ok}`);
        assert.equal(e.callId, startId);
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(seen, ["start:write", "run", "executed:true"]);
});

test("a tool whose onStart throws never runs, and run() rejects with that error", async () => {
  const { callCount } = registerFailingTool("test_write_unrecorded", "write", 0);
  await assert.rejects(
    registry.run("test_write_unrecorded", {}, ctx, {
      onStart: () => {
        throw new Error("could not record the write");
      },
    }),
    /could not record the write/,
  );
  assert.equal(callCount(), 0);
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

test("a write tool that times out tells the model the outcome is unknown; a read tool keeps the plain error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
  const slow = (sensitivity: "read" | "write"): Tool => ({
    name: `slow_${sensitivity}`,
    description: "test tool",
    sensitivity,
    schema: z.object({}),
    enabledFor: () => true,
    run: () => new Promise(() => {}),
  });
  try {
    const executed: Array<boolean | null> = [];
    const write = await registry.runTool(slow("write"), {}, ctx, {
      timeoutMs: 20,
      onExecuted: (e) => {
        executed.push(e.ok);
      },
    });
    assert.equal(write.ok, false);
    assert.equal(write.error, WRITE_TIMEOUT_ERROR);
    assert.match(write.error ?? "", /No le digas al cliente que se hizo ni que falló/);
    assert.deepEqual(executed, [null], "reported as neither done nor failed");

    const read = await registry.runTool(slow("read"), {}, ctx, { timeoutMs: 20, retries: 0 });
    assert.equal(read.error, "Tool timeout");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a playground tool call is logged with no conversation, flagged, with who ran it", async () => {
  const originalFetch = globalThis.fetch;
  const inserts: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("/rest/v1/events") && init?.method === "POST") {
      inserts.push(JSON.parse(String(init.body)));
    }
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  const lookup: Tool = {
    name: "pg_lookup",
    description: "test tool",
    sensitivity: "read",
    schema: z.object({}),
    enabledFor: () => true,
    run: async () => ({ ok: true, output: null }),
  };
  try {
    await registry.runTool(lookup, {}, {
      workspaceId: "ws_1",
      conversationId: "",
      contactId: "",
      playground: { userId: "admin_1", userMessages: [] },
    });
    // The log is fire-and-forget: let it land.
    await new Promise((r) => setTimeout(r, 20));
    // Earlier tests' fire-and-forget logs may land here too: pick this one.
    const event = inserts.find(
      (e) => e.type === "tool_call" && (e.payload as { tool_name?: string }).tool_name === "pg_lookup",
    );
    assert.ok(event, "logged");
    assert.equal(event!.conversation_id, null);
    assert.equal((event!.payload as Record<string, unknown>).playground, true);
    assert.equal((event!.payload as Record<string, unknown>).user_id, "admin_1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a tool-call log the database refuses is reported, not swallowed", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warned: unknown[] = [];
  console.warn = (...args: unknown[]) => void warned.push(args);
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: "invalid input syntax for type uuid" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  const lookup: Tool = {
    name: "pg_lookup_2",
    description: "test tool",
    sensitivity: "read",
    schema: z.object({}),
    enabledFor: () => true,
    run: async () => ({ ok: true, output: null }),
  };
  try {
    await registry.runTool(lookup, {}, ctx);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(warned.some((w) => String((w as unknown[])[0]).includes("logToolCall failed")));
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
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
