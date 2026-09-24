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

let lastReqOptions: FakeReqOptions | null = null;
let fakeResponseStatus = 200;
let fakeResponseChunks: Buffer[] = [];
let fakeResponseThrows: Error | null = null;
/** Simulates a webhook that opens the response and then never ends it. */
let fakeResponseHangs = false;

class FakeRequest extends EventEmitter {
  destroyed = false;
  write() {}
  end() {}
  destroy(err?: Error) {
    this.destroyed = true;
    if (err) this.emit("error", err);
  }
}

mock.module("node:https", {
  exports: {
    request: (
      options: FakeReqOptions,
      callback: (res: EventEmitter & { statusCode: number }) => void,
    ) => {
      lastReqOptions = options;
      const req = new FakeRequest();
      queueMicrotask(() => {
        if (fakeResponseThrows) {
          req.emit("error", fakeResponseThrows);
          return;
        }
        const res = new EventEmitter() as EventEmitter & {
          statusCode: number;
          resume: () => void;
        };
        res.statusCode = fakeResponseStatus;
        res.resume = () => {}; // IncomingMessage.resume() — fetchPinned calls it to drain a redirect body
        callback(res);
        if (fakeResponseHangs) return; // no data, no "end" — the deadline must fire
        for (const chunk of fakeResponseChunks) res.emit("data", chunk);
        res.emit("end");
      });
      return req;
    },
  },
});

const { validateWebhookUrl, fetchPinned } = await import("./ssrf-guard.ts");

function reset() {
  lastReqOptions = null;
  fakeResponseStatus = 200;
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
