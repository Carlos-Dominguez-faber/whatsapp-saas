import assert from "node:assert/strict";
import { mock, test } from "node:test";

// Proveedor caído de punta a punta: ruta, fases, classifier y SDKs
// reales (ai, @ai-sdk/openai, supabase-js). Solo se reemplaza `fetch`, que los
// tres resuelven al momento de la llamada: OpenRouter responde 503 y PostgREST
// es un fake en memoria. Sin los cortes: 9 peticiones HTTP, 3 intentos
// quemados sobre una conversación sana y la ruta respondiendo 200.
mock.module("@/features/inbox/services/openrouter.ts", {
  exports: { getOpenRouterApiKey: async () => "test-key" },
});

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
process.env.CRON_SECRET = "s3cret";

const WS = "11111111-1111-1111-1111-111111111111";
const CONV = "22222222-2222-2222-2222-222222222222";
let openrouterCalls = 0;
let selectRounds = 0;
const rpcs: string[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "openrouter.ai") {
    openrouterCalls++;
    return json({ error: { message: "Service Unavailable", code: 503 } }, 503);
  }
  assert.equal(url.hostname, "supabase.test", `fetch inesperado a ${url}`);
  const rpc = /\/rest\/v1\/rpc\/(\w+)$/.exec(url.pathname)?.[1];
  if (rpc) {
    rpcs.push(rpc);
    if (rpc === "select_conversations_to_classify") {
      // Tres vueltas con la misma conversación: lo que pasaba cuando cada
      // fallo registrado soltaba el lease.
      return json(
        ++selectRounds <= 3
          ? [{ conversation_id: CONV, workspace_id: WS, contact_id: "c1", last_message_at: "2026-09-14T20:00:00Z" }]
          : [],
      );
    }
    if (rpc === "reserve_classification_tokens") return json("33333333-3333-3333-3333-333333333333");
    return json(1);
  }
  if (url.pathname.endsWith("/insight_topics")) return json([{ id: "t1", name: "Precio", description: "Objeción de precio" }]);
  if (url.pathname.endsWith("/messages")) {
    return json([{ id: "m1", direction: "in", sender_user_id: null, body: "está caro", created_at: "2026-09-14T19:00:00Z" }]);
  }
  throw new Error(`consulta inesperada ${url.pathname}`);
}) as typeof fetch;

const { GET } = await import("./route.ts");

test("OpenRouter con 503 → una sola petición, cero intentos, halt y 500 ok:false", async () => {
  const res = await GET(
    new Request("http://localhost:3010/api/cron/classify-topics", { headers: { Authorization: "Bearer s3cret" } }),
  );
  const body = await res.json();
  assert.equal(res.status, 500);
  assert.equal(body.ok, false);
  assert.deepEqual(body.classified, {
    classified: 0,
    failed: 0,
    skipped_workspaces: 0,
    halt: true,
    error: "provider_unavailable",
  });
  assert.equal(body.backfill.error, "skipped_after_halt");
  assert.equal(openrouterCalls, 1, "el SDK reintentó o la fase siguió llamando con el proveedor caído");
  assert.equal(rpcs.filter((r) => r === "record_classification_failure").length, 0, "la caída quemó intentos");
  // Sin usage no hay liquidación: la reserva queda con la estimación.
  assert.equal(rpcs.filter((r) => r === "settle_classification_tokens").length, 0);
  assert.deepEqual(rpcs.slice(0, 2), ["select_conversations_to_classify", "reserve_classification_tokens"]);
});
