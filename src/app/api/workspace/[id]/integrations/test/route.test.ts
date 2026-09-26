import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { NextRequest } from "next/server";

// POST /api/workspace/[id]/integrations/test — "Probar conexión" with the
// values on screen, saved or not.

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

const memberCalls: unknown[][] = [];
mock.module("@/lib/auth/workspace-access.ts", {
  exports: {
    requireWorkspaceMember: async (...args: unknown[]) => {
      memberCalls.push(args);
      return { ok: true, userId: "user_1", role: "manager" };
    },
    readJsonBody: async (req: Request) => ({ ok: true, body: await req.json() }),
  },
});
mock.module("@/shared/lib/integration-secrets.ts", {
  exports: { decryptCredentials: async (c: unknown) => c ?? {} },
});

type Num = {
  phone_number_id: string;
  waba_id: string;
  display_phone_number: string;
  verified_name: string | null;
  status: string | null;
  kind: string | null;
};
const PROD: Num = {
  phone_number_id: "pn_prod",
  waba_id: "waba_1",
  display_phone_number: "+1 555-000-0001",
  verified_name: "Cliente A",
  status: "CONNECTED",
  kind: "production",
};
const OTHER: Num = { ...PROD, phone_number_id: "pn_other", display_phone_number: "+1 555-000-0002", verified_name: "Cliente B" };
const SANDBOX: Num = { ...PROD, phone_number_id: "pn_sandbox", kind: "sandbox", status: null };

let numbers: Num[] = [];
const keysUsed: string[] = [];
class KapsoError extends Error {
  status: number;
  constructor(status: number) {
    super(`kapso ${status}`);
    this.status = status;
  }
}
let kapsoFailure: Error | null = null;
mock.module("@/features/inbox/services/kapso-client.ts", {
  exports: {
    KapsoError,
    listAllPhoneNumbers: async (apiKey: string) => {
      keysUsed.push(apiKey);
      if (kapsoFailure) throw kapsoFailure;
      return numbers;
    },
    rankKapsoNumbers: (n: Num[]) => n,
  },
});

let storedRow: Record<string, unknown> | null = null;
const fakeSvc = {
  from: () => ({
    select: () => {
      const q: any = {
        eq: () => q,
        in: () => q,
        maybeSingle: async () => ({ data: storedRow, error: null }),
      };
      return q;
    },
  }),
};
mock.module("@supabase/supabase-js", { exports: { createClient: () => fakeSvc } });

const { POST } = await import("./route.ts");
const params = { params: Promise.resolve({ id: "ws_1" }) };
const post = async (body: unknown) => {
  const res = await POST(
    new NextRequest("http://localhost/api/workspace/ws_1/integrations/test", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    params,
  );
  return { status: res.status, json: await res.json() };
};

function reset() {
  memberCalls.length = 0;
  keysUsed.length = 0;
  kapsoFailure = null;
  numbers = [PROD, OTHER];
  storedRow = {
    provider: "kapso",
    credentials: { kapso_api_key: "stored_key" },
    config: { phone_number_id: "pn_prod", waba_id: "waba_1" },
  };
}

test("only managers can test (it uses the stored credentials)", async () => {
  reset();
  await post({ provider: "kapso" });
  assert.deepEqual(memberCalls[0], ["ws_1", { minRole: "manager" }]);
});

test("a typed key is tested instead of the stored one", async () => {
  reset();
  const { json } = await post({ provider: "kapso", apiKey: "typed_key", config: { phone_number_id: "pn_prod" } });
  assert.equal(json.ok, true);
  assert.deepEqual(keysUsed, ["typed_key"]);
});

test("the masked placeholder falls back to the stored key", async () => {
  reset();
  await post({ provider: "kapso", apiKey: "••••••" });
  assert.deepEqual(keysUsed, ["stored_key"]);
});

test("unsaved ids on screen are what gets checked", async () => {
  reset();
  const { json } = await post({ provider: "kapso", config: { phone_number_id: "pn_missing" } });
  assert.equal(json.ok, false);
  assert.match(json.error, /no existe en este proyecto/);
});

test("with a typed key, a failure lists the project's numbers to choose from", async () => {
  reset();
  const { json } = await post({ provider: "kapso", apiKey: "typed_key", config: { phone_number_id: "" } });
  assert.equal(json.ok, false);
  assert.deepEqual(
    json.phoneNumbers.map((n: Num) => n.phone_number_id),
    ["pn_prod", "pn_other"],
  );
});

test("with the stored key, a failure never lists the project's numbers", async () => {
  reset();
  const { json } = await post({ provider: "kapso", config: { phone_number_id: "pn_missing" } });
  assert.equal(json.ok, false);
  assert.equal(json.phoneNumbers, undefined);
  const ok = await post({ provider: "kapso" });
  assert.deepEqual(ok.json.phoneNumbers.map((n: Num) => n.phone_number_id), ["pn_prod"], "only the match");
});

test("sandbox and WABA warnings both come back", async () => {
  reset();
  numbers = [SANDBOX];
  const { json } = await post({ provider: "kapso", config: { phone_number_id: "pn_sandbox", waba_id: "waba_other" } });
  assert.equal(json.ok, true);
  assert.equal(json.warnings.length, 2);
});

test("no key anywhere asks for one, in Spanish", async () => {
  reset();
  storedRow = null;
  const { json } = await post({ provider: "kapso" });
  assert.equal(json.ok, false);
  assert.equal(json.error, "Escribe la API Key de Kapso para probar la conexión");
  assert.equal(keysUsed.length, 0);
});

test("a rejected Kapso key reads as such", async () => {
  reset();
  kapsoFailure = new KapsoError(401);
  const { json } = await post({ provider: "kapso", apiKey: "bad" });
  assert.equal(json.error, "API Key inválida o sin acceso");
});

test("YCloud answers in Spanish when the key is refused", async () => {
  reset();
  storedRow = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
  try {
    const { json } = await post({ provider: "ycloud", apiKey: "yk" });
    assert.equal(json.ok, false);
    assert.equal(json.error, "API Key inválida o sin acceso");
  } finally {
    globalThis.fetch = realFetch;
  }
});
