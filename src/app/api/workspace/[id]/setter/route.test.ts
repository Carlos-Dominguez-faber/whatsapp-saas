import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { NextRequest, NextResponse } from "next/server";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

const memberCalls: unknown[][] = [];
let memberResult: unknown = { ok: true, userId: "user_1", role: "manager" };
mock.module("@/lib/auth/workspace-access.ts", {
  exports: {
    requireWorkspaceMember: async (...args: unknown[]) => {
      memberCalls.push(args);
      return memberResult;
    },
    readJsonBody: async (req: Request) => {
      try {
        return { ok: true, body: await req.json() };
      } catch {
        return { ok: false, response: NextResponse.json({ error: "Body inválido" }, { status: 400 }) };
      }
    },
  },
});

type Row = Record<string, unknown>;
let inserted: Row[] = [];
let updateEqs: unknown[][] = [];
let existingConfig: Row | null = { id: "cfg_1" };
let existingError: unknown = null;
// Un `eq()` array por cada `select()` invocado, en orden — así un test puede afirmar
// que el GET y el pre-check del PATCH de verdad filtran por workspace_id, no solo
// que el resultado final sea el esperado (el fake antes ignoraba los `.eq()`).
let selectCalls: unknown[][][] = [];

const fakeSvc = {
  from: () => ({
    select: () => {
      const eqs: unknown[][] = [];
      selectCalls.push(eqs);
      const c: any = {
        eq: (k: string, v: unknown) => {
          eqs.push([k, v]);
          return c;
        },
        order: () => c,
        limit: () => c,
        maybeSingle: async () => ({ data: existingConfig, error: existingError }),
      };
      return c;
    },
    insert: (row: Row) => {
      inserted.push(row);
      const c: any = { select: () => c, single: async () => ({ data: { id: "cfg_new", ...row }, error: null }) };
      return c;
    },
    update: (row: Row) => {
      const eqs: unknown[][] = [];
      const c: any = {
        eq: (k: string, v: unknown) => {
          eqs.push([k, v]);
          return c;
        },
        select: () => c,
        single: async () => {
          updateEqs = eqs;
          return { data: { id: "cfg_1", ...row }, error: null };
        },
      };
      return c;
    },
  }),
};
mock.module("@supabase/supabase-js", { exports: { createClient: () => fakeSvc } });

const { GET, POST, PATCH } = await import("./route.ts");
const params = { params: Promise.resolve({ id: "ws_1" }) };

function jsonReq(body: unknown) {
  return new NextRequest("http://localhost/api/workspace/ws_1/setter", {
    method: "POST", // NextRequest no acepta cuerpo con PATCH en este runtime
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function invalidJsonReq() {
  return new NextRequest("http://localhost/api/workspace/ws_1/setter", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{ esto no es json",
  });
}

function reset() {
  memberCalls.length = 0;
  memberResult = { ok: true, userId: "user_1", role: "manager" };
  inserted = [];
  updateEqs = [];
  existingConfig = { id: "cfg_1" };
  existingError = null;
  selectCalls = [];
}

test("POST acepta la post-acción create_hubspot_deal", async () => {
  reset();
  const res = await POST(jsonReq({ name: "Setter", post_action: { type: "create_hubspot_deal" } }), params);
  assert.equal(res.status, 201);
  assert.equal((inserted[0].post_action as Row).type, "create_hubspot_deal");
  assert.equal(inserted[0].workspace_id, "ws_1");
});

test("POST rechaza una post-acción desconocida con 400 y no escribe", async () => {
  reset();
  const res = await POST(jsonReq({ name: "Setter", post_action: { type: "create_salesforce_deal" } }), params);
  assert.equal(res.status, 400);
  assert.equal(inserted.length, 0);
});

test("POST y PATCH exigen manager con el helper común; GET solo membresía activa", async () => {
  reset();
  await POST(jsonReq({ name: "Setter" }), params);
  await PATCH(jsonReq({ id: "cfg_1", name: "Otro" }), params);
  await GET(new NextRequest("http://localhost/api/workspace/ws_1/setter"), params);
  assert.deepEqual(memberCalls, [["ws_1", { minRole: "manager" }], ["ws_1", { minRole: "manager" }], ["ws_1"]]);
});

test("un agente recibe el 403 del helper y no escribe", async () => {
  reset();
  memberResult = { ok: false, response: NextResponse.json({ error: "Permisos insuficientes" }, { status: 403 }) };
  const res = await POST(jsonReq({ name: "Setter" }), params);
  assert.equal(res.status, 403);
  assert.equal(inserted.length, 0);
});

test("PATCH filtra el UPDATE por workspace, no solo por id", async () => {
  reset();
  const res = await PATCH(jsonReq({ id: "cfg_1", post_action: { type: "create_hubspot_deal" } }), params);
  assert.equal(res.status, 200);
  assert.deepEqual(updateEqs, [["id", "cfg_1"], ["workspace_id", "ws_1"]]);
});

test("PATCH de una config de otro workspace responde 404", async () => {
  reset();
  existingConfig = null;
  assert.equal((await PATCH(jsonReq({ id: "cfg_ajena", name: "x" }), params)).status, 404);
});

test("GET filtra el SELECT por workspace_id", async () => {
  reset();
  const res = await GET(new NextRequest("http://localhost/api/workspace/ws_1/setter"), params);
  assert.equal(res.status, 200);
  assert.equal(selectCalls.length, 1);
  assert.deepEqual(selectCalls[0], [["workspace_id", "ws_1"]]);
});

test("PATCH filtra el pre-check por id Y workspace_id, no solo por id", async () => {
  reset();
  const res = await PATCH(jsonReq({ id: "cfg_1", name: "Otro" }), params);
  assert.equal(res.status, 200);
  assert.equal(selectCalls.length, 1);
  assert.deepEqual(selectCalls[0], [["id", "cfg_1"], ["workspace_id", "ws_1"]]);
});

test("PATCH responde 500 (no 404) si el pre-check falla, sin filtrar el detalle al cliente", async () => {
  reset();
  existingConfig = null;
  existingError = { code: "PGRST000", message: "conexión perdida con el detalle interno" };
  const res = await PATCH(jsonReq({ id: "cfg_1", name: "x" }), params);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, "Error interno del servidor");
});

test("PATCH rechaza scoring.threshold no numérico con 400 y no toca la base", async () => {
  reset();
  const res = await PATCH(
    jsonReq({ id: "cfg_1", scoring: { threshold: "abc", max_score: 100 } }),
    params,
  );
  assert.equal(res.status, 400);
  assert.equal(selectCalls.length, 0);
  assert.equal(updateEqs.length, 0);
});

test("POST rechaza scoring.threshold no numérico con 400 y no inserta", async () => {
  reset();
  const res = await POST(
    jsonReq({ name: "Setter", scoring: { threshold: "abc", max_score: 100 } }),
    params,
  );
  assert.equal(res.status, 400);
  assert.equal(inserted.length, 0);
});

test("PATCH con JSON inválido responde 400 real (no mockeado como éxito) y no toca la base", async () => {
  reset();
  const res = await PATCH(invalidJsonReq(), params);
  assert.equal(res.status, 400);
  assert.equal(selectCalls.length, 0);
  assert.equal(updateEqs.length, 0);
});

test("sin sesión, el helper responde 401 y no escribe", async () => {
  reset();
  memberResult = { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const res = await POST(jsonReq({ name: "Setter" }), params);
  assert.equal(res.status, 401);
  assert.equal(inserted.length, 0);
});
