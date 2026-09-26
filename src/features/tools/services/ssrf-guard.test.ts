import assert from "node:assert/strict";
import { test, mock } from "node:test";

let resolve4Impl: (hostname: string) => Promise<string[]>;
mock.module("node:dns/promises", {
  exports: {
    resolve4: (hostname: string) => resolve4Impl(hostname),
  },
});

const { validateWebhookUrl } = await import("./ssrf-guard.ts");

test("rejects a malformed URL", async () => {
  const result = await validateWebhookUrl("not a url");
  assert.equal(result, "Invalid URL");
});

test("rejects a non-HTTPS URL without attempting DNS resolution", async () => {
  resolve4Impl = async () => {
    throw new Error("resolve4 should not be called for a rejected protocol");
  };
  const result = await validateWebhookUrl("http://example.com/webhook");
  assert.equal(result, "Only HTTPS webhooks are allowed (SEC-08)");
});

test("returns an error when the hostname cannot be resolved", async () => {
  resolve4Impl = async () => {
    throw new Error("ENOTFOUND");
  };
  const result = await validateWebhookUrl("https://no-such-host.invalid/webhook");
  assert.equal(result, "Cannot resolve hostname");
});

test("blocks private/internal IPv4 ranges", async () => {
  const privateIps = [
    "10.0.0.5",
    "192.168.1.1",
    "127.0.0.1",
    "169.254.1.1",
    "100.64.0.1",
    "172.16.0.1",
    "172.31.255.255",
  ];
  for (const ip of privateIps) {
    resolve4Impl = async () => [ip];
    const result = await validateWebhookUrl("https://internal.example.com/webhook");
    assert.equal(
      result,
      `Blocked: ${ip} is a private/internal IP address (SEC-08 anti-SSRF)`,
    );
  }
});

test("allows a public IPv4 address", async () => {
  resolve4Impl = async () => ["8.8.8.8"];
  const result = await validateWebhookUrl("https://public.example.com/webhook");
  assert.equal(result, null);
});

// Pins the 172.16.0.0/12 boundary — a lazy `/^172\./` regex would wrongly
// block these adjacent-but-public addresses.
test("does not block addresses just outside the 172.16.0.0/12 private range", async () => {
  for (const ip of ["172.15.0.1", "172.32.0.1"]) {
    resolve4Impl = async () => [ip];
    const result = await validateWebhookUrl("https://public.example.com/webhook");
    assert.equal(result, null);
  }
});

test("blocks the whole address when DNS returns a mix of public and private addresses", async () => {
  resolve4Impl = async () => ["8.8.8.8", "10.0.0.5"];
  const result = await validateWebhookUrl("https://internal.example.com/webhook");
  assert.equal(
    result,
    "Blocked: 10.0.0.5 is a private/internal IP address (SEC-08 anti-SSRF)",
  );
});
