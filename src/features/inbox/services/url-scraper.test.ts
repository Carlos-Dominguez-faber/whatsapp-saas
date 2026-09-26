import assert from "node:assert/strict";
import { test, mock } from "node:test";

// The redirect-following, validation and pinning live in ssrf-guard (tested
// there); these tests pin how the scraper calls it and what the KB form shows.

class RedirectRefusedError extends Error {}

let outcome:
  | { status: number; headers: Record<string, string>; bodyText: string; truncated: boolean; url: string }
  | Error;
const followCalls: Array<{ url: string; opts: Record<string, unknown> }> = [];

mock.module("@/features/tools/services/ssrf-guard.ts", {
  exports: {
    RedirectRefusedError,
    fetchPinnedFollowingRedirects: async (url: string, opts: Record<string, unknown>) => {
      followCalls.push({ url, opts });
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  },
});

const { fetchUrlText } = await import("./url-scraper.ts");

const PAGE = "<html><body><p>Horarios de atención: lunes a viernes de 9 a 18 h.</p></body></html>";

function page(body = PAGE, contentType = "text/html; charset=utf-8") {
  return {
    status: 200,
    headers: { "content-type": contentType },
    bodyText: body,
    truncated: false,
    url: "https://negocio.example.com/",
  };
}

function reset() {
  outcome = page();
  followCalls.length = 0;
}

test("fetches a public page, following checked redirects, and extracts its text", async () => {
  reset();
  const text = await fetchUrlText("  https://negocio.example.com/  ");
  assert.match(text, /Horarios de atención/);
  assert.equal(followCalls[0].url, "https://negocio.example.com/");
  const opts = followCalls[0].opts;
  assert.equal(opts.allowHttp, true);
  assert.equal(opts.maxRedirects, 3);
  assert.equal(opts.decompress, true);
  assert.equal(opts.maxResponseBytes, 2_000_000);
  assert.equal(opts.method, "GET");
});

test("a URL or redirect into private ranges is refused as not allowed", async () => {
  reset();
  outcome = new RedirectRefusedError("Blocked: 169.254.169.254 is a private/internal IP address (SEC-08 anti-SSRF)");
  await assert.rejects(() => fetchUrlText("https://negocio.example.com/"), /^Error: URL no permitida$/);
});

test("each refusal and failure has its own message", async () => {
  const cases: Array<[Error, RegExp]> = [
    [new RedirectRefusedError("Cannot resolve hostname"), /No se encontró el dominio.*IPv6/],
    [new RedirectRefusedError("Too many redirects (more than 3)"), /redirige demasiadas veces/],
    [new RedirectRefusedError("Invalid redirect location"), /redirige a una URL inválida/],
    [new Error("Tool timeout"), /tardó demasiado en responder/],
    [new Error("Unsupported content-encoding: zstd"), /formato comprimido/],
    [new Error("Unreadable compressed body: incorrect header check"), /formato comprimido/],
    [new Error("ECONNRESET"), /No se pudo descargar la URL/],
  ];
  for (const [err, expected] of cases) {
    reset();
    outcome = err;
    await assert.rejects(() => fetchUrlText("https://negocio.example.com/"), expected, err.message);
  }
});

test("refuses a response that is not text or HTML, or not a 2xx", async () => {
  reset();
  outcome = page("PNG", "image/png");
  await assert.rejects(
    () => fetchUrlText("https://negocio.example.com/logo.png"),
    /no devolvió una página de texto\/HTML/,
  );
  reset();
  outcome = { ...page(), status: 404 };
  await assert.rejects(() => fetchUrlText("https://negocio.example.com/x"), /respondió 404/);
});

test("refuses non-http schemes before any request", async () => {
  reset();
  await assert.rejects(() => fetchUrlText("file:///etc/passwd"), /Solo se permiten URLs http\(s\)/);
  assert.equal(followCalls.length, 0);
});
