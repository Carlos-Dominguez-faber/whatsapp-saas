import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { EventEmitter } from "node:events";

let resolve4Impl: (hostname: string) => Promise<string[]>;
mock.module("node:dns/promises", {
  exports: {
    resolve4: (hostname: string) => resolve4Impl(hostname),
  },
});

interface FakeReqOptions {
  hostname: string;
  lookup: (
    hostname: string,
    options: unknown,
    callback: (err: Error | null, address: string, family: number) => void,
  ) => void;
  port: string | number;
  path: string;
  method: string;
  headers: Record<string, string>;
  timeout: number;
}

// Per-request responses for redirect chains; when empty, the single fake
// response below is used.
let responseQueue: Array<{ status: number; headers?: Record<string, string>; chunks?: Buffer[] }> = [];
const requests: Array<{ module: string; options: FakeReqOptions; req: FakeRequest }> = [];
let lastReqOptions: FakeReqOptions | null = null;
let lastReqModule: "http" | "https" | null = null;
let lastReqBody = "";
let fakeResponseStatus = 200;
let fakeResponseHeaders: Record<string, string> = {};
let fakeResponseChunks: Buffer[] = [];
let fakeResponseThrows: Error | null = null;
/** Simulates a webhook that opens the response and then never ends it. */
let fakeResponseHangs = false;

class FakeRequest extends EventEmitter {
  destroyed = false;
  body = "";
  write(chunk: string) {
    lastReqBody += chunk;
    this.body += chunk;
  }
  end() {}
  destroy(err?: Error) {
    this.destroyed = true;
    if (err) this.emit("error", err);
  }
}

function fakeRequest(module: "http" | "https") {
  return (
      options: FakeReqOptions,
      callback: (res: EventEmitter & { statusCode: number }) => void,
    ) => {
      lastReqOptions = options;
      lastReqModule = module;
      const req = new FakeRequest();
      requests.push({ module, options, req });
      const queued = responseQueue.shift();
      queueMicrotask(() => {
        if (fakeResponseThrows) {
          req.emit("error", fakeResponseThrows);
          return;
        }
        const res = new EventEmitter() as EventEmitter & {
          statusCode: number;
          resume: () => void;
        };
        res.statusCode = queued?.status ?? fakeResponseStatus;
        (res as unknown as { headers: Record<string, string> }).headers =
          queued?.headers ?? fakeResponseHeaders;
        res.resume = () => {}; // IncomingMessage.resume() — fetchPinned calls it to drain a redirect body
        callback(res);
        if (fakeResponseHangs) return; // no data, no "end" — the deadline must fire
        for (const chunk of queued?.chunks ?? fakeResponseChunks) res.emit("data", chunk);
        res.emit("end");
      });
      return req;
    };
}

mock.module("node:https", { exports: { request: fakeRequest("https") } });
mock.module("node:http", { exports: { request: fakeRequest("http") } });

const {
  validateWebhookUrl,
  fetchPinned,
  fetchPinnedFollowingRedirects,
  RedirectRefusedError,
} = await import("./ssrf-guard.ts");

function reset() {
  responseQueue = [];
  requests.length = 0;
  lastReqOptions = null;
  lastReqModule = null;
  lastReqBody = "";
  fakeResponseStatus = 200;
  fakeResponseHeaders = {};
  fakeResponseChunks = [];
  fakeResponseThrows = null;
  fakeResponseHangs = false;
}

// ── validateWebhookUrl ──────────────────────────────────────────────────────

test("rejects a malformed URL", async () => {
  const result = await validateWebhookUrl("not a url");
  assert.deepEqual(result, { error: "Invalid URL" });
});

test("rejects a non-HTTPS URL without attempting DNS resolution", async () => {
  resolve4Impl = async () => {
    throw new Error("resolve4 should not be called for a rejected protocol");
  };
  const result = await validateWebhookUrl("http://example.com/webhook");
  assert.deepEqual(result, { error: "Only HTTPS webhooks are allowed (SEC-08)" });
});

test("returns an error when the hostname cannot be resolved", async () => {
  resolve4Impl = async () => {
    throw new Error("ENOTFOUND");
  };
  const result = await validateWebhookUrl("https://no-such-host.invalid/webhook");
  assert.deepEqual(result, { error: "Cannot resolve hostname" });
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
    "0.0.0.0", // "this host" — on Linux, connecting here reaches localhost
    "0.0.0.1",
    "224.0.0.1", // multicast
    "239.255.255.255",
    "240.0.0.1", // reserved
    "255.255.255.255", // broadcast
  ];
  for (const ip of privateIps) {
    resolve4Impl = async () => [ip];
    const result = await validateWebhookUrl("https://internal.example.com/webhook");
    assert.deepEqual(result, {
      error: `Blocked: ${ip} is a private/internal IP address (SEC-08 anti-SSRF)`,
    });
  }
});

test("allowHttp accepts http:// and still rejects other schemes", async () => {
  resolve4Impl = async () => ["8.8.8.8"];
  assert.deepEqual(
    await validateWebhookUrl("http://public.example.com/", { allowHttp: true }),
    { error: null, resolvedIp: "8.8.8.8" },
  );
  assert.deepEqual(await validateWebhookUrl("ftp://public.example.com/", { allowHttp: true }), {
    error: "Only http(s) URLs are allowed (SEC-08)",
  });
});

test("checks an IPv4 literal directly, including the decimal form, without DNS", async () => {
  resolve4Impl = async () => {
    throw new Error("an IP literal must not go through DNS");
  };
  for (const url of ["http://127.0.0.1/", "http://2130706433/", "http://0x7f.1/", "https://10.1.2.3/hook"]) {
    const result = await validateWebhookUrl(url, { allowHttp: true });
    assert.match(result.error ?? "", /private\/internal IP/, url);
  }
  assert.deepEqual(await validateWebhookUrl("https://8.8.4.4/hook"), {
    error: null,
    resolvedIp: "8.8.4.4",
  });
});

test("rejects IPv6 literals, which the IPv4-only pinning cannot check", async () => {
  for (const url of ["https://[::1]/hook", "https://[::ffff:127.0.0.1]/hook", "https://[fd00::1]/"]) {
    assert.deepEqual(await validateWebhookUrl(url), {
      error: "IPv6 addresses are not supported (SEC-08)",
    });
  }
});

test("allows a public IPv4 address and returns the resolved IP", async () => {
  resolve4Impl = async () => ["8.8.8.8"];
  const result = await validateWebhookUrl("https://public.example.com/webhook");
  assert.deepEqual(result, { error: null, resolvedIp: "8.8.8.8" });
});

test("does not block public addresses that only look like a blocked range", async () => {
  // Guards the regex boundaries: 172.16/12, 224/4 and 240/4 must not swallow
  // 22.x / 24.x / 25.x, which are ordinary public /8s.
  for (const ip of [
    "172.15.0.1",
    "172.32.0.1",
    "223.255.255.255",
    "22.1.1.1",
    "24.1.1.1",
    "25.1.1.1",
  ]) {
    resolve4Impl = async () => [ip];
    const result = await validateWebhookUrl("https://public.example.com/webhook");
    assert.equal(result.error, null);
  }
});

test("blocks the whole address when DNS returns a mix of public and private addresses", async () => {
  resolve4Impl = async () => ["8.8.8.8", "10.0.0.5"];
  const result = await validateWebhookUrl("https://internal.example.com/webhook");
  assert.deepEqual(result, {
    error: "Blocked: 10.0.0.5 is a private/internal IP address (SEC-08 anti-SSRF)",
  });
});

// ── fetchPinned ──────────────────────────────────────────────────────────────

test("fetchPinned connects using the pinned IP, not a fresh DNS lookup (closes DNS rebinding)", async () => {
  reset();
  resolve4Impl = async () => {
    throw new Error("fetchPinned must never re-resolve DNS itself");
  };
  fakeResponseChunks = [Buffer.from('{"ok":true}')];

  const result = await fetchPinned("https://public.example.com/hook", "8.8.8.8", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    timeoutMs: 5000,
  });

  assert.equal(result.status, 200);
  assert.equal(result.bodyText, '{"ok":true}');
  assert.equal(result.truncated, false);

  // Confirm the pinned IP is what the custom `lookup` hands back, regardless
  // of hostname — this is the mechanism that closes the rebinding window.
  let capturedAddress: string | undefined;
  lastReqOptions!.lookup("public.example.com", {}, (_err, address) => {
    capturedAddress = address;
  });
  assert.equal(capturedAddress, "8.8.8.8");
  assert.equal(lastReqOptions!.method, "POST");
});

test("fetchPinned's lookup answers Node's Happy Eyeballs {all:true} form with an address array, not a bare string", async () => {
  // Since Node 18.13/20, net/tls's autoSelectFamily calls a custom `lookup`
  // with `{ all: true }` and expects `callback(err, [{address, family}])`.
  // Answering with the legacy 3-arg form here makes Node try to connect to
  // `undefined` (ERR_INVALID_IP_ADDRESS) — this guards that regression.
  reset();
  fakeResponseChunks = [Buffer.from('{"ok":true}')];

  await fetchPinned("https://public.example.com/hook", "8.8.8.8", {
    method: "POST",
    headers: {},
    timeoutMs: 5000,
  });

  let result: unknown;
  (lastReqOptions!.lookup as unknown as (
    hostname: string,
    options: { all: boolean },
    callback: (err: Error | null, addresses: { address: string; family: number }[]) => void,
  ) => void)("public.example.com", { all: true }, (_err, addresses) => {
    result = addresses;
  });

  assert.deepEqual(result, [{ address: "8.8.8.8", family: 4 }]);
});

test("fetchPinned treats a 3xx response as an empty body without following it", async () => {
  reset();
  fakeResponseStatus = 302;
  fakeResponseChunks = [Buffer.from("ignored redirect body")];

  const result = await fetchPinned("https://public.example.com/hook", "8.8.8.8", {
    method: "POST",
    headers: {},
    timeoutMs: 5000,
  });

  assert.equal(result.status, 302);
  assert.equal(result.bodyText, "");
});

test("fetchPinned hands back the response headers, including a redirect's location", async () => {
  reset();
  fakeResponseStatus = 301;
  fakeResponseHeaders = { location: "https://www.example.com/" };
  const result = await fetchPinned("https://public.example.com/", "8.8.8.8", {
    method: "GET",
    headers: {},
    timeoutMs: 5000,
  });
  assert.equal(result.headers.location, "https://www.example.com/");
});

test("fetchPinned sends a Content-Length instead of a chunked body", async () => {
  reset();
  const body = JSON.stringify({ nota: "café" });
  await fetchPinned("https://public.example.com/hook", "8.8.8.8", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    timeoutMs: 5000,
  });
  assert.equal(lastReqOptions!.headers["Content-Length"], String(Buffer.byteLength(body)));
  assert.equal(lastReqBody, body);
});

test("fetchPinned uses node:http and port 80 for an http:// URL", async () => {
  reset();
  fakeResponseChunks = [Buffer.from("hola")];
  const result = await fetchPinned("http://public.example.com/page", "8.8.8.8", {
    method: "GET",
    headers: {},
    timeoutMs: 5000,
  });
  assert.equal(lastReqModule, "http");
  assert.equal(lastReqOptions!.port, 80);
  assert.equal(result.bodyText, "hola");
});

test("fetchPinned truncates the body at maxResponseBytes instead of buffering it all", async () => {
  reset();
  fakeResponseChunks = [Buffer.from("0123456789")];

  const result = await fetchPinned("https://public.example.com/hook", "8.8.8.8", {
    method: "POST",
    headers: {},
    timeoutMs: 5000,
    maxResponseBytes: 4,
  });

  assert.equal(result.bodyText, "0123");
  assert.equal(result.truncated, true);
});

test("fetchPinned aborts at timeoutMs even when the response never ends", async () => {
  reset();
  // node:https' `timeout` option is socket-INACTIVITY only, so a webhook that
  // holds the response open (or dribbles bytes) would never trip it. The
  // absolute deadline in fetchPinned is what bounds the call.
  fakeResponseHangs = true;

  const start = Date.now();
  await assert.rejects(
    fetchPinned("https://public.example.com/hook", "8.8.8.8", {
      method: "POST",
      headers: {},
      timeoutMs: 40,
    }),
    /Tool timeout/,
  );
  assert.ok(Date.now() - start < 2000, "must reject on its own deadline, not hang");
});

test("fetchPinned with maxResponseBytes: 0 discards the body entirely (async mode)", async () => {
  reset();
  fakeResponseChunks = [Buffer.from("some body")];

  const result = await fetchPinned("https://public.example.com/hook", "8.8.8.8", {
    method: "POST",
    headers: {},
    timeoutMs: 5000,
    maxResponseBytes: 0,
  });

  assert.equal(result.bodyText, "");
  assert.equal(result.truncated, true);
});

// ── validateWebhookUrl: DNS bound and extra reserved ranges ─────────────────

test("a DNS lookup that never answers is cut off instead of holding the request", async () => {
  resolve4Impl = () => new Promise<string[]>(() => {});
  const started = Date.now();
  const result = await validateWebhookUrl("https://slow-dns.example/hook", { dnsTimeoutMs: 20 });
  assert.deepEqual(result, { error: "DNS lookup timed out" });
  assert.ok(Date.now() - started < 1000);
});

test("blocks the documentation, benchmarking and IETF-reserved ranges", async () => {
  for (const ip of ["192.0.0.8", "192.0.2.5", "198.18.0.1", "198.19.255.1", "198.51.100.7", "203.0.113.9", "240.0.0.1"]) {
    resolve4Impl = async () => [ip];
    const result = await validateWebhookUrl("https://reserved.example.com/hook");
    assert.match(result.error ?? "", /private\/internal IP/, ip);
  }
});

// ── fetchPinnedFollowingRedirects ───────────────────────────────────────────

test("a POST answered with 302 continues as a GET without body (Apps Script /exec)", async () => {
  reset();
  resolve4Impl = async () => ["8.8.8.8"];
  responseQueue = [
    { status: 302, headers: { location: "https://script.googleusercontent.com/macros/echo?user_content_key=abc" } },
    { status: 200, headers: {}, chunks: [Buffer.from("ok")] },
  ];
  const result = await fetchPinnedFollowingRedirects("https://script.google.com/macros/s/X/exec", {
    resolvedIp: "8.8.8.8",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"a":1}',
    timeoutMs: 5000,
  });
  assert.equal(result.status, 200);
  assert.equal(result.url, "https://script.googleusercontent.com/macros/echo?user_content_key=abc");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[1].options.method, "GET");
  assert.equal(requests[1].req.body, "");
  assert.equal(requests[1].options.headers["Content-Type"], undefined);
  assert.equal(requests[1].options.headers["Content-Length"], undefined);
});

test("307 and 308 keep the method and the body", async () => {
  for (const status of [307, 308]) {
    reset();
    resolve4Impl = async () => ["8.8.8.8"];
    responseQueue = [
      { status, headers: { location: "/v2/hook" } },
      { status: 200, headers: {} },
    ];
    await fetchPinnedFollowingRedirects("https://hooks.example.com/hook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"a":1}',
      timeoutMs: 5000,
    });
    assert.equal(requests[1].options.method, "POST", String(status));
    assert.equal(requests[1].req.body, '{"a":1}', String(status));
    assert.equal(requests[1].options.path, "/v2/hook");
  }
});

test("a redirect into a private range is refused before any request reaches it", async () => {
  reset();
  resolve4Impl = async (host) => (host === "internal.example.com" ? ["10.0.0.5"] : ["8.8.8.8"]);
  responseQueue = [{ status: 302, headers: { location: "https://internal.example.com/admin" } }];
  await assert.rejects(
    () =>
      fetchPinnedFollowingRedirects("https://hooks.example.com/hook", {
        method: "GET",
        headers: {},
        timeoutMs: 5000,
      }),
    (err: unknown) => err instanceof RedirectRefusedError && /10\.0\.0\.5/.test((err as Error).message),
  );
  assert.equal(requests.length, 1);
});

test("webhooks stay HTTPS on every hop; http:// is followed only when allowed", async () => {
  reset();
  resolve4Impl = async () => ["8.8.8.8"];
  responseQueue = [{ status: 301, headers: { location: "http://hooks.example.com/hook" } }];
  await assert.rejects(
    () => fetchPinnedFollowingRedirects("https://hooks.example.com/hook", { method: "GET", headers: {}, timeoutMs: 5000 }),
    RedirectRefusedError,
  );

  reset();
  responseQueue = [
    { status: 301, headers: { location: "http://www.example.com/" } },
    { status: 200, headers: {} },
  ];
  const result = await fetchPinnedFollowingRedirects("https://example.com/", {
    allowHttp: true,
    method: "GET",
    headers: {},
    timeoutMs: 5000,
  });
  assert.equal(result.status, 200);
  assert.equal(requests[1].module, "http");
});

test("more than maxRedirects redirects are refused", async () => {
  reset();
  resolve4Impl = async () => ["8.8.8.8"];
  responseQueue = Array.from({ length: 5 }, (_, i) => ({ status: 302, headers: { location: `/${i + 1}` } }));
  await assert.rejects(
    () => fetchPinnedFollowingRedirects("https://hooks.example.com/0", { method: "GET", headers: {}, timeoutMs: 5000 }),
    /Too many redirects/,
  );
  assert.equal(requests.length, 4);
});

test("credentials do not follow a redirect to another host", async () => {
  reset();
  resolve4Impl = async () => ["8.8.8.8"];
  responseQueue = [
    { status: 307, headers: { location: "https://other.example.net/hook" } },
    { status: 200, headers: {} },
  ];
  await fetchPinnedFollowingRedirects("https://hooks.example.com/hook", {
    method: "POST",
    headers: { Authorization: "Bearer s3cret", "Content-Type": "application/json" },
    body: "{}",
    timeoutMs: 5000,
  });
  assert.equal(requests[0].options.headers.Authorization, "Bearer s3cret");
  assert.equal(requests[1].options.headers.Authorization, undefined);
  assert.equal(requests[1].options.headers["Content-Type"], "application/json");
});

