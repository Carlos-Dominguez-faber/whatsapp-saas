import assert from "node:assert/strict";
import { mock, test } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

let member: unknown = { ok: true, userId: "u1", role: "viewer" };
let memberOpts: unknown = null;
mock.module("@/lib/auth/workspace-access.ts", {
  exports: {
    checkWorkspaceMember: async (_ws: string, opts: unknown) => {
      memberOpts = opts;
      return member;
    },
  },
});

let rpcArgs: Record<string, unknown> | null = null;
let rpcResult: { data: unknown; error: { code: string } | null } = { data: [], error: null };
mock.module("@supabase/supabase-js", {
  exports: {
    createClient: () => ({
      rpc: async (_fn: string, args: Record<string, unknown>) => {
        rpcArgs = args;
        return rpcResult;
      },
    }),
  },
});

const { getEvidenceAction } = await import("./evidence-actions.ts");
const WS = "11111111-1111-4111-8111-111111111111";
const input = {
  topicId: "22222222-2222-4222-8222-222222222222",
  outcome: "tag",
  tag: "vip",
  page: 1,
  fromIso: "2026-09-01T04:00:00.000Z",
  toIso: "2026-09-08T03:00:00.000Z",
};
const row = (i: number) => ({
  conversation_id: `c${i}`,
  contact_name: "Ana",
  contact_phone: "+15550000000",
  detected_at: "2026-09-02T10:00:00Z",
  evidence_body: "caro",
});

function reset() {
  member = { ok: true, userId: "u1", role: "viewer" };
  rpcArgs = null;
  rpcResult = { data: [row(1)], error: null };
}

test("viewer lee evidencia: pagina de a 20 pidiendo una fila extra para saber si hay más", async () => {
  reset();
  const r = await getEvidenceAction(WS, input);
  assert.deepEqual(memberOpts, { minRole: "viewer" });
  assert.deepEqual(rpcArgs, {
    p_workspace_id: WS,
    p_topic_id: input.topicId,
    p_from: input.fromIso,
    p_to: input.toIso,
    p_outcome: "tag",
    p_tag: "vip",
    p_limit: 21,
    p_offset: 20,
  });
  assert.deepEqual(r, { data: [row(1)], hasMore: false });
});

test("21 filas → devuelve 20 y hasMore", async () => {
  reset();
  rpcResult = { data: Array.from({ length: 21 }, (_, i) => row(i)), error: null };
  const r = await getEvidenceAction(WS, input);
  assert.ok("data" in r);
  if ("data" in r) {
    assert.equal(r.data.length, 20);
    assert.equal(r.hasMore, true);
  }
});

test("no miembro → error natural sin consultar", async () => {
  reset();
  member = { ok: false, status: 403 };
  assert.deepEqual(await getEvidenceAction(WS, input), { error: "No tienes acceso al análisis de este espacio." });
  assert.equal(rpcArgs, null);
});

test("entrada inválida (página con letras, topicId basura) → error de validación sin consultar", async () => {
  reset();
  assert.deepEqual(await getEvidenceAction(WS, { ...input, page: "dos" }), { error: "No se pudo abrir la evidencia con esos filtros." });
  assert.deepEqual(await getEvidenceAction(WS, { ...input, topicId: "x" }), { error: "No se pudo abrir la evidencia con esos filtros." });
  assert.equal(rpcArgs, null);
});

test("error de la RPC → mensaje natural", async () => {
  reset();
  rpcResult = { data: null, error: { code: "57014" } };
  assert.deepEqual(await getEvidenceAction(WS, input), { error: "No se pudo cargar la evidencia, intenta de nuevo en unos minutos." });
});

test("outcome distinto de tag pero con tag en el input → p_tag no se envía (la guarda no se puede borrar)", async () => {
  // Con outcome:"tag" en TODOS los demás tests, `p_tag: v.outcome === "tag" ? (v.tag ?? null) : null`
  // se puede reemplazar por `p_tag: v.tag ?? null` sin que ningún otro test lo note.
  reset();
  await getEvidenceAction(WS, { ...input, outcome: "booked", tag: "vip" });
  assert.equal(rpcArgs?.p_tag, null);
  assert.equal(rpcArgs?.p_outcome, "booked");
});

test("outcome tag sin etiqueta → error de validación sin consultar", async () => {
  reset();
  assert.deepEqual(await getEvidenceAction(WS, { ...input, tag: undefined }), {
    error: "No se pudo abrir la evidencia con esos filtros.",
  });
  assert.equal(rpcArgs, null);
});

test("rango invertido (toIso antes que fromIso) → error de validación sin consultar", async () => {
  reset();
  assert.deepEqual(await getEvidenceAction(WS, { ...input, fromIso: input.toIso, toIso: input.fromIso }), {
    error: "No se pudo abrir la evidencia con esos filtros.",
  });
  assert.equal(rpcArgs, null);
});

test("rango de más de 367 días → error de validación sin consultar", async () => {
  reset();
  assert.deepEqual(await getEvidenceAction(WS, { ...input, fromIso: "2024-01-01T00:00:00.000Z" }), {
    error: "No se pudo abrir la evidencia con esos filtros.",
  });
  assert.equal(rpcArgs, null);
});
