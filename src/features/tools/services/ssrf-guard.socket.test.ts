import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";

// fetchPinned against a real local HTTP server — no module mocks. These check
// what the mocked tests cannot: that Node really connects to the pinned
// address (the hostname below does not resolve at all) and how real chunked
// and compressed bodies meet the size cap.

import { fetchPinned } from "./ssrf-guard.ts";

let lastHost = "";
let trickleClosed = false;
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  lastHost = req.headers.host ?? "";
  if (req.url === "/gzip-cut") {
    // Half of a gzip body, then the connection drops.
    const full = gzipSync(Buffer.from("b".repeat(200_000)));
    res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
    res.write(full.subarray(0, Math.floor(full.length / 2)), () => res.socket?.destroy());
    return;
  }
  if (req.url === "/redirect-trickle") {
    res.writeHead(302, { location: "/hello" });
    const timer = setInterval(() => res.write("."), 20);
    req.on("close", () => {
      trickleClosed = true;
      clearInterval(timer);
    });
    return;
  }
  if (req.url === "/hello") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hola");
    return;
  }
  if (req.url === "/chunked") {
    // No Content-Length: Node sends Transfer-Encoding: chunked.
    res.writeHead(200, { "content-type": "text/plain" });
    for (let i = 0; i < 10; i++) res.write("x".repeat(1024));
    res.end();
    return;
  }
  if (req.url === "/gzip") {
    const body = gzipSync(Buffer.from("a".repeat(50_000)));
    res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
    res.end(body);
    return;
  }
  if (req.url === "/zstd") {
    res.writeHead(200, { "content-type": "text/plain", "content-encoding": "zstd" });
    res.end("???");
    return;
  }
  res.writeHead(404);
  res.end();
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;
after(() => server.close());

// `.invalid` is reserved: it can never resolve, so reaching the server proves
// the request used the pinned address and never asked DNS.
const base = `http://pinned-only.invalid:${port}`;

test("connects to the pinned address even though the hostname does not resolve", async () => {
  const res = await fetchPinned(`${base}/hello`, "127.0.0.1", {
    method: "GET",
    headers: {},
    timeoutMs: 5000,
  });
  assert.equal(res.status, 200);
  assert.equal(res.bodyText, "hola");
  // The Host header still names the URL's host, as a normal request would.
  assert.equal(lastHost, `pinned-only.invalid:${port}`);
});

test("a chunked body larger than the cap is cut at the cap", async () => {
  const res = await fetchPinned(`${base}/chunked`, "127.0.0.1", {
    method: "GET",
    headers: {},
    timeoutMs: 5000,
    maxResponseBytes: 1500,
  });
  assert.equal(res.truncated, true);
  assert.equal(res.bodyText.length, 1500);
});

test("with decompress, the cap applies to the decoded bytes of a gzip body", async () => {
  const res = await fetchPinned(`${base}/gzip`, "127.0.0.1", {
    method: "GET",
    headers: {},
    timeoutMs: 5000,
    maxResponseBytes: 1000,
    decompress: true,
  });
  assert.equal(res.truncated, true);
  assert.equal(res.bodyText, "a".repeat(1000));

  const full = await fetchPinned(`${base}/gzip`, "127.0.0.1", {
    method: "GET",
    headers: {},
    timeoutMs: 5000,
    decompress: true,
  });
  assert.equal(full.bodyText.length, 50_000);
});

test("with decompress, an unknown content-encoding is rejected, not read as text", async () => {
  await assert.rejects(
    () =>
      fetchPinned(`${base}/zstd`, "127.0.0.1", {
        method: "GET",
        headers: {},
        timeoutMs: 5000,
        decompress: true,
      }),
    /Unsupported content-encoding: zstd/,
  );
});

test("a gzip body that closes halfway fails at once instead of waiting out the deadline", async () => {
  const started = Date.now();
  await assert.rejects(
    () =>
      fetchPinned(`${base}/gzip-cut`, "127.0.0.1", {
        method: "GET",
        headers: {},
        timeoutMs: 5000,
        decompress: true,
      }),
    (err: unknown) => err instanceof Error && err.message !== "Tool timeout",
  );
  assert.ok(Date.now() - started < 2000);
});

test("a redirect whose body trickles is answered at once and its connection dropped", async () => {
  trickleClosed = false;
  const started = Date.now();
  const res = await fetchPinned(`${base}/redirect-trickle`, "127.0.0.1", {
    method: "GET",
    headers: {},
    timeoutMs: 5000,
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/hello");
  assert.ok(Date.now() - started < 1000);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(trickleClosed, true);
});
