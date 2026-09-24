import assert from "node:assert/strict";
import { test, mock } from "node:test";
import type { ToolContext } from "../core/tool";

let validateImpl: (url: string) => Promise<{ error: string | null; resolvedIp?: string }>;
let fetchPinnedCalls: Array<{
  url: string;
  resolvedIp: string;
  opts: { method: string; headers: Record<string, string>; body?: string; timeoutMs: number; maxResponseBytes?: number };
}>;
let fetchPinnedImpl: () => Promise<{ status: number; bodyText: string; truncated: boolean }>;

mock.module("../services/ssrf-guard.ts", {
  exports: {
    validateWebhookUrl: (url: string) => validateImpl(url),
    fetchPinned: (
      url: string,
      resolvedIp: string,
      opts: { method: string; headers: Record<string, string>; body?: string; timeoutMs: number; maxResponseBytes?: number },
    ) => {
      fetchPinnedCalls.push({ url, resolvedIp, opts });
      return fetchPinnedImpl();
    },
  },
});

const { buildN8nToolRun } = await import("./n8n-tool-runner.ts");

const ctx: ToolContext = {
  workspaceId: "ws_1",
  conversationId: "conv_1",
  contactId: "contact_1",
};

const baseRow = {
  id: "tool_1",
  workspace_id: "ws_1",
  name: "n8n_catalog",
  description: "test",
  webhook_url: "https://hooks.example/catalog",
  auth_header_name: null as string | null,
  auth_header_value: null as string | null,
  parameters: [],
  timeout_ms: 8000,
  enabled: true,
};

function reset() {
  fetchPinnedCalls = [];
  validateImpl = async () => ({ error: null, resolvedIp: "8.8.8.8" });
  fetchPinnedImpl = async () => ({ status: 200, bodyText: "{}", truncated: false });
}

test("rejects when the row's workspace_id does not match ctx.workspaceId", async () => {
  reset();
  const run = buildN8nToolRun({ ...baseRow, mode: "sync", sensitivity: "read", workspace_id: "ws_OTHER" });
  const result = await run({}, ctx);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /workspace/);
  assert.equal(fetchPinnedCalls.length, 0, "must never call the webhook for a mismatched workspace");
});

test("returns the SSRF error and never calls fetchPinned when the URL fails validation", async () => {
  reset();
  validateImpl = async () => ({ error: "Cannot resolve hostname" });
  const run = buildN8nToolRun({ ...baseRow, mode: "sync", sensitivity: "read" });
  const result = await run({}, ctx);
  assert.deepEqual(result, { ok: false, output: null, error: "Cannot resolve hostname" });
  assert.equal(fetchPinnedCalls.length, 0);
});

test("sync mode parses a JSON body and returns it as output", async () => {
  reset();
  fetchPinnedImpl = async () => ({
    status: 200,
    bodyText: JSON.stringify({ products: ["a", "b"] }),
    truncated: false,
  });
  const run = buildN8nToolRun({ ...baseRow, mode: "sync", sensitivity: "read" });
  const result = await run({ query: "shoes" }, ctx);
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { products: ["a", "b"] });

  const call = fetchPinnedCalls[0];
  assert.equal(call.opts.method, "POST");
  assert.deepEqual(JSON.parse(call.opts.body!), {
    workspace_id: "ws_1",
    conversation_id: "conv_1",
    contact_id: "contact_1",
    args: { query: "shoes" },
  });
});

test("sync mode falls back to plain text when the body is not valid JSON", async () => {
  reset();
  fetchPinnedImpl = async () => ({ status: 200, bodyText: "not json", truncated: false });
  const run = buildN8nToolRun({ ...baseRow, mode: "sync", sensitivity: "read" });
  const result = await run({}, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.output, "not json");
});

test("async mode ignores the body and requests it be discarded via maxResponseBytes: 0", async () => {
  reset();
  fetchPinnedImpl = async () => ({ status: 202, bodyText: "", truncated: true });
  const run = buildN8nToolRun({ ...baseRow, mode: "async", sensitivity: "write" });
  const result = await run({}, ctx);
  assert.deepEqual(result, { ok: true, output: { status: "queued" } });
  assert.equal(fetchPinnedCalls[0].opts.maxResponseBytes, 0);
});

test("treats a non-2xx status as an error", async () => {
  reset();
  fetchPinnedImpl = async () => ({ status: 500, bodyText: "boom", truncated: false });
  const run = buildN8nToolRun({ ...baseRow, mode: "sync", sensitivity: "read" });
  const result = await run({}, ctx);
  assert.equal(result.ok, false);
  assert.equal(result.error, "HTTP 500");
});

test("treats a redirect (3xx) as an error, never following it", async () => {
  reset();
  fetchPinnedImpl = async () => ({ status: 302, bodyText: "", truncated: false });
  const run = buildN8nToolRun({ ...baseRow, mode: "sync", sensitivity: "read" });
  const result = await run({}, ctx);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /302/);
});

test("adds the configured auth header when present", async () => {
  reset();
  const run = buildN8nToolRun({
    ...baseRow,
    mode: "sync",
    sensitivity: "read",
    auth_header_name: "Authorization",
    auth_header_value: "Bearer secret-token",
  });
  await run({}, ctx);
  assert.equal(fetchPinnedCalls[0].opts.headers.Authorization, "Bearer secret-token");
});

test("passes the row's timeout_ms and resolved IP straight through to fetchPinned", async () => {
  reset();
  validateImpl = async () => ({ error: null, resolvedIp: "1.2.3.4" });
  const run = buildN8nToolRun({ ...baseRow, mode: "sync", sensitivity: "read", timeout_ms: 12000 });
  await run({}, ctx);
  assert.equal(fetchPinnedCalls[0].resolvedIp, "1.2.3.4");
  assert.equal(fetchPinnedCalls[0].opts.timeoutMs, 12000);
});
