import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { NextRequest, NextResponse } from "next/server";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

const memberCalls: unknown[] = [];
let memberResult: unknown = { ok: true, userId: "user_1", role: "manager" };
mock.module("@/lib/auth/workspace-access.ts", {
  exports: {
    requireWorkspaceMember: async (...args: unknown[]) => {
      memberCalls.push(args);
      return memberResult;
    },
    readJsonBody: async (req: Request) => ({ ok: true, body: await req.json() }),
  },
});

/** Cada UPDATE/INSERT que el PUT intenta: sirve para afirmar que NO se escribió. */
let upserts: Array<Record<string, unknown>> = [];
/** Los .eq() de cada escritura: sirve para afirmar el filtro CAS. */
let writeEqs: Array<Array<[string, unknown]>> = [];
/** Escrituras que de verdad afectaron una fila (el CAS matcheó, o el INSERT entró). */
let applied: Array<Record<string, unknown>> = [];
/** Fila existente del mismo proveedor (lectura `.maybeSingle()` del PUT). */
let existingRow: Record<string, unknown> | null = null;
/** `updated_at` VIGENTE de la fila al momento del UPDATE (otro escritor pudo moverlo). */
let currentUpdatedAt: unknown = undefined;
let readError: { code: string; message: string } | null = null;
/** Error que devuelve la escritura: simula el índice uq_integrations_one_active_crm. */
let upsertError: { code: string; message: string } | null = null;

const T0 = "2026-01-01T15:04:05.123456+00:00";

const fakeSvc = {
  from: () => ({
    // `eq` es a la vez encadenable (PUT: .eq().eq().maybeSingle()) y awaitable
    // (GET: await select().eq()).
    select: () => {
      const chain: Record<string, unknown> = {
        eq: () => chain,
        maybeSingle: async () => ({ data: readError ? null : existingRow, error: readError }),
        then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
      };
      return chain;
    },
    update: (row: Record<string, unknown>) => {
      const eqs: Array<[string, unknown]> = [];
      const chain = {
        eq: (col: string, val: unknown) => {
          eqs.push([col, val]);
          return chain;
        },
        select: async () => {
          upserts.push(row);
          writeEqs.push(eqs);
          if (upsertError) return { data: null, error: upsertError };
          const cas = eqs.find(([c]) => c === "updated_at");
          const hit = cas !== undefined && cas[1] === currentUpdatedAt;
          if (hit) applied.push(row);
          return { data: hit ? [{ id: "int_1" }] : [], error: null };
        },
      };
      return chain;
    },
    insert: (row: Record<string, unknown>) => ({
      select: async () => {
        upserts.push(row);
        writeEqs.push([]);
        if (upsertError) return { data: null, error: upsertError };
        applied.push(row);
        return { data: [{ id: "int_1" }], error: null };
      },
    }),
  }),
};
mock.module("@supabase/supabase-js", {
  exports: { createClient: () => fakeSvc },
});

const { GET, PUT } = await import("./route.ts");
const params = { params: Promise.resolve({ id: "ws_1" }) };
const req = new NextRequest("http://localhost/api/workspace/ws_1/integrations");

test("GET requires the manager role", async () => {
  memberCalls.length = 0;
  memberResult = { ok: true, userId: "user_1", role: "manager" };
  const res = await GET(req, params);
  assert.equal(res.status, 200);
  assert.deepEqual(memberCalls[0], ["ws_1", { minRole: "manager" }]);
});

test("GET returns the 403 from the membership helper for a viewer", async () => {
  memberResult = {
    ok: false,
    response: NextResponse.json({ error: "Permisos insuficientes" }, { status: 403 }),
  };
  const res = await GET(req, params);
  assert.equal(res.status, 403);
});

// ── HubSpot y un solo CRM activo ──────────────────────────────────────────────

const { hubSpotTokenFingerprint } = await import("@/features/inbox/services/hubspot-client.ts");

function putJson(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/workspace/ws_1/integrations", {
    method: "POST", // NextRequest no acepta cuerpo con PUT en este runtime
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function resetCrm() {
  memberResult = { ok: true, userId: "user_1", role: "admin" };
  upserts = [];
  writeEqs = [];
  applied = [];
  existingRow = null;
  currentUpdatedAt = T0;
  readError = null;
  upsertError = null;
}

/** Fila existente leída en `T0` (el `updated_at` que el PUT usa como CAS). */
function existing(row: Record<string, unknown>) {
  existingRow = { ...row, updated_at: T0 };
}

test("PUT exige rol admin", async () => {
  resetCrm();
  memberCalls.length = 0;
  await PUT(putJson({ provider: "kapso" }), params);
  assert.deepEqual(memberCalls[0], ["ws_1", { minRole: "admin" }]);
});

test("la base rechaza un segundo CRM activo (23505): 409 con el mensaje accionable", async () => {
  resetCrm();
  upsertError = { code: "23505", message: 'duplicate key value violates unique constraint "uq_integrations_one_active_crm"' };
  const res = await PUT(putJson({ provider: "hubspot", credentials: { hubspot_token: "pat-1" } }), params);
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "Ya tienes HighLevel conectado como CRM. Desactívalo antes de conectar HubSpot.");
  assert.ok(!/duplicate|constraint|23505/.test(body.error), "sin detalle técnico");
});

test("la inversa: habilitar HighLevel con HubSpot activo", async () => {
  resetCrm();
  upsertError = { code: "23505", message: 'duplicate key value violates unique constraint "uq_integrations_one_active_crm"' };
  const res = await PUT(putJson({ provider: "highlevel", credentials: { highlevel_pit: "pit-1" } }), params);
  assert.equal(res.status, 409);
  assert.equal(
    ((await res.json()) as { error: string }).error,
    "Ya tienes HubSpot conectado como CRM. Desactívalo antes de conectar HighLevel.",
  );
});

test("otro error de la escritura sigue siendo 500 genérico", async () => {
  resetCrm();
  upsertError = { code: "08006", message: "connection failure" };
  const res = await PUT(putJson({ provider: "hubspot" }), params);
  assert.equal(res.status, 500);
  assert.equal(((await res.json()) as { error: string }).error, "No se pudo guardar la integración. Intenta de nuevo.");
});

test("token nuevo de HubSpot: se guarda cifrado, con su huella, y obliga a volver a probar", async () => {
  resetCrm();
  existing({ credentials: {}, config: { properties_ready: true, pipeline_id: "pl_1" } });
  const res = await PUT(putJson({ provider: "hubspot", enabled: true, credentials: { hubspot_token: "pat-na1-nuevo" } }), params);
  assert.equal(res.status, 200);
  const creds = upserts[0].credentials as Record<string, string>;
  assert.ok(creds.hubspot_token.startsWith("enc:") && !creds.hubspot_token.includes("pat-na1-nuevo"));
  assert.deepEqual(upserts[0].config, {
    properties_ready: false,
    pipeline_id: "pl_1",
    token_fingerprint: hubSpotTokenFingerprint("pat-na1-nuevo"),
  });
});

test("la huella es estable entre guardados del mismo token aunque el cifrado cambie", async () => {
  resetCrm();
  existing({ credentials: {}, config: {} });
  await PUT(putJson({ provider: "hubspot", credentials: { hubspot_token: "pat-estable" } }), params);
  const first = upserts[0];
  resetCrm();
  existing({ credentials: {}, config: {} });
  await PUT(putJson({ provider: "hubspot", credentials: { hubspot_token: "pat-estable" } }), params);
  const second = upserts[0];
  const c1 = (first.credentials as Record<string, string>).hubspot_token;
  const c2 = (second.credentials as Record<string, string>).hubspot_token;
  assert.notEqual(c1, c2, "IV aleatorio: el texto cifrado cambia");
  assert.equal(
    (first.config as Record<string, unknown>).token_fingerprint,
    (second.config as Record<string, unknown>).token_fingerprint,
  );
});

test("reenviar EL MISMO token no invalida la conexión (guardar el pipeline después de probar)", async () => {
  resetCrm();
  existing({
    credentials: { hubspot_token: "enc:v1:x:y" },
    config: { properties_ready: true, token_fingerprint: hubSpotTokenFingerprint("pat-igual") },
  });
  await PUT(putJson({ provider: "hubspot", credentials: { hubspot_token: "pat-igual" }, config: { pipeline_id: "pl_2" } }), params);
  const config = upserts[0].config as Record<string, unknown>;
  assert.equal(config.properties_ready, true);
  assert.equal(config.pipeline_id, "pl_2");
});

test("el token enmascarado no cambia nada", async () => {
  resetCrm();
  existing({ credentials: { hubspot_token: "enc:v1:x:y" }, config: { properties_ready: true, token_fingerprint: "abc" } });
  await PUT(putJson({ provider: "hubspot", credentials: { hubspot_token: "••••••" } }), params);
  assert.deepEqual(upserts[0].config, { properties_ready: true, token_fingerprint: "abc" });
  assert.equal((upserts[0].credentials as Record<string, string>).hubspot_token, "enc:v1:x:y");
});

test("el cliente no puede escribir las claves que maneja el servidor", async () => {
  resetCrm();
  existing({ credentials: {}, config: { portal_id: "111" } });
  await PUT(
    putJson({ provider: "hubspot", config: { properties_ready: true, token_fingerprint: "falsa", portal_id: "999", pipeline_id: "pl_1" } }),
    params,
  );
  assert.deepEqual(upserts[0].config, { portal_id: "111", pipeline_id: "pl_1" });
});

test("deshabilitar un CRM se guarda aunque el otro esté activo", async () => {
  resetCrm();
  const res = await PUT(putJson({ provider: "hubspot", enabled: false }), params);
  assert.equal(res.status, 200);
  assert.equal(upserts[0].enabled, false);
});

// ── El PUT escribe con CAS sobre `updated_at`. Un PUT que leyó la fila ANTES de que otro escritor
//    (otro PUT, mark_hubspot_ready) la cambiara no puede restaurar su foto vieja. ──

const CONCURRENT = "La configuración cambió mientras guardabas. Recarga e inténtalo de nuevo.";

test("CAS: el UPDATE de una fila existente va filtrado por tenant, proveedor y el updated_at leído", async () => {
  resetCrm();
  existing({ credentials: {}, config: { pipeline_id: "pl_1" } });
  const res = await PUT(putJson({ provider: "hubspot", config: { pipeline_id: "pl_2" } }), params);
  assert.equal(res.status, 200);
  assert.deepEqual(writeEqs[0], [["workspace_id", "ws_1"], ["provider", "hubspot"], ["updated_at", T0]]);
  assert.equal(applied.length, 1);
  assert.ok(!("updated_at" in upserts[0]), "updated_at lo mueve el trigger, no el PUT");
});

test("CAS: si otro escritor movió la fila entre la lectura y la escritura, 409 y no se escribe nada", async () => {
  resetCrm();
  existing({
    credentials: { hubspot_token: "enc:v1:A:A" },
    config: { properties_ready: true, token_fingerprint: "fpA", portal_id: "A", pipeline_id: "pl_1" },
  });
  currentUpdatedAt = "2026-01-01T15:04:09.000001+00:00";
  const res = await PUT(putJson({ provider: "hubspot", config: { pipeline_id: "pl_2" } }), params);
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { error: string }).error, CONCURRENT);
  assert.equal(applied.length, 0, "la foto vieja (credenciales/huella/portal A) no se restauró");
});

test("CAS: un primer guardado concurrente (la fila apareció entre lectura e INSERT) es 409, no pisa", async () => {
  resetCrm();
  upsertError = { code: "23505", message: 'duplicate key value violates unique constraint "integrations_workspace_id_provider_key"' };
  const res = await PUT(putJson({ provider: "kapso", credentials: { kapso_api_key: "k" } }), params);
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { error: string }).error, CONCURRENT);
  assert.deepEqual(writeEqs[0], [], "sin fila leída va por INSERT, nunca por upsert");
});

test("CAS: la misma carrera en el primer guardado de un CRM tampoco se confunde con 'otro CRM activo'", async () => {
  resetCrm();
  upsertError = { code: "23505", message: 'duplicate key value violates unique constraint "integrations_workspace_id_provider_key"' };
  const res = await PUT(putJson({ provider: "hubspot", credentials: { hubspot_token: "pat-1" } }), params);
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { error: string }).error, CONCURRENT);
});

test("un error leyendo la fila existente es 500 y no escribe (no se toma como 'no existe')", async () => {
  resetCrm();
  readError = { code: "57014", message: "canceling statement due to statement timeout" };
  const res = await PUT(putJson({ provider: "hubspot", config: { pipeline_id: "pl_2" } }), params);
  assert.equal(res.status, 500);
  assert.equal(((await res.json()) as { error: string }).error, "No se pudo guardar la integración. Intenta de nuevo.");
  assert.equal(upserts.length, 0);
});

test("un proveedor desconocido es 400 y no escribe", async () => {
  resetCrm();
  const res = await PUT(putJson({ provider: "salesforce" }), params);
  assert.equal(res.status, 400);
  assert.equal(upserts.length, 0);
});
