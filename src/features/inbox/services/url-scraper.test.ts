import assert from "node:assert/strict";
import { test, mock } from "node:test";

// Each hop's URL → the check validateWebhookUrl returns for it.
let checks: Record<string, { error: string | null; resolvedIp?: string }> = {};
// Each fetched URL → the response fetchPinned returns for it.
let responses: Record<
  string,
  { status: number; headers: Record<string, string>; bodyText: string; truncated: boolean }
> = {};
let validated: Array<{ url: string; opts: unknown }> = [];
let fetched: Array<{ url: string; ip: string }> = [];

mock.module("@/features/tools/services/ssrf-guard.ts", {
  exports: {
    validateWebhookUrl: async (url: string, opts: unknown) => {
      validated.push({ url, opts });
      return checks[url] ?? { error: null, resolvedIp: "8.8.8.8" };
    },
    fetchPinned: async (url: string, ip: string) => {
      fetched.push({ url, ip });
      const res = responses[url];
      if (!res) throw new Error(`unexpected fetch of ${url}`);
      return res;
    },
  },
});

const { fetchUrlText } = await import("./url-scraper.ts");

const PAGE = "<html><body><p>Horarios de atención: lunes a viernes de 9 a 18 h.</p></body></html>";

function page(body = PAGE, contentType = "text/html; charset=utf-8") {
  return { status: 200, headers: { "content-type": contentType }, bodyText: body, truncated: false };
}

function reset() {
  checks = {};
  responses = {};
  validated = [];
  fetched = [];
}

test("fetches a public page over the pinned address and extracts its text", async () => {
  reset();
  responses["https://negocio.example.com/"] = page();
  const text = await fetchUrlText("https://negocio.example.com/");
  assert.match(text, /Horarios de atención/);
  assert.deepEqual(fetched, [{ url: "https://negocio.example.com/", ip: "8.8.8.8" }]);
  assert.deepEqual(validated[0].opts, { allowHttp: true });
});

test("refuses a URL whose address is private or internal", async () => {
  reset();
  checks["http://kong:8000/"] = { error: "Blocked: 172.18.0.5 is a private/internal IP address (SEC-08 anti-SSRF)" };
  await assert.rejects(() => fetchUrlText("http://kong:8000/"), /URL no permitida/);
  assert.equal(fetched.length, 0);
});

test("re-checks every redirect target and refuses one that points inside", async () => {
  reset();
  responses["https://negocio.example.com/"] = {
    status: 302,
    headers: { location: "http://169.254.169.254/latest/meta-data/" },
    bodyText: "",
    truncated: false,
  };
  checks["http://169.254.169.254/latest/meta-data/"] = {
    error: "Blocked: 169.254.169.254 is a private/internal IP address (SEC-08 anti-SSRF)",
  };
  await assert.rejects(() => fetchUrlText("https://negocio.example.com/"), /URL no permitida/);
  assert.deepEqual(
    validated.map((v) => v.url),
    ["https://negocio.example.com/", "http://169.254.169.254/latest/meta-data/"],
  );
  assert.equal(fetched.length, 1);
});

test("follows a relative redirect to a public page", async () => {
  reset();
  responses["http://negocio.example.com/"] = {
    status: 301,
    headers: { location: "/inicio" },
    bodyText: "",
    truncated: false,
  };
  responses["http://negocio.example.com/inicio"] = page();
  const text = await fetchUrlText("http://negocio.example.com/");
  assert.match(text, /lunes a viernes/);
});

test("gives up after too many redirects", async () => {
  reset();
  for (let i = 0; i < 5; i++) {
    responses[`https://negocio.example.com/${i}`] = {
      status: 302,
      headers: { location: `/${i + 1}` },
      bodyText: "",
      truncated: false,
    };
  }
  await assert.rejects(
    () => fetchUrlText("https://negocio.example.com/0"),
    /redirige demasiadas veces/,
  );
  assert.equal(fetched.length, 4);
});

test("refuses a response that is not text or HTML", async () => {
  reset();
  responses["https://negocio.example.com/logo.png"] = page("PNG", "image/png");
  await assert.rejects(
    () => fetchUrlText("https://negocio.example.com/logo.png"),
    /no devolvió una página de texto\/HTML/,
  );
});

test("refuses non-http schemes before any lookup", async () => {
  reset();
  await assert.rejects(() => fetchUrlText("file:///etc/passwd"), /Solo se permiten URLs http\(s\)/);
  assert.equal(validated.length, 0);
});
