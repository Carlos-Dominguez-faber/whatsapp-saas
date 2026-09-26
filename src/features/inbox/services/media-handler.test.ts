import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

const { validateMediaUrl, downloadAndStoreMedia } = await import("./media-handler.ts");

test("each provider may only make us download from its own host (SEC-08)", () => {
  assert.equal(validateMediaUrl("ycloud", "https://api.ycloud.com/v2/media/x"), true);
  assert.equal(validateMediaUrl("kapso", "https://api.kapso.ai/media/x?token=t"), true);
  assert.equal(validateMediaUrl("ycloud", "https://api.kapso.ai/media/x"), false);
  assert.equal(validateMediaUrl("kapso", "https://api.ycloud.com/v2/media/x"), false);
  assert.equal(validateMediaUrl("kapso", "https://api.kapso.ai.evil.com/x"), false);
  assert.equal(validateMediaUrl("ycloud", "not a url"), false);
});

test("the API key goes to YCloud only; Kapso URLs are pre-signed", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response("nope", { status: 404 }); // stop before storage
  }) as typeof fetch;
  try {
    const base = { workspaceId: "ws", conversationId: "conv" };
    await downloadAndStoreMedia({ ...base, provider: "ycloud", link: "https://api.ycloud.com/m", apiKey: "yk" });
    await downloadAndStoreMedia({ ...base, provider: "kapso", link: "https://api.kapso.ai/m?token=t", apiKey: "leak" });
    assert.deepEqual(
      (calls[0].init?.headers as Record<string, string>)["X-API-Key"],
      "yk",
    );
    assert.equal(calls[1].init, undefined, "no headers (and no key) for Kapso");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a link on the wrong host is refused without any request", async () => {
  let called = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("", { status: 200 });
  }) as typeof fetch;
  try {
    const res = await downloadAndStoreMedia({
      provider: "kapso",
      link: "https://169.254.169.254/latest/meta-data",
      workspaceId: "ws",
      conversationId: "conv",
    });
    assert.equal(res, null);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});
