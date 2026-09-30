import assert from "node:assert/strict";
import { mock, test } from "node:test";

// Proveedor caído de punta a punta: ruta, fases, classifier y SDKs
// reales (ai, @ai-sdk/openai, supabase-js). Solo se reemplaza `fetch`, que los
// tres resuelven al momento de la llamada: OpenRouter responde 503 y PostgREST
// es un fake en memoria. Each 503 defers its conversation (no attempt spent)
// and counts on the key it ran on; the third in a row takes the key down.
// It is the platform key: its workspaces are skipped, the run is NOT halted,
// and the route answers 500 so it shows in net._http_response.
mock.module("@/features/inbox/services/openrouter.ts", {
  exports: { getOpenRouterApiKey: async () => "test-key" },
});

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
process.env.CRON_SECRET = "s3cret";
process.env.OPENROUTER_API_KEY = "sk-platform-test";

const WS = "11111111-1111-1111-1111-111111111111";
const WS2 = "44444444-4444-4444-4444-444444444444";
const CONV = "22222222-2222-2222-2222-222222222222";
const CONV2 = "55555555-5555-5555-5555-555555555555";
const CONV3 = "66666666-6666-6666-6666-666666666666";
let openrouterCalls = 0;
let selectRounds = 0;
const rpcs: string[] = [];
let keyFailures = 0;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
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
      // A conversation of each workspace, then the first one again: what a
      // run would see if a failure released the lease.
      const rows = [
        [{ conversation_id: CONV, workspace_id: WS, contact_id: "c1", last_inbound_at: "2026-09-14T20:00:00Z" }],
        [{ conversation_id: CONV2, workspace_id: WS2, contact_id: "c2", last_inbound_at: "2026-09-14T20:00:00Z" }],
        [{ conversation_id: CONV3, workspace_id: WS, contact_id: "c3", last_inbound_at: "2026-09-14T20:00:00Z" }],
        [{ conversation_id: CONV, workspace_id: WS, contact_id: "c1", last_inbound_at: "2026-09-14T20:00:00Z" }],
      ];
      return json(rows[selectRounds++] ?? []);
    }
    if (rpc === "reserve_classification_tokens") return json("33333333-3333-3333-3333-333333333333");
    // The backfill's turn: no topic pending.
    if (rpc === "pending_backfill_topics") return json([]);
    // The key's health, as the SQL keeps it (breaker 3).
    if (rpc === "classification_key_gate") return json({ state: "up", failures: keyFailures });
    if (rpc === "record_classification_key_outcome") {
      const args = JSON.parse(String(init?.body ?? "{}"));
      assert.equal(args.p_outcome, "transient");
      assert.match(args.p_key_id, /^sha256:[0-9a-f]{64}$/, "the key's id must not carry the key");
      return json(++keyFailures >= args.p_breaker ? "down" : "up");
    }
    return json(1);
  }
  if (url.pathname.endsWith("/insight_topics")) {
    return json([{ id: "t1", name: "Precio", description: "Objeción de precio" }]);
  }
  if (url.pathname.endsWith("/integrations")) return json([]);
  if (url.pathname.endsWith("/messages")) {
    return json([{ id: "m1", direction: "in", sender_user_id: null, body: "está caro", created_at: "2026-09-14T19:00:00Z" }]);
  }
  throw new Error(`consulta inesperada ${url.pathname}`);
}) as typeof fetch;

const { GET } = await import("./route.ts");

test("OpenRouter con 503 → cada conversación espera sin gastar intento; a la tercera seguida la clave de la plataforma cae: sin halt, 500 visible", async () => {
  const res = await GET(
    new Request("http://localhost:3000/api/cron/classify-topics", { headers: { Authorization: "Bearer s3cret" } }),
  );
  const body = await res.json();
  assert.equal(res.status, 500);
  assert.equal(body.ok, false);
  assert.equal(body.platform_key_down, true);
  assert.deepEqual(body.classified, {
    classified: 0,
    failed: 0,
    deferred: 3,
    skipped_workspaces: 0,
    unavailable_workspaces: 1,
    halt: false,
  });
  assert.equal(openrouterCalls, 3, "el SDK reintentó o la fase siguió llamando con la clave caída");
  assert.equal(rpcs.filter((r) => r === "defer_classification").length, 3);
  assert.equal(rpcs.filter((r) => r === "record_classification_failure").length, 0, "la caída quemó intentos");
  // A 503 is an HTTP answer: nothing was generated, each reservation settles at 0.
  assert.equal(rpcs.filter((r) => r === "settle_classification_tokens").length, 3);
  assert.deepEqual(rpcs.slice(0, 4), [
    "pending_backfill_topics",
    "select_conversations_to_classify",
    "classification_key_gate",
    "reserve_classification_tokens",
  ]);
});
