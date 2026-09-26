/**
 * url-scraper.ts — fetches a public web page and extracts readable text for the
 * Knowledge Base. Dependency-free (runs on Vercel's serverless runtime).
 *
 * Not a full readability engine: strips scripts/styles/tags and decodes common
 * entities. Good enough for most marketing/info pages; can be upgraded later.
 */

import {
  fetchPinnedFollowingRedirects,
  RedirectRefusedError,
} from "@/features/tools/services/ssrf-guard";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_TEXT_LENGTH = 200_000;
const MAX_HTML_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : "";
    });
}

/** Converts an HTML document to plain readable text. */
export function htmlToText(html: string): string {
  let text = html;

  // Drop non-content regions entirely.
  text = text.replace(/<script[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");

  // Prefer the <body> when present.
  const bodyMatch = text.match(/<body[\s\S]*?>([\s\S]*?)<\/body>/i);
  if (bodyMatch) text = bodyMatch[1];

  // Block-level closings → line breaks so the text stays readable.
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|section|article|h[1-6]|li|tr|ul|ol)>/gi, "\n");

  // Strip the remaining tags, decode entities, collapse whitespace.
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);
  text = text
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text.slice(0, MAX_TEXT_LENGTH);
}

/**
 * Downloads `rawUrl` and returns its readable text. Throws a user-friendly
 * Error on invalid/blocked URLs, non-HTML responses, or fetch failures.
 *
 * Every hop — the URL itself and each redirect (at most 3) — is resolved and
 * checked against private/internal ranges, then fetched over a connection
 * pinned to that checked address (fetchPinnedFollowingRedirects), so neither
 * a redirect nor a DNS answer that changes between the check and the request
 * can reach the internal network. Compressed bodies are decoded, and the
 * 2 MB cap applies after decoding. The whole exchange shares one deadline.
 */
export async function fetchUrlText(rawUrl: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error("URL inválida");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Solo se permiten URLs http(s)");
  }

  let res;
  try {
    res = await fetchPinnedFollowingRedirects(url.toString(), {
      allowHttp: true,
      maxRedirects: MAX_REDIRECTS,
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AgenteWA-KB/1.0)",
        Accept: "text/html,application/xhtml+xml,text/plain",
        // deflate is left out: servers disagree on its framing (zlib or raw).
        "Accept-Encoding": "gzip, br",
      },
      timeoutMs: FETCH_TIMEOUT_MS,
      maxResponseBytes: MAX_HTML_BYTES,
      decompress: true,
    });
  } catch (err) {
    throw new Error(scrapeErrorMessage(err));
  }

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`La página respondió ${res.status}`);
  }
  const contentType = String(res.headers["content-type"] ?? "");
  if (
    !contentType.includes("text/html") &&
    !contentType.includes("text/plain") &&
    !contentType.includes("application/xhtml")
  ) {
    throw new Error("La URL no devolvió una página de texto/HTML");
  }

  const text = htmlToText(res.bodyText);
  if (text.length < 20) {
    throw new Error("No se pudo extraer contenido legible de la URL");
  }
  return text;
}

/** Turns a fetch failure into the message the KB form shows. */
function scrapeErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : "";
  if (err instanceof RedirectRefusedError) {
    if (message === "Cannot resolve hostname") {
      // Also what an IPv6-only site gets: only A records are looked up.
      return "No se encontró el dominio de la URL (o solo tiene IPv6, que no se admite)";
    }
    if (message.startsWith("Too many redirects")) {
      return "La página redirige demasiadas veces";
    }
    if (message === "Invalid redirect location") {
      return "La página redirige a una URL inválida";
    }
    return "URL no permitida";
  }
  if (message === "Tool timeout") return "La página tardó demasiado en responder";
  if (
    message.startsWith("Unsupported content-encoding") ||
    message.startsWith("Unreadable compressed body")
  ) {
    return "La página respondió en un formato comprimido que no se puede leer";
  }
  return "No se pudo descargar la URL";
}
