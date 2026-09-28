import { resolve4 } from "node:dns/promises";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIPv4 } from "node:net";
import { pipeline, type Readable } from "node:stream";
import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
} from "node:zlib";

const PRIVATE_RANGES: RegExp[] = [
  /^0\./, // 0.0.0.0/8 — on Linux, connecting to 0.0.0.0 reaches localhost
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^169\.254\./, // link-local
  /^100\.6[4-9]\.|^100\.[7-9]\d\.|^100\.1[01]\d\.|^100\.12[0-7]\./, // CGNAT
  /^2(2[4-9]|3\d)\./, // 224.0.0.0/4 multicast
  /^2(4\d|5[0-5])\./, // 240.0.0.0/4 reserved (includes 255.255.255.255 broadcast)
  /^192\.0\.0\./, // 192.0.0.0/24 IETF protocol assignments
  /^192\.0\.2\./, // 192.0.2.0/24 TEST-NET-1
  /^198\.1[89]\./, // 198.18.0.0/15 benchmarking
  /^198\.51\.100\./, // 198.51.100.0/24 TEST-NET-2
  /^203\.0\.113\./, // 203.0.113.0/24 TEST-NET-3
];

// A DNS answer that never comes must not hold the request past its deadline.
const DEFAULT_DNS_TIMEOUT_MS = 5_000;

export interface WebhookUrlCheck {
  error: string | null;
  resolvedIp?: string;
}

export interface ValidateUrlOptions {
  /** Also accept plain http:// (the KB scraper reads public web pages). */
  allowHttp?: boolean;
  /** Upper bound for the DNS lookup (default 5 s). */
  dnsTimeoutMs?: number;
}

/**
 * SEC-08: Validates a URL before fetching, and returns the IPv4 address it
 * resolved so the caller can pin the real request to that exact address (see
 * fetchPinned) instead of re-resolving DNS later — closing the DNS-rebinding
 * window where a low-TTL hostname could answer differently between this check
 * and the request.
 *
 * Only IPv4 is supported: IPv6 literals are rejected and hostnames resolve
 * through A records, so an IPv6-only host fails closed.
 */
export async function validateWebhookUrl(
  url: string,
  opts: ValidateUrlOptions = {},
): Promise<WebhookUrlCheck> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: "Invalid URL" };
  }

  if (
    parsed.protocol !== "https:" &&
    !(opts.allowHttp && parsed.protocol === "http:")
  ) {
    return {
      error: opts.allowHttp
        ? "Only http(s) URLs are allowed (SEC-08)"
        : "Only HTTPS webhooks are allowed (SEC-08)",
    };
  }

  // WHATWG URL already normalizes decimal/hex/short IPv4 forms (2130706433,
  // 0x7f.1) to dotted quads, so an IPv4 literal is checked as-is. An IPv6
  // literal keeps its brackets in `hostname`.
  let addresses: string[] = [];
  if (isIPv4(parsed.hostname)) {
    addresses = [parsed.hostname];
  } else if (parsed.hostname.startsWith("[")) {
    return { error: "IPv6 addresses are not supported (SEC-08)" };
  } else {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      addresses = await Promise.race([
        resolve4(parsed.hostname),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("DNS lookup timed out")),
            opts.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (err) {
      return {
        error:
          err instanceof Error && err.message === "DNS lookup timed out"
            ? "DNS lookup timed out"
            : "Cannot resolve hostname",
      };
    } finally {
      clearTimeout(timer);
    }
  }
  if (addresses.length === 0) {
    return { error: "Cannot resolve hostname" };
  }

  for (const ip of addresses) {
    if (PRIVATE_RANGES.some((r) => r.test(ip))) {
      return { error: `Blocked: ${ip} is a private/internal IP address (SEC-08 anti-SSRF)` };
    }
  }

  return { error: null, resolvedIp: addresses[0] };
}

export interface PinnedRequestOptions {
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  /** 0 discards the body entirely (fire-and-forget); omit for no cap. */
  maxResponseBytes?: number;
  /**
   * Decode a gzip/deflate/br body (the cap then applies to the decoded bytes,
   * so a small compressed body cannot expand past it). Any other encoding is
   * rejected.
   */
  decompress?: boolean;
}

export interface PinnedResponse {
  status: number;
  /** Response headers (e.g. content-type, or location on a 3xx). */
  headers: IncomingHttpHeaders;
  bodyText: string;
  truncated: boolean;
}

/**
 * Sends a request to `url` over a connection pinned to `resolvedIp` — the
 * `lookup` override means no second DNS resolution happens between
 * validateWebhookUrl and this call. Never follows redirects: a 3xx comes
 * back with an empty body (and its `location` header) for the caller to
 * reject or to re-validate as a brand-new URL before following it.
 *
 * `opts.timeoutMs` is an ABSOLUTE deadline for the whole exchange, not just
 * the socket-inactivity `timeout` that node:https offers: a webhook that
 * dribbles a byte every few seconds resets the inactivity timer forever, so
 * the hard timer below is what actually bounds the call.
 */
export function fetchPinned(
  url: string,
  resolvedIp: string,
  opts: PinnedRequestOptions,
): Promise<PinnedResponse> {
  let deadline: ReturnType<typeof setTimeout> | undefined;

  return new Promise<PinnedResponse>((resolve, reject) => {
    const parsed = new URL(url);
    const cap = opts.maxResponseBytes ?? Infinity;
    let settled = false;
    let abortDecoder: (() => void) | undefined;
    const isHttp = parsed.protocol === "http:";
    const request = isHttp ? httpRequest : httpsRequest;
    // node:https streams a string body chunked; some receivers reject that,
    // and fetch() used to send a Content-Length.
    const headers =
      opts.body !== undefined
        ? { ...opts.headers, "Content-Length": String(Buffer.byteLength(opts.body)) }
        : opts.headers;

    const req = request(
      {
        hostname: parsed.hostname,
        // Node's `net`/`tls` Happy Eyeballs (autoSelectFamily, default on
        // since Node 18.13/20) calls this with `{ all: true }` and expects
        // an array of {address, family} back, not the legacy single-address
        // 3-arg form — passing the wrong shape makes Node try to connect to
        // `undefined` (ERR_INVALID_IP_ADDRESS). @types/node only models the
        // legacy shape, so the dual-shape handling below is cast at the edge.
        lookup: ((
          _hostname: string,
          options: { all?: boolean },
          callback: (
            err: NodeJS.ErrnoException | null,
            address: string | { address: string; family: number }[],
            family?: number,
          ) => void,
        ) => {
          if (options.all === true) {
            callback(null, [{ address: resolvedIp, family: 4 }]);
          } else {
            callback(null, resolvedIp, 4);
          }
        }) as unknown as (
          hostname: string,
          options: unknown,
          callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
        ) => void,
        port: parsed.port || (isHttp ? 80 : 443),
        path: `${parsed.pathname}${parsed.search}`,
        method: opts.method,
        headers,
        timeout: opts.timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const resHeaders = res.headers ?? {};
        if (status >= 300 && status < 400) {
          // Drop the connection instead of draining it: a redirect body that
          // trickles in must not outlive the deadline.
          settled = true;
          req.destroy();
          resolve({ status, headers: resHeaders, bodyText: "", truncated: false });
          return;
        }

        let body: Readable = res;
        if (opts.decompress) {
          const decoder = decoderFor(res);
          if (decoder === "unsupported") {
            settled = true;
            req.destroy();
            reject(
              new Error(`Unsupported content-encoding: ${res.headers["content-encoding"]}`),
            );
            return;
          }
          if (decoder) {
            // pipeline() propagates errors both ways: a compressed body that
            // closes early, or bytes that are not what the header claims,
            // fail right away instead of waiting for the deadline.
            body = pipeline(res, decoder, (err) => {
              if (!err || settled) return;
              settled = true;
              req.destroy();
              reject(new Error(`Unreadable compressed body: ${err.message}`));
            });
            // Only an abort (cap reached, deadline) tears the decoder down: on
            // a normal finish the request closes before the decoder has
            // flushed, and destroying it then would swallow its "end".
            abortDecoder = () => decoder.destroy();
          }
        }

        const chunks: Buffer[] = [];
        let total = 0;
        let truncated = false;

        body.on("data", (chunk: Buffer) => {
          if (settled) return;
          if (total >= cap) {
            truncated = true;
            settled = true;
            abortDecoder?.();
            req.destroy();
            resolve({ status, headers: resHeaders, bodyText: Buffer.concat(chunks).toString("utf8"), truncated });
            return;
          }
          const remaining = cap - total;
          const piece = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
          chunks.push(piece);
          total += piece.length;
          if (chunk.length > remaining) {
            truncated = true;
            settled = true;
            abortDecoder?.();
            req.destroy();
            resolve({ status, headers: resHeaders, bodyText: Buffer.concat(chunks).toString("utf8"), truncated });
          }
        });
        body.on("end", () => {
          if (settled) return;
          settled = true;
          resolve({ status, headers: resHeaders, bodyText: Buffer.concat(chunks).toString("utf8"), truncated });
        });
        body.on("error", (err) => {
          if (settled) return;
          settled = true;
          reject(err);
        });
      },
    );

    deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      abortDecoder?.();
      req.destroy();
      reject(new Error("Tool timeout"));
    }, opts.timeoutMs);

    req.on("timeout", () => req.destroy(new Error("Tool timeout")));
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  }).finally(() => clearTimeout(deadline));
}

function decoderFor(res: IncomingMessage) {
  const encoding = String(res.headers["content-encoding"] ?? "identity")
    .trim()
    .toLowerCase();
  switch (encoding) {
    case "":
    case "identity":
      return null;
    case "gzip":
    case "x-gzip":
      return createGunzip();
    case "deflate":
      return createInflate();
    case "br":
      return createBrotliDecompress();
    default:
      return "unsupported" as const;
  }
}

/** A redirect the caller must not follow: blocked target, bad location or too many hops. */
export class RedirectRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedirectRefusedError";
  }
}

/**
 * The status of the first response, attached to any error thrown after it
 * arrived: the target already received the request even though a later hop
 * failed (see n8n-tool-runner.ts).
 */
export function firstStatusOf(err: unknown): number | undefined {
  const status = (err as { firstStatus?: unknown } | null)?.firstStatus;
  return typeof status === "number" ? status : undefined;
}

export interface FollowRedirectOptions extends PinnedRequestOptions {
  /** Also accept http:// for the URL and every redirect target. */
  allowHttp?: boolean;
  /** Redirects to follow at most (default 3). */
  maxRedirects?: number;
  /** The IP a validateWebhookUrl(url) call already checked, for the first hop. */
  resolvedIp?: string;
}

const FOLLOWED_REDIRECTS = new Set([301, 302, 303, 307, 308]);

// Headers that may cross to another origin (the CORS-safelisted ones plus the
// agent and encoding). Anything else — Authorization, Proxy-Authorization,
// Cookie, custom tokens — is dropped, as fetch() does.
const CROSS_ORIGIN_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "content-language",
  "content-type",
  "user-agent",
]);

/**
 * fetchPinned() that follows redirects the way fetch() does, safely: every
 * target is validated like a brand-new URL (scheme, private ranges) and
 * fetched over a connection pinned to the address that was checked.
 *
 * - 301/302 turn a POST into a GET without body; 303 turns anything but HEAD
 *   into a GET; 307/308 keep method and body. 300 and 305 are not followed.
 * - Only safelisted headers follow to another origin.
 * - One absolute deadline covers every hop, DNS lookups included.
 *
 * Throws RedirectRefusedError when a hop fails validation, the location is
 * invalid, or there are more than `maxRedirects` redirects. An error thrown
 * after the first response carries its status (firstStatusOf).
 */
export async function fetchPinnedFollowingRedirects(
  url: string,
  opts: FollowRedirectOptions,
): Promise<PinnedResponse & { url: string }> {
  const deadline = Date.now() + opts.timeoutMs;
  const maxRedirects = opts.maxRedirects ?? 3;
  let current = url;
  let method = opts.method.toUpperCase();
  let body = opts.body;
  let headers = { ...opts.headers };
  let knownIp = opts.resolvedIp;
  let firstStatus: number | undefined;

  try {
    for (let hop = 0; ; hop++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Tool timeout");

      let ip = knownIp;
      if (!ip) {
        const check = await validateWebhookUrl(current, {
          allowHttp: opts.allowHttp,
          dnsTimeoutMs: Math.min(DEFAULT_DNS_TIMEOUT_MS, remaining),
        });
        if (check.error === "DNS lookup timed out") throw new Error("Tool timeout");
        if (check.error || !check.resolvedIp) {
          throw new RedirectRefusedError(check.error ?? "Cannot resolve hostname");
        }
        ip = check.resolvedIp;
      }
      knownIp = undefined;

      const res = await fetchPinned(current, ip, {
        method,
        headers,
        body,
        timeoutMs: Math.max(1, deadline - Date.now()),
        maxResponseBytes: opts.maxResponseBytes,
        decompress: opts.decompress,
      });
      firstStatus ??= res.status;

      const location = res.headers.location;
      if (!FOLLOWED_REDIRECTS.has(res.status) || !location) {
        return { ...res, url: current };
      }
      if (hop >= maxRedirects) {
        throw new RedirectRefusedError(`Too many redirects (more than ${maxRedirects})`);
      }

      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new RedirectRefusedError("Invalid redirect location");
      }
      if (new URL(current).origin !== next.origin) {
        headers = Object.fromEntries(
          Object.entries(headers).filter(([k]) => CROSS_ORIGIN_HEADERS.has(k.toLowerCase())),
        );
      }
      const toGet =
        ((res.status === 301 || res.status === 302) && method === "POST") ||
        (res.status === 303 && method !== "GET" && method !== "HEAD");
      if (toGet) {
        method = "GET";
        body = undefined;
        headers = Object.fromEntries(
          Object.entries(headers).filter(([k]) => !/^content-(type|length)$/i.test(k)),
        );
      }
      current = next.toString();
    }
  } catch (err) {
    if (firstStatus !== undefined && err instanceof Error) {
      Object.assign(err, { firstStatus });
    }
    throw err;
  }
}
