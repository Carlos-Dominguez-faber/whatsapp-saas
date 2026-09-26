import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

const { syncContactFromHL, syncContactToHL } = await import("./highlevel-client.ts");

type Row = Record<string, unknown>;

/**
 * PostgREST behind fetch: eq/in filters, the (workspace_id, hl_contact_id)
 * unique index (answering 23505 like Postgres), business_info and HighLevel.
 */
function fakeBackend(opts: {
  contacts: Row[];
  hlContact?: Row;
  countryCode?: string;
}) {
  const writes: Array<{ method: string; body: Row }> = [];
  const events: Row[] = [];
  const hlRequests: Array<{ method: string; body: Row | null }> = [];
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
    if (url.pathname.endsWith("/rest/v1/business_info")) {
      return json(200, opts.countryCode ? [{ structured: { default_country_code: opts.countryCode } }] : []);
    }
    if (url.pathname.endsWith("/rest/v1/events")) {
      events.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(null, { status: 201 });
    }
    if (url.hostname.includes("leadconnectorhq")) {
      hlRequests.push({ method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (method === "GET") return json(200, { contact: opts.hlContact });
      return json(200, { contact: { id: "hl_pushed" } });
    }
    if (url.pathname.endsWith("/rest/v1/contacts")) {
      const filters = [...url.searchParams.entries()].flatMap(([k, v]) => {
        if (v.startsWith("eq.")) return [(c: Row) => String(c[k]) === v.slice(3)];
        if (v.startsWith("in.(")) {
          const set = v.slice(4, -1).split(",").map((x) => x.replace(/^"|"$/g, ""));
          return [(c: Row) => set.includes(String(c[k]))];
        }
        return [];
      });
      const hits = opts.contacts.filter((c) => filters.every((f) => f(c)));
      if (method === "GET") return json(200, hits);
      const body = JSON.parse(String(init?.body ?? "{}")) as Row;
      writes.push({ method, body });
      const next = (row: Row) => ({ ...row, ...body });
      const clash = (row: Row) =>
        body.hl_contact_id &&
        opts.contacts.some(
          (c) => c !== row && c.workspace_id === next(row).workspace_id && c.hl_contact_id === body.hl_contact_id,
        );
      if (method === "PATCH") {
        if (hits.some(clash)) {
          return json(409, { code: "23505", message: "duplicate key value violates unique constraint" });
        }
        hits.forEach((h) => Object.assign(h, body));
      }
      if (method === "POST") opts.contacts.push({ id: `new_${opts.contacts.length}`, ...body });
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { fn, writes, events, hlRequests };
}

async function withFetch(fn: unknown, body: () => Promise<unknown>) {
  const original = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await body();
  } finally {
    globalThis.fetch = original;
    console.warn = originalWarn;
  }
}

test("a HighLevel contact links to the WhatsApp contact with the same phone, merging tags", async () => {
  const contacts: Row[] = [
    { id: "ct_1", workspace_id: "ws_1", phone: "+5215550001111", name: "Ana", email: null, tags: ["whatsapp", "lead"], hl_contact_id: null },
  ];
  const { fn } = fakeBackend({
    contacts,
    hlContact: { id: "hl_9", phone: "5215550001111", firstName: "Ana María", email: "ana@hl.com", tags: ["lead", "vip"] },
  });
  await withFetch(fn, () => syncContactFromHL("ws_1", "hl_9"));
  assert.equal(contacts.length, 1, "no second contact for the same person");
  assert.equal(contacts[0].hl_contact_id, "hl_9");
  assert.deepEqual(contacts[0].tags, ["whatsapp", "lead", "vip"]);
  assert.equal(contacts[0].phone, "+5215550001111", "the WhatsApp number is kept");
  assert.equal(contacts[0].name, "Ana", "a local name is never overwritten");
  assert.equal(contacts[0].email, "ana@hl.com", "an empty email is filled");
});

test("Mexico: HighLevel's +52 finds the contact WhatsApp stored as +52 1, and the other way", async () => {
  const withOne: Row[] = [
    { id: "ct_1", workspace_id: "ws_1", phone: "+5215512345678", tags: [], hl_contact_id: null },
  ];
  await withFetch(fakeBackend({ contacts: withOne, hlContact: { id: "hl_1", phone: "+525512345678" } }).fn, () =>
    syncContactFromHL("ws_1", "hl_1"),
  );
  assert.equal(withOne.length, 1);
  assert.equal(withOne[0].hl_contact_id, "hl_1");

  // Carlos's prod stores its contact as +52… without the 1.
  const withoutOne: Row[] = [
    { id: "ct_2", workspace_id: "ws_1", phone: "+525512345678", tags: [], hl_contact_id: null },
  ];
  await withFetch(fakeBackend({ contacts: withoutOne, hlContact: { id: "hl_2", phone: "+5215512345678" } }).fn, () =>
    syncContactFromHL("ws_1", "hl_2"),
  );
  assert.equal(withoutOne.length, 1);
  assert.equal(withoutOne[0].hl_contact_id, "hl_2");
});

test("a local-format HighLevel number takes the workspace's country code", async () => {
  const contacts: Row[] = [
    { id: "ct_1", workspace_id: "ws_1", phone: "+573001234567", tags: [], hl_contact_id: null },
  ];
  await withFetch(
    fakeBackend({ contacts, countryCode: "57", hlContact: { id: "hl_3", phone: "300 123 4567" } }).fn,
    () => syncContactFromHL("ws_1", "hl_3"),
  );
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].hl_contact_id, "hl_3");
});

test("an unknown HighLevel contact is created with a normalized phone", async () => {
  const contacts: Row[] = [];
  await withFetch(fakeBackend({ contacts, hlContact: { id: "hl_7", phone: "1 555 000 2222", tags: ["x"] } }).fn, () =>
    syncContactFromHL("ws_1", "hl_7"),
  );
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].phone, "+15550002222");
  assert.equal(contacts[0].hl_contact_id, "hl_7");
});

test("a phone already linked to another HighLevel contact is left alone", async () => {
  const contacts: Row[] = [
    { id: "ct_1", workspace_id: "ws_1", phone: "+15550003333", tags: [], hl_contact_id: "hl_other" },
  ];
  const { fn, writes } = fakeBackend({ contacts, hlContact: { id: "hl_new", phone: "+15550003333" } });
  await withFetch(fn, () => syncContactFromHL("ws_1", "hl_new"));
  assert.equal(writes.length, 0);
  assert.equal(contacts[0].hl_contact_id, "hl_other");
});

test("the link is looked up only inside the workspace", async () => {
  const contacts: Row[] = [
    { id: "ct_b", workspace_id: "ws_b", phone: "+15550004444", tags: [], hl_contact_id: "hl_4" },
  ];
  await withFetch(fakeBackend({ contacts, hlContact: { id: "hl_4", phone: "+15550004444" } }).fn, () =>
    syncContactFromHL("ws_a", "hl_4"),
  );
  assert.equal(contacts.length, 2, "ws_a gets its own contact");
  assert.equal(contacts[1].workspace_id, "ws_a");
});

test("pushing a contact whose HighLevel id another contact holds leaves an event, not a merge", async () => {
  const contacts: Row[] = [
    { id: "ct_1", workspace_id: "ws_1", phone: "+525512345678", name: "Ana", tags: [], hl_contact_id: null, email: null },
    { id: "ct_2", workspace_id: "ws_1", phone: "+5215512345678", name: "Ana", tags: [], hl_contact_id: "hl_pushed", email: null },
  ];
  const { fn, events } = fakeBackend({ contacts });
  await withFetch(fn, () => syncContactToHL("ws_1", "ct_1"));
  assert.equal(contacts[0].hl_contact_id, null, "not linked: the index refused it");
  assert.equal(events[0]?.type, "hl_contact_link_conflict");
  assert.equal((events[0]?.payload as Row).held_by, "ct_2");
});

test("tags go to HighLevel even when the local list is empty", async () => {
  const contacts: Row[] = [
    { id: "ct_1", workspace_id: "ws_1", phone: "+525512345678", name: "Ana", tags: [], hl_contact_id: "hl_1", email: null },
  ];
  const { fn, hlRequests } = fakeBackend({ contacts });
  await withFetch(fn, () => syncContactToHL("ws_1", "ct_1"));
  assert.deepEqual(hlRequests[0].body?.tags, []);
});
