import assert from "node:assert/strict";
import { test, mock } from "node:test";

interface QueueEntry {
  data?: unknown;
  error?: unknown;
}

let toolConfigsQueue: QueueEntry[] = [];
let n8nToolsQueue: QueueEntry[] = [];
let eventInserts: Array<Record<string, unknown>> = [];

process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

const fakeClient = {
  from(table: string) {
    if (table === "tool_configs") {
      return {
        select: () => ({
          eq: () => ({
            eq: () => Promise.resolve(toolConfigsQueue.shift() ?? { data: [] }),
          }),
        }),
      };
    }
    if (table === "n8n_tools") {
      return {
        select: () => ({
          eq: () => ({
            eq: () => Promise.resolve(n8nToolsQueue.shift() ?? { data: [] }),
          }),
        }),
      };
    }
    if (table === "events") {
      const chain = {
        select: () => chain,
        eq: () => chain,
        gte: () => chain,
        contains: () => chain,
        limit: () => Promise.resolve({ data: [], error: null }),
        insert: (row: Record<string, unknown>) => {
          eventInserts.push(row);
          return Promise.resolve({ error: null });
        },
      };
      return chain;
    }
    throw new Error(`unexpected table: ${table}`);
  },
};

mock.module("@supabase/supabase-js", {
  exports: { createClient: () => fakeClient },
});

// Registers the real static tools (echo, schedule-*, etc.) into the shared
// registry singleton — mirrors production, where openrouter.ts imports this
// module before getEnabledTools ever runs. Without it registry.list() is
// empty and getStaticEnabledTools() can never return "echo".
await import("../index.ts");
const { getEnabledTools } = await import("./tool-configs.ts");

const { encrypt } = await import("@/shared/lib/crypto");

function reset() {
  toolConfigsQueue = [{ data: [] }];
  n8nToolsQueue = [{ data: [] }];
  eventInserts = [];
}

const n8nRow = {
  id: "row_1",
  workspace_id: "ws_1",
  name: "n8n_catalog",
  description: "Consulta el catálogo",
  mode: "sync",
  sensitivity: "read",
  webhook_url: "https://hooks.example/catalog",
  auth_header_name: null,
  auth_header_value: null,
  parameters: [],
  timeout_ms: 8000,
  enabled: true,
};

test("returns an empty list when nothing is enabled", async () => {
  reset();
  const tools = await getEnabledTools("ws_1");
  assert.deepEqual(tools, []);
});

test("includes a synthetic Tool per enabled n8n_tools row, with the right schema and metadata", async () => {
  reset();
  n8nToolsQueue = [
    {
      data: [
        {
          id: "row_1",
          workspace_id: "ws_1",
          name: "n8n_catalog",
          description: "Consulta el catálogo",
          mode: "sync",
          sensitivity: "read",
          webhook_url: "https://hooks.example/catalog",
          auth_header_name: null,
          auth_header_value: null,
          parameters: [
            { key: "query", label: "Query", type: "string", required: true, description: "d" },
          ],
          timeout_ms: 9000,
          enabled: true,
        },
      ],
    },
  ];

  const tools = await getEnabledTools("ws_1");
  assert.equal(tools.length, 1);
  const [tool] = tools;
  assert.equal(tool.name, "n8n_catalog");
  assert.equal(tool.sensitivity, "read");
  // 500ms margin over the row's timeout_ms so the external registry timeout
  // never wins the race against the internal fetchPinned deadline — see the
  // comment on EXTERNAL_TIMEOUT_MARGIN_MS in tool-configs.ts.
  assert.equal(tool.preferredTimeoutMs, 9500);
  assert.deepEqual(tool.sensitiveArgKeys, []);
  assert.equal(tool.schema.safeParse({ query: "x" }).success, true);
  assert.equal(tool.schema.safeParse({}).success, false);
});

test("a static tool and a dynamic n8n tool coexist in the same list", async () => {
  reset();
  toolConfigsQueue = [
    { data: [{ tool: { key: "echo" }, enabled: true, config: null }] },
  ];
  n8nToolsQueue = [
    {
      data: [
        {
          id: "row_1",
          workspace_id: "ws_1",
          name: "n8n_ticket",
          description: "Crea un ticket",
          mode: "async",
          sensitivity: "write",
          webhook_url: "https://hooks.example/ticket",
          auth_header_name: "Authorization",
          auth_header_value: "Bearer x",
          parameters: [],
          timeout_ms: 5000,
          enabled: true,
        },
      ],
    },
  ];

  const tools = await getEnabledTools("ws_1");
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["echo", "n8n_ticket"]);
});

test("leaves out an n8n tool named like a built-in tool, and records it once a day", async () => {
  reset();
  n8nToolsQueue = [{ data: [{ ...n8nRow, id: "row_x", name: "schedule_highlevel" }] }];
  const tools = await getEnabledTools("ws_1");
  assert.deepEqual(tools.map((t) => t.name), []);
  assert.equal(eventInserts.length, 1);
  assert.equal(eventInserts[0].type, "n8n_tool_name_collision");
});

test("an encrypted auth header reaches the runner in clear", async () => {
  reset();
  const stored = await encrypt("Bearer s3cret", "ws_1:n8n_tool");
  n8nToolsQueue = [
    { data: [{ ...n8nRow, auth_header_name: "Authorization", auth_header_value: stored }] },
  ];
  const tools = await getEnabledTools("ws_1");
  assert.equal(tools.length, 1);
  // The row's workspace mismatch check runs before any network call, so a
  // foreign ctx proves the tool was built without an auth error.
  const result = await tools[0].run({}, {
    workspaceId: "ws_other",
    conversationId: "c",
    contactId: "k",
  });
  assert.match(result.error ?? "", /workspace/);
});

test("an auth header encrypted for another workspace makes the tool refuse to run", async () => {
  reset();
  const stored = await encrypt("Bearer s3cret", "ws_OTHER:n8n_tool");
  n8nToolsQueue = [
    { data: [{ ...n8nRow, auth_header_name: "Authorization", auth_header_value: stored }] },
  ];
  const tools = await getEnabledTools("ws_1");
  assert.equal(tools.length, 1);
  const result = await tools[0].run({}, {
    workspaceId: "ws_1",
    conversationId: "c",
    contactId: "k",
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /header de autenticación/);
});
