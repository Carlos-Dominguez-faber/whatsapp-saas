import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { NextRequest, NextResponse } from "next/server";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

const memberCalls: unknown[][] = [];
let memberResult: unknown = { ok: true, userId: "user_1", role: "admin" };
mock.module("@/lib/auth/workspace-access.ts", {
  exports: {
    requireWorkspaceMember: async (...args: unknown[]) => {
      memberCalls.push(args);
      return memberResult;
    },
  },
});

let cfgResult: unknown = null;
let probeResult: unknown = null;
let portalResult: unknown = null;
let ensureResult: unknown = null;
const probes: unknown[][] = [];
const ensures: unknown[] = [];
mock.module("@/features/inbox/services/hubspot-client.ts", {
  exports: {
    HS_API_VERSION: "2026-09",
    hubSpotTokenFingerprint: (t: string) => `fp(${t})`,
    readHubSpotConfig: async () => cfgResult,
    hsFetch: async (...args: unknown[]) => {
      probes.push(args);
      return probeResult;
    },
    getHubSpotPortalId: async () => portalResult,
    ensureHubSpotProperties: async (token: string) => {
      ensures.push(token);
      return ensureResult;
    },
  },
});

const rpcCalls: Array<{ fn: string; args: unknown }> = [];
let rpcResult: { data: unknown; error: unknown } = { data: [], error: null };
mock.module("@supabase/supabase-js", {
  exports: {
    createClient: () => ({
      rpc: async (fn: string, args: unknown) => {
        rpcCalls.push({ fn, args });
        return rpcResult;
      },
    }),
  },
});

const { POST } = await import("./route.ts");
const params = { params: Promise.resolve({ id: "ws_1" }) };
const req = new NextRequest("http://localhost/api/workspace/ws_1/integrations/hubspot/test", { method: "POST" });

function reset() {
  memberCalls.length = 0;
  memberResult = { ok: true, userId: "user_1", role: "admin" };
  cfgResult = { ok: true, config: { token: "pat-A", pipelineId: null, dealStageId: null, propertiesReady: false } };
  probeResult = { ok: true, status: 200, json: { results: [] } };
  portalResult = { ok: true, portalId: "999" };
  ensureResult = { ok: true };
  probes.length = 0;
  ensures.length = 0;
  rpcCalls.length = 0;
  rpcResult = { data: [{ updated: true, portal_changed: false, links_cleared: 0, logs_cancelled: 0 }], error: null };
}

async function body(res: Response) {
  return (await res.json()) as { ok: boolean; error?: string; portalChanged?: boolean };
}

test("token válido: prueba, provisiona y marca lista SOLO para la huella del token probado", async () => {
  reset();
  assert.deepEqual(await body(await POST(req, params)), { ok: true, portalChanged: false });
  assert.deepEqual(memberCalls[0], ["ws_1", { minRole: "admin" }]);
  assert.deepEqual(probes[0], ["pat-A", "/crm/objects/2026-09/contacts?limit=1"]);
  assert.deepEqual(ensures, ["pat-A"]);
  assert.deepEqual(rpcCalls, [
    { fn: "mark_hubspot_ready", args: { p_workspace_id: "ws_1", p_token_fingerprint: "fp(pat-A)", p_portal_id: "999" } },
  ]);
});

test("PUT intercalado (el token cambió mientras probábamos): no se marca lista y se pide volver a probar", async () => {
  reset();
  rpcResult = { data: [{ updated: false, portal_changed: false, links_cleared: 0, logs_cancelled: 0 }], error: null };
  assert.deepEqual(await body(await POST(req, params)), {
    ok: false,
    error: "El token cambió mientras probábamos la conexión. Vuelve a probar.",
  });
});

test("cuenta de HubSpot distinta: ok con portalChanged para avisar al admin", async () => {
  reset();
  rpcResult = { data: [{ updated: true, portal_changed: true, links_cleared: 12, logs_cancelled: 1 }], error: null };
  assert.deepEqual(await body(await POST(req, params)), { ok: true, portalChanged: true });
});

test("errores de HubSpot → mensajes accionables, sin texto técnico ni marcar lista", async () => {
  const cases: Array<[() => void, string]> = [
    [() => (probeResult = { ok: false, status: 401, code: "unauthorized", body: "Authentication credentials not found" }), "El token de HubSpot no es válido. Revisa que lo copiaste completo."],
    [() => (probeResult = { ok: false, status: 403, code: "missing_scope", body: "" }), "El token no tiene todos los permisos. Revisa los scopes de la app privada: contactos, negocios, propiedades de contactos y comunicaciones."],
    [() => (probeResult = { ok: false, status: 429, code: "rate_limited", body: "" }), "HubSpot está limitando las consultas. Espera un minuto y vuelve a probar."],
    [() => (portalResult = { ok: false, code: "bad_response" }), "No pudimos conectar con HubSpot. Intenta de nuevo en unos minutos."],
    [() => (ensureResult = { ok: false, code: "phone_property_conflict" }), "Ya existe en tu HubSpot una propiedad «whatsapp_phone» que no es de texto con valor único. Corrígela o renómbrala y vuelve a probar."],
    [() => (ensureResult = { ok: false, code: "tags_property_conflict" }), "Ya existe en tu HubSpot una propiedad «whatsapp_tags» que no es de casillas de selección múltiple. Corrígela o renómbrala y vuelve a probar."],
    [() => (probeResult = { ok: false, status: 502, code: "http_error", body: "<html>" }), "No pudimos conectar con HubSpot. Intenta de nuevo en unos minutos."],
    // HubSpot RECHAZÓ crear la propiedad (400) — mensaje específico de
    // "no reintentes, avísanos", no el FALLBACK genérico que suena a error transitorio.
    [() => (ensureResult = { ok: false, code: "phone_property_create_rejected" }), "HubSpot no aceptó crear la propiedad «whatsapp_phone» en tu cuenta. Volver a probar no lo resuelve: avísanos para revisarlo."],
    [() => (ensureResult = { ok: false, code: "tags_property_create_rejected" }), "HubSpot no aceptó crear la propiedad «whatsapp_tags» en tu cuenta. Volver a probar no lo resuelve: avísanos para revisarlo."],
  ];
  for (const [arrange, message] of cases) {
    reset();
    arrange();
    const result = await body(await POST(req, params));
    assert.deepEqual(result, { ok: false, error: message });
    // Nunca el texto crudo de HubSpot (MISSING_OPTIONS, VALIDATION_ERROR, etc.) de cara al admin.
    assert.doesNotMatch(result.error ?? "", /MISSING_OPTIONS|VALIDATION_ERROR|PropertyValidationError/i);
    assert.equal(rpcCalls.length, 0);
  }
});

test("sin token guardado o integración inactiva no llama a HubSpot", async () => {
  reset();
  cfgResult = { ok: false, code: "not_configured" };
  assert.deepEqual(await body(await POST(req, params)), {
    ok: false,
    error: "Guarda primero el token de HubSpot. Si ya lo guardaste, revisa que la integración esté activa.",
  });
  assert.equal(probes.length, 0);
});

// Un error transitorio de lectura o un token que no se puede descifrar
// no son "no configurado" — el admin no tiene que "guardar primero el token" para arreglarlos.
test("error transitorio leyendo la config: mensaje propio, no 'guarda primero el token'", async () => {
  reset();
  cfgResult = { ok: false, code: "db_error" };
  assert.deepEqual(await body(await POST(req, params)), {
    ok: false,
    error: "No pudimos comprobar la conexión con HubSpot. Intenta de nuevo en unos minutos.",
  });
  assert.equal(probes.length, 0);
});

test("token que no se pudo descifrar: mensaje propio, no 'guarda primero el token'", async () => {
  reset();
  cfgResult = { ok: false, code: "decrypt_failed" };
  assert.deepEqual(await body(await POST(req, params)), {
    ok: false,
    error: "No pudimos leer el token guardado. Vuelve a pegarlo y guárdalo de nuevo.",
  });
  assert.equal(probes.length, 0);
});

test("si la RPC falla, error genérico de guardado", async () => {
  reset();
  rpcResult = { data: null, error: { message: "timeout" } };
  assert.deepEqual(await body(await POST(req, params)), {
    ok: false,
    error: "No pudimos guardar el estado de la conexión. Intenta de nuevo.",
  });
});

test("un manager recibe el 403 del helper: probar también ESCRIBE en HubSpot", async () => {
  reset();
  memberResult = { ok: false, response: NextResponse.json({ error: "Permisos insuficientes" }, { status: 403 }) };
  const res = await POST(req, params);
  assert.equal(res.status, 403);
  assert.equal(probes.length, 0);
});

// Sin sesión, el helper de auth corta antes de tocar la config.
test("sin sesión: 401 del helper, sin llamar a HubSpot ni leer la config", async () => {
  reset();
  memberResult = { ok: false, response: NextResponse.json({ error: "No autorizado" }, { status: 401 }) };
  const res = await POST(req, params);
  assert.equal(res.status, 401);
  assert.equal(probes.length, 0);
});
