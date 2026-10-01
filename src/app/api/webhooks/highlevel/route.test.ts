import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { NextRequest } from "next/server";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

// El secreto va en claro: decryptCredentials deja pasar texto plano (filas previas al cifrado).
const fakeSvc = {
  from: () => {
    const c: any = {
      select: () => c,
      eq: () => c,
      single: async () => ({ data: { credentials: { highlevel_webhook_secret: "sec" }, config: {} }, error: null }),
    };
    return c;
  },
};
mock.module("@supabase/supabase-js", { exports: { createClient: () => fakeSvc } });

const pulls: unknown[][] = [];
mock.module("@/features/inbox/services/highlevel-client.ts", {
  exports: {
    syncContactFromHL: async (...args: unknown[]) => {
      pulls.push(args);
    },
  },
});

let hlStatus: "active" | "inactive" | "error" = "active";
const activeChecks: unknown[][] = [];
mock.module("@/features/inbox/services/crm-sync.ts", {
  exports: {
    crmStatus: async (...args: unknown[]) => {
      activeChecks.push(args);
      return hlStatus;
    },
  },
});

const { POST } = await import("./route.ts");

function hook(token = "sec") {
  return new NextRequest(`http://localhost/api/webhooks/highlevel?wsid=ws_1&token=${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "ContactUpdate", contactId: "hl_9" }),
  });
}

test("con HighLevel como CRM activo, el webhook hace el pull", async () => {
  pulls.length = 0;
  hlStatus = "active";
  const res = await POST(hook());
  assert.deepEqual(await res.json(), { ok: true, synced: true });
  assert.deepEqual(pulls, [["ws_1", "hl_9"]]);
  assert.deepEqual(activeChecks.at(-1), ["ws_1", "highlevel"]);
});

test("si HighLevel no es EL CRM activo (HubSpot activo o conflicto), el webhook no escribe", async () => {
  pulls.length = 0;
  hlStatus = "inactive";
  const res = await POST(hook());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, synced: false, skipped: "crm_not_active" });
  assert.equal(pulls.length, 0);
});

// Un error de lectura NO es "no activo". Con 200 HighLevel no reintenta y el
// cambio del contacto se pierde; con 500 lo reintenta.
test("si no se pudo leer cuál es el CRM activo: 500 sin detalle técnico, para que HighLevel reintente", async () => {
  pulls.length = 0;
  hlStatus = "error";
  const res = await POST(hook());
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.skipped, undefined);
  assert.equal(pulls.length, 0);
});

test("un token equivocado sigue siendo 401 y no mira el CRM", async () => {
  pulls.length = 0;
  activeChecks.length = 0;
  const res = await POST(hook("otro"));
  assert.equal(res.status, 401);
  assert.equal(pulls.length + activeChecks.length, 0);
});
