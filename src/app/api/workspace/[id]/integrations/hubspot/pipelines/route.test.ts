import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { NextRequest, NextResponse } from "next/server";

const memberCalls: unknown[][] = [];
let memberResult: unknown = { ok: true, userId: "user_1", role: "manager" };
mock.module("@/lib/auth/workspace-access.ts", {
  exports: {
    requireWorkspaceMember: async (...args: unknown[]) => {
      memberCalls.push(args);
      return memberResult;
    },
  },
});

let pipelinesResult: unknown = [{ id: "default", name: "Ventas", stages: [] }];
const listCalls: unknown[] = [];
mock.module("@/features/inbox/services/hubspot-client.ts", {
  exports: {
    listHubSpotPipelines: async (ws: string) => {
      listCalls.push(ws);
      return pipelinesResult;
    },
  },
});

const { GET } = await import("./route.ts");
const params = { params: Promise.resolve({ id: "ws_1" }) };
const req = new NextRequest("http://localhost/api/workspace/ws_1/integrations/hubspot/pipelines");

test("lista los pipelines del workspace de la URL y exige manager", async () => {
  memberCalls.length = 0;
  memberResult = { ok: true, userId: "user_1", role: "manager" };
  pipelinesResult = [{ id: "default", name: "Ventas", stages: [] }];
  const res = await GET(req, params);
  assert.deepEqual(await res.json(), { ok: true, pipelines: [{ id: "default", name: "Ventas", stages: [] }] });
  assert.deepEqual(memberCalls[0], ["ws_1", { minRole: "manager" }]);
  assert.deepEqual(listCalls.at(-1), "ws_1");
});

test("si HubSpot falla, responde en español sin detalle técnico", async () => {
  memberResult = { ok: true, userId: "user_1", role: "manager" };
  pipelinesResult = null;
  const body = (await (await GET(req, params)).json()) as { ok: boolean; error: string };
  assert.deepEqual(body, { ok: false, error: "No se pudieron cargar los pipelines. Revisa el token y prueba la conexión." });
});

test("un agente recibe el 403 del helper y no se consulta HubSpot", async () => {
  listCalls.length = 0;
  memberResult = { ok: false, response: NextResponse.json({ error: "Permisos insuficientes" }, { status: 403 }) };
  const res = await GET(req, params);
  assert.equal(res.status, 403);
  assert.equal(listCalls.length, 0);
});
