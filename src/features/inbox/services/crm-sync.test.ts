import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

type Row = Record<string, unknown>;
let integrationRows: Row[] = [];
let integrationsError: { message: string } | null = null;

mock.module("@supabase/supabase-js", {
  exports: {
    createClient: () => ({
      from: (table: string) => {
        assert.equal(table, "integrations");
        const filters: Array<(r: Row) => boolean> = [];
        const chain: any = {
          select: () => chain,
          eq: (col: string, val: unknown) => {
            filters.push((r) => r[col] === val);
            return chain;
          },
          in: (col: string, vals: unknown[]) => {
            filters.push((r) => vals.includes(r[col]));
            return chain;
          },
          then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve(
              integrationsError
                ? { data: null, error: integrationsError }
                : { data: integrationRows.filter((r) => filters.every((f) => f(r))), error: null },
            ).then(resolve, reject),
        };
        return chain;
      },
    }),
  },
});

const hlCalls: unknown[][] = [];
let hlResult: { hl_id: string } | null = { hl_id: "hl_1" };
mock.module("./highlevel-client.ts", {
  exports: {
    syncContactToHL: async (...args: unknown[]) => {
      hlCalls.push(args);
      return hlResult;
    },
  },
});

const hsCalls: unknown[][] = [];
const pullCalls: unknown[][] = [];
type HsPushResult = { ok: true; hs_id: string } | { ok: false; code: string };
let hsResult: HsPushResult = { ok: true, hs_id: "hs_1" };
let hsThrows: Error | null = null;
let pullResult: unknown = { hs_id: "hs_1", filled: [] };
let pullThrows: Error | null = null;
mock.module("./hubspot-client.ts", {
  exports: {
    pushContactToHubSpot: async (...args: unknown[]) => {
      hsCalls.push(args);
      if (hsThrows) throw hsThrows;
      return hsResult;
    },
    syncContactFromHubSpot: async (...args: unknown[]) => {
      pullCalls.push(args);
      if (pullThrows) throw pullThrows;
      return pullResult;
    },
  },
});

const crm = await import("./crm-sync.ts");

function reset(rows: Row[] = []) {
  integrationRows = rows;
  integrationsError = null;
  hlCalls.length = 0;
  hsCalls.length = 0;
  pullCalls.length = 0;
  hlResult = { hl_id: "hl_1" };
  hsResult = { ok: true, hs_id: "hs_1" };
  hsThrows = null;
  pullResult = { hs_id: "hs_1", filled: [] };
  pullThrows = null;
}

const HL = { workspace_id: "ws_1", provider: "highlevel", enabled: true };
const HS = { workspace_id: "ws_1", provider: "hubspot", enabled: true };

test("sin CRM habilitado: no_crm y no llama a nadie", async () => {
  reset([{ ...HS, enabled: false }, { workspace_id: "ws_1", provider: "caldotcom", enabled: true }]);
  assert.deepEqual(await crm.syncContactToCrm("ws_1", "c1"), { ok: false, reason: "no_crm" });
  assert.equal(hlCalls.length + hsCalls.length, 0);
});

test("HighLevel habilitado: delega en syncContactToHL como antes", async () => {
  reset([HL]);
  assert.deepEqual(await crm.syncContactToCrm("ws_1", "c1", { addTags: ["x"] }), { ok: true, provider: "highlevel", id: "hl_1" });
  assert.deepEqual(hlCalls, [["ws_1", "c1"]]);
  assert.equal(hsCalls.length, 0);
});

test("HighLevel que falla devuelve failed", async () => {
  reset([HL]);
  hlResult = null;
  assert.deepEqual(await crm.syncContactToCrm("ws_1", "c1"), { ok: false, reason: "failed" });
});

test("HubSpot habilitado: delega con las opciones intactas", async () => {
  reset([HS]);
  assert.deepEqual(await crm.syncContactToCrm("ws_1", "c1", { removeTag: "vip" }), { ok: true, provider: "hubspot", id: "hs_1" });
  assert.deepEqual(hsCalls, [["ws_1", "c1", { removeTag: "vip" }]]);
});

test("los dos CRM habilitados (datos previos al índice): crm_conflict y NO sincroniza con ninguno", async () => {
  reset([HL, HS]);
  assert.deepEqual(await crm.syncContactToCrm("ws_1", "c1"), { ok: false, reason: "crm_conflict" });
  assert.equal(hlCalls.length + hsCalls.length, 0);
});

test("el CRM de otro workspace no cuenta; un error de lectura es failed", async () => {
  reset([{ ...HS, workspace_id: "ws_otro" }]);
  assert.deepEqual(await crm.syncContactToCrm("ws_1", "c1"), { ok: false, reason: "no_crm" });
  reset([HS]);
  integrationsError = { message: "timeout" };
  // Un error de lectura es failed CON su código, no "sin CRM" ni "no activo".
  assert.deepEqual(await crm.syncContactToCrm("ws_1", "c1"), { ok: false, reason: "failed", code: "crm_read_failed" });
  assert.equal(hsCalls.length, 0);
});

test("crmStatus: active solo para EL CRM activo; conflicto = inactive para ambos; error de lectura = error", async () => {
  reset([HS]);
  assert.equal(await crm.crmStatus("ws_1", "hubspot"), "active");
  assert.equal(await crm.crmStatus("ws_1", "highlevel"), "inactive");
  reset([HL, HS]);
  assert.equal(await crm.crmStatus("ws_1", "hubspot"), "inactive");
  assert.equal(await crm.crmStatus("ws_1", "highlevel"), "inactive");
  reset([]);
  assert.equal(await crm.crmStatus("ws_1", "highlevel"), "inactive");
  reset([HL]);
  integrationsError = { message: "x" };
  assert.equal(await crm.crmStatus("ws_1", "highlevel"), "error");
  assert.equal(await crm.crmStatus("ws_1", "hubspot"), "error");
});

test("syncContactManually en HubSpot: push con allTags y después pull", async () => {
  reset([HS]);
  assert.deepEqual(await crm.syncContactManually("ws_1", "c1"), { ok: true, provider: "hubspot", id: "hs_1" });
  // Solo el botón manual manda `allTags`, para que un log/deal/profile-only push no toque
  // etiquetas.
  assert.deepEqual(hsCalls, [["ws_1", "c1", { allTags: true }]]);
  assert.deepEqual(pullCalls, [["ws_1", "c1"]]);
});

test("syncContactManually: si el pull falla, el resultado es failed", async () => {
  reset([HS]);
  pullResult = null;
  assert.deepEqual(await crm.syncContactManually("ws_1", "c1"), { ok: false, reason: "failed" });
});

test("syncContactManually en HighLevel: solo push; con conflicto, nadie", async () => {
  reset([HL]);
  assert.deepEqual(await crm.syncContactManually("ws_1", "c1"), { ok: true, provider: "highlevel", id: "hl_1" });
  assert.equal(pullCalls.length, 0);
  reset([HL, HS]);
  assert.deepEqual(await crm.syncContactManually("ws_1", "c1"), { ok: false, reason: "crm_conflict" });
  assert.equal(hlCalls.length + hsCalls.length + pullCalls.length, 0);
});

// El código de un HubSpot fallido llega hasta el caller, no se pierde.
test("un HubSpot fallido lleva su código hasta el caller", async () => {
  reset([HS]);
  hsResult = { ok: false, code: "properties_not_ready" };
  assert.deepEqual(await crm.syncContactToCrm("ws_1", "c1"), { ok: false, reason: "failed", code: "properties_not_ready" });
});

// Un push de HubSpot fallido es `failed`, y el manual NO llama al pull.
test("HubSpot push fallido: failed, y syncContactManually no llama al pull", async () => {
  reset([HS]);
  hsResult = { ok: false, code: "not_configured" };
  assert.deepEqual(await crm.syncContactToCrm("ws_1", "c1"), { ok: false, reason: "failed", code: "not_configured" });
  reset([HS]);
  hsResult = { ok: false, code: "not_configured" };
  assert.deepEqual(await crm.syncContactManually("ws_1", "c1"), { ok: false, reason: "failed", code: "not_configured" });
  assert.equal(pullCalls.length, 0, "el pull no se llama si el push falló");
});

// Un proveedor que lanza (contrato roto o excepción inesperada) no revienta
// el caller: se atrapa, se loguea server-side y se devuelve failed con un código propio.
test("un proveedor que lanza no revienta syncContactToCrm ni syncContactManually", async () => {
  reset([HS]);
  hsThrows = new Error("decrypt: bad ciphertext");
  assert.deepEqual(await crm.syncContactToCrm("ws_1", "c1"), { ok: false, reason: "failed", code: "unexpected_error" });

  reset([HS]);
  pullThrows = new Error("network blew up");
  assert.deepEqual(await crm.syncContactManually("ws_1", "c1"), { ok: false, reason: "failed", code: "unexpected_error" });
});
