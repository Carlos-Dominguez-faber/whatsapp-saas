import { resolve4 } from "node:dns/promises";
import { request as httpsRequest } from "node:https";

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
  /^::1$/, // IPv6 loopback
  /^fc|^fd/i, // IPv6 ULA
];

export interface WebhookUrlCheck {
  error: string | null;
  resolvedIp?: string;
}

/**
 * SEC-08: Validates a webhook URL before fetching, and returns the IPv4
 * address it resolved so the caller can pin the real request to that exact
 * address (see fetchPinned) instead of re-resolving DNS later — closing the
 * DNS-rebinding window where a low-TTL hostname could answer differently
 * between this check and the request.
 */
export async function validateWebhookUrl(url: string): Promise<WebhookUrlCheck> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: "Invalid URL" };
  }

  if (parsed.protocol !== "https:") {
    return { error: "Only HTTPS webhooks are allowed (SEC-08)" };
  }

  let addresses: string[] = [];
  try {
    addresses = await resolve4(parsed.hostname);
  } catch {
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
}

export interface PinnedResponse {
  status: number;
  bodyText: string;
  truncated: boolean;
}

/**
 * Sends a request to `url` over a connection pinned to `resolvedIp` — the
 * `lookup` override means no second DNS resolution happens between
 * validateWebhookUrl and this call. Never follows redirects: a 3xx comes
 * back with an empty body for the caller to reject, since following it
 * would require re-validating an entirely different host.
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

    const req = httpsRequest(
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
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: opts.method,
        headers: opts.headers,
        timeout: opts.timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          settled = true;
          resolve({ status, bodyText: "", truncated: false });
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        let truncated = false;

        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          if (total >= cap) {
            truncated = true;
            settled = true;
            req.destroy();
            resolve({ status, bodyText: Buffer.concat(chunks).toString("utf8"), truncated });
            return;
          }
          const remaining = cap - total;
          const piece = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
          chunks.push(piece);
          total += piece.length;
          if (chunk.length > remaining) {
            truncated = true;
            settled = true;
            req.destroy();
            resolve({ status, bodyText: Buffer.concat(chunks).toString("utf8"), truncated });
          }
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          resolve({ status, bodyText: Buffer.concat(chunks).toString("utf8"), truncated });
        });
        res.on("error", (err) => {
          if (settled) return;
          settled = true;
          reject(err);
        });
      },
    );

    deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error("Tool timeout"));
    }, opts.timeoutMs);

    req.on("timeout", () => req.destroy(new Error("Tool timeout")));
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    if (opts.body) req.write(opts.body);
    req.end();
  }).finally(() => clearTimeout(deadline));
}
