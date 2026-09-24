import assert from "node:assert/strict";
import { test, mock } from "node:test";

interface QueueEntry {
  data?: unknown;
  error?: unknown;
}

let toolConfigsQueue: QueueEntry[] = [];
let n8nToolsQueue: QueueEntry[] = [];

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

function reset() {
  toolConfigsQueue = [{ data: [] }];
  n8nToolsQueue = [{ data: [] }];
}

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
  assert.equal(tool.preferredTimeoutMs, 9000);
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
