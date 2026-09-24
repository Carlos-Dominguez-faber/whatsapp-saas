import assert from "node:assert/strict";
import { test } from "node:test";
import {
  sendText,
  sendTemplate,
  fetchKapsoTemplates,
  createKapsoTemplate,
  listPhoneNumbers,
  listAllPhoneNumbers,
  getMediaUrl,
  KapsoError,
} from "./kapso-client.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubFetch(response: Response): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return response;
  }) as typeof fetch;
  return { calls };
}

const originalFetch = globalThis.fetch;
function restoreFetch() {
  globalThis.fetch = originalFetch;
}

test("sendText posts to the Meta-mirrored endpoint with the phone_number_id in the path and extracts the wamid", async () => {
  const { calls } = stubFetch(
    jsonResponse(200, { messages: [{ id: "wamid_123" }] }),
  );
  try {
    const result = await sendText({
      apiKey: "key_1",
      phoneNumberId: "pn_1",
      to: "+15550000001",
      body: "hola",
    });
    assert.deepEqual(result, { id: "wamid_123", wamid: "wamid_123", status: "accepted" });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/meta\/whatsapp\/v24\.0\/pn_1\/messages$/);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers["X-API-Key"], "key_1");
    assert.deepEqual(calls[0].body, {
      messaging_product: "whatsapp",
      to: "+15550000001",
      type: "text",
      text: { body: "hola" },
    });
  } finally {
    restoreFetch();
  }
});

test("sendText throws KapsoError with Kapso's plain-string error format on a non-2xx response", async () => {
  stubFetch(jsonResponse(403, { error: "Active sandbox session required to send messages" }));
  try {
    await assert.rejects(
      () => sendText({ apiKey: "key_1", phoneNumberId: "pn_1", to: "+15550000001", body: "hola" }),
      (err: unknown) => {
        assert.ok(err instanceof KapsoError);
        assert.equal(err.status, 403);
        assert.equal(err.message, "Active sandbox session required to send messages");
        return true;
      },
    );
  } finally {
    restoreFetch();
  }
});

test("sendText throws KapsoError with Graph's nested error_user_msg format on a non-2xx response", async () => {
  stubFetch(
    jsonResponse(400, { error: { message: "raw graph text", error_user_msg: "Mensaje inválido" } }),
  );
  try {
    await assert.rejects(
      () => sendText({ apiKey: "key_1", phoneNumberId: "pn_1", to: "+15550000001", body: "hola" }),
      (err: unknown) => {
        assert.ok(err instanceof KapsoError);
        assert.equal(err.message, "Mensaje inválido");
        return true;
      },
    );
  } finally {
    restoreFetch();
  }
});

test("sendText falls back to a generic message when the error response has no recognizable field", async () => {
  stubFetch(new Response("not json", { status: 500 }));
  try {
    await assert.rejects(
      () => sendText({ apiKey: "key_1", phoneNumberId: "pn_1", to: "+15550000001", body: "hola" }),
      (err: unknown) => {
        assert.ok(err instanceof KapsoError);
        assert.equal(err.message, "Kapso sendText error 500");
        return true;
      },
    );
  } finally {
    restoreFetch();
  }
});

test("sendTemplate defaults the language to 'es' and includes components when given", async () => {
  const { calls } = stubFetch(jsonResponse(200, { messages: [{ id: "wamid_456" }] }));
  try {
    const result = await sendTemplate({
      apiKey: "key_1",
      phoneNumberId: "pn_1",
      to: "+15550000001",
      templateName: "confirmacion",
      components: [{ type: "body", parameters: [{ type: "text", text: "Ana" }] }],
    });
    assert.deepEqual(result, { id: "wamid_456", wamid: "wamid_456", status: "accepted" });
    assert.deepEqual(calls[0].body, {
      messaging_product: "whatsapp",
      to: "+15550000001",
      type: "template",
      template: {
        name: "confirmacion",
        language: { code: "es" },
        components: [{ type: "body", parameters: [{ type: "text", text: "Ana" }] }],
      },
    });
  } finally {
    restoreFetch();
  }
});

test("fetchKapsoTemplates returns the data array, and [] when the API omits it", async () => {
  stubFetch(jsonResponse(200, { data: [{ id: "tpl_1" }] }));
  try {
    assert.deepEqual(await fetchKapsoTemplates("key_1", "waba_1"), [{ id: "tpl_1" }]);
  } finally {
    restoreFetch();
  }
  stubFetch(jsonResponse(200, {}));
  try {
    assert.deepEqual(await fetchKapsoTemplates("key_1", "waba_1"), []);
  } finally {
    restoreFetch();
  }
});

test("createKapsoTemplate returns the id and status, defaulting status to PENDING when absent", async () => {
  stubFetch(jsonResponse(200, {}));
  try {
    const result = await createKapsoTemplate("key_1", "waba_1", {
      name: "confirmacion",
      language: "es",
      category: "UTILITY",
      components: [],
    });
    assert.deepEqual(result, { id: "", status: "PENDING" });
  } finally {
    restoreFetch();
  }
});

test("listPhoneNumbers maps the fields defensively, defaulting to null/'' when absent", async () => {
  stubFetch(
    jsonResponse(200, {
      data: [{ id: "num_1", display_phone_number: "+15550000001" }],
    }),
  );
  try {
    const result = await listPhoneNumbers("key_1", "waba_1");
    assert.deepEqual(result, [
      { id: "num_1", display_phone_number: "+15550000001", verified_name: null },
    ]);
  } finally {
    restoreFetch();
  }
});

test("listAllPhoneNumbers falls back to 'id' when phone_number_id is absent", async () => {
  stubFetch(
    jsonResponse(200, {
      data: [{ id: "num_1", business_account_id: "waba_1", status: "CONNECTED" }],
    }),
  );
  try {
    const result = await listAllPhoneNumbers("key_1");
    assert.equal(result[0].phone_number_id, "num_1");
    assert.equal(result[0].waba_id, "waba_1");
    assert.equal(result[0].status, "CONNECTED");
  } finally {
    restoreFetch();
  }
});

test("getMediaUrl returns null when no download_url or url is present", async () => {
  stubFetch(jsonResponse(200, { mime_type: "image/jpeg" }));
  try {
    assert.equal(await getMediaUrl("key_1", "media_1"), null);
  } finally {
    restoreFetch();
  }
});

test("getMediaUrl resolves the download URL, falling back to url when download_url is absent", async () => {
  stubFetch(
    jsonResponse(200, {
      url: "https://cdn.example/media_1",
      mime_type: "image/jpeg",
      download_url_expires_at: "2026-08-23T00:00:00Z",
    }),
  );
  try {
    const result = await getMediaUrl("key_1", "media_1");
    assert.deepEqual(result, {
      url: "https://cdn.example/media_1",
      mime_type: "image/jpeg",
      download_url: "https://cdn.example/media_1",
      download_url_expires_at: "2026-08-23T00:00:00Z",
    });
  } finally {
    restoreFetch();
  }
});
