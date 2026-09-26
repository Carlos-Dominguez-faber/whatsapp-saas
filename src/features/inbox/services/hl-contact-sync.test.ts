import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

const { syncContactFromHL } = await import("./highlevel-client.ts");

type Row = Record<string, unknown>;

// A PostgREST-ish fake: eq filters on GET/PATCH, JSON body on POST/PATCH.
function fakeBackend(contacts: Row[], hlContact: Row) {
  const writes: Array<{ method: string; body: Row }> = [];
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    if (url.pathname.endsWith("/rest/v1/integrations")) {
      return json(200, [
        { credentials: { highlevel_pit: "pit" }, config: { location_id: "loc" }, enabled: true },
      ]);
    }
    if (url.hostname.includes("leadconnectorhq")) {
      return json(200, { contact: hlContact });
    }
    if (url.pathname.endsWith("/rest/v1/contacts")) {
      const filters = [...url.searchParams.entries()]
        .filter(([k, v]) => v.startsWith("eq."))
        .map(([k, v]) => [k, v.slice(3)] as const);
      const hits = contacts.filter((c) => filters.every(([k, v]) => String(c[k]) === v));
      if (method === "GET") return json(200, hits);
      const body = JSON.parse(String(init?.body ?? "{}")) as Row;
      writes.push({ method, body });
      if (method === "PATCH") hits.forEach((h) => Object.assign(h, body));
      if (method === "POST") contacts.push({ id: `new_${contacts.length}`, ...body });
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { fn, writes };
}

async function withFetch(fn: unknown, body: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = original;
  }
}

test("a HighLevel contact links to the WhatsApp contact with the same phone, merging tags", async () => {
  const contacts: Row[] = [
    { id: "ct_1", workspace_id: "ws_1", phone: "+5215550001111", tags: ["whatsapp", "lead"], hl_contact_id: null },
  ];
  const { fn, writes } = fakeBackend(contacts, {
    id: "hl_9",
    phone: "5215550001111",
    firstName: "Ana",
    tags: ["lead", "vip"],
  });
  await withFetch(fn, () => syncContactFromHL("ws_1", "hl_9"));
  assert.equal(contacts.length, 1, "no second contact for the same person");
  assert.equal(contacts[0].hl_contact_id, "hl_9");
  assert.deepEqual(contacts[0].tags, ["whatsapp", "lead", "vip"]);
  assert.equal(contacts[0].phone, "+5215550001111", "the WhatsApp number is kept");
  assert.equal(writes[0].method, "PATCH");
});

test("an unknown HighLevel contact is created with a normalized phone", async () => {
  const contacts: Row[] = [];
  const { fn } = fakeBackend(contacts, { id: "hl_7", phone: "1 555 000 2222", tags: ["x"] });
  await withFetch(fn, () => syncContactFromHL("ws_1", "hl_7"));
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].phone, "+15550002222");
  assert.equal(contacts[0].hl_contact_id, "hl_7");
});

test("a phone already linked to another HighLevel contact is left alone", async () => {
  const contacts: Row[] = [
    { id: "ct_1", workspace_id: "ws_1", phone: "+15550003333", tags: [], hl_contact_id: "hl_other" },
  ];
  const { fn, writes } = fakeBackend(contacts, { id: "hl_new", phone: "+15550003333" });
  const original = console.warn;
  console.warn = () => {};
  try {
    await withFetch(fn, () => syncContactFromHL("ws_1", "hl_new"));
  } finally {
    console.warn = original;
  }
  assert.equal(writes.length, 0);
  assert.equal(contacts[0].hl_contact_id, "hl_other");
});

test("the link is looked up only inside the workspace", async () => {
  const contacts: Row[] = [
    { id: "ct_b", workspace_id: "ws_b", phone: "+15550004444", tags: [], hl_contact_id: "hl_4" },
  ];
  const { fn } = fakeBackend(contacts, { id: "hl_4", phone: "+15550004444" });
  await withFetch(fn, () => syncContactFromHL("ws_a", "hl_4"));
  assert.equal(contacts.length, 2, "ws_a gets its own contact");
  assert.equal(contacts[0].workspace_id, "ws_b");
  assert.equal(contacts[1].workspace_id, "ws_a");
});
