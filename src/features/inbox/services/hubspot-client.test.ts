import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

// ── Base en memoria. Los filtros SE APLICAN y cada escritura queda registrada
//    con sus .eq(): los tests afirman el filtro workspace_id en cada UPDATE
//    alcanzado, no solo en el SELECT. ──────────────────────────────────────────

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {
  integrations: [],
  contacts: [],
  events: [],
  conversations: [],
  messages: [],
};
const writes: Array<{ table: string; patch: Row; eqs: Array<[string, unknown]> }> = [];
let contactUpdateError: { code: string; message: string } | null = null;

// ── Simula un error TRANSITORIO de lectura (504/timeout de PostgREST): la Nra llamada .select()
//    a esa tabla devuelve `error` en vez de datos. 1-based, por tabla, para poder apuntar a un
//    read específico dentro de una misma función (p. ej. la 2da lectura de "contacts"). ─────────
let selectErrorPlan: Record<string, number[]> = {};
let selectCallCounts: Record<string, number> = {};
/** Cada SELECT con sus .eq(), para contar las lecturas de la config de HubSpot. */
const reads: Array<{ table: string; eqs: Array<[string, unknown]> }> = [];
/** Se llama DESPUÉS de cada lectura de la config de HubSpot (n = 1, 2, …): simula un PUT en medio. */
let afterHubSpotConfigRead: ((n: number) => void) | null = null;

function hubSpotConfigReads(): number {
  return reads.filter((r) => r.table === "integrations" && r.eqs.some(([c, v]) => c === "provider" && v === "hubspot")).length;
}

function query(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  const eqs: Array<[string, unknown]> = [];
  let mode: "select" | "update" = "select";
  let patch: Row = {};
  let order: { col: string; ascending: boolean } | null = null;
  let max: number | null = null;

  function run(): { data: Row[] | null; error: { code?: string; message: string } | null } {
    const all = tables[table];
    if (!all) return { data: null, error: { message: `tabla no esperada: ${table}` } };
    if (mode === "select") {
      reads.push({ table, eqs: [...eqs] });
      selectCallCounts[table] = (selectCallCounts[table] ?? 0) + 1;
      if (selectErrorPlan[table]?.includes(selectCallCounts[table])) {
        return { data: null, error: { message: "simulated transient read failure" } };
      }
    }
    let rows = all.filter((r) => filters.every((f) => f(r)));
    if (mode === "update") {
      writes.push({ table, patch, eqs: [...eqs] });
      if (table === "contacts" && contactUpdateError) return { data: null, error: contactUpdateError };
      for (const r of rows) Object.assign(r, patch);
      return { data: rows, error: null };
    }
    if (order) {
      const { col, ascending } = order;
      rows = [...rows].sort((a, b) => String(a[col]).localeCompare(String(b[col])) * (ascending ? 1 : -1));
    }
    if (max !== null) rows = rows.slice(0, max);
    // Snapshot, not a live reference: a real Supabase client returns a deserialized copy, so a
    // row mutated after this read must NOT be visible through the object the caller is holding
    // (that's exactly the race a guarded UPDATE has to protect against).
    const snapshot = rows.map((r) => ({ ...r }));
    if (table === "integrations" && eqs.some(([c, v]) => c === "provider" && v === "hubspot")) {
      afterHubSpotConfigRead?.(hubSpotConfigReads());
    }
    return { data: snapshot, error: null };
  }

  const chain: any = {
    select: () => chain,
    eq: (col: string, val: unknown) => {
      eqs.push([col, val]);
      filters.push((r) => r[col] === val);
      return chain;
    },
    in: (col: string, vals: unknown[]) => {
      filters.push((r) => vals.includes(r[col]));
      return chain;
    },
    // PostgREST-shaped OR filter, e.g. "name.is.null,name.eq." — enough for the guarded
    // updates in syncContactFromHubSpot (is.null / eq.<value>, OR'd together).
    or: (expr: string) => {
      const conditions = expr.split(",").map((part) => {
        const [col, op, ...rest] = part.split(".");
        return { col, op, val: rest.join(".") };
      });
      filters.push((r) =>
        conditions.some(({ col, op, val }) => {
          if (op === "is") return val === "null" ? r[col] === null || r[col] === undefined : r[col] === val;
          if (op === "eq") return r[col] === val;
          // "match" emula el operador POSIX `~` de PostgREST (regex), usado para el guard de
          // "vacío o solo espacios" del pull de HubSpot.
          if (op === "match") return new RegExp(val).test(String(r[col] ?? ""));
          return false;
        }),
      );
      return chain;
    },
    order: (col: string, opts?: { ascending?: boolean }) => {
      order = { col, ascending: opts?.ascending ?? true };
      return chain;
    },
    limit: (n: number) => {
      max = n;
      return chain;
    },
    update: (row: Row) => {
      mode = "update";
      patch = row;
      return chain;
    },
    insert: async (row: Row) => {
      tables[table].push(row);
      return { data: null, error: null };
    },
    maybeSingle: async () => {
      const r = run();
      return { data: r.data?.[0] ?? null, error: r.error };
    },
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(run()).then(resolve, reject),
  };
  return chain;
}

// ── link_hubspot_contact: emula la RPC con sus TRES condiciones. Un UPDATE directo
//    a contacts no pasa por acá, así que los tests del enlace fallan si se vuelve a él. ─────────
const rpcCalls: Array<{ fn: string; args: Row }> = [];
function hubSpotReadyFor(args: Row): boolean {
  return tables.integrations.some((i) => {
    const cfg = (i.config ?? {}) as Row;
    return (
      i.workspace_id === args.p_workspace_id &&
      i.provider === "hubspot" &&
      i.enabled === true &&
      cfg.token_fingerprint === args.p_token_fingerprint &&
      cfg.properties_ready === true
    );
  });
}

// ── read_hubspot_link: emula la RPC. Cuenta como una lectura de "contacts" (selectErrorPlan
//    y `reads`), porque reemplaza al SELECT directo del contacto en pushContactToHubSpot. ─────────
function readHubSpotLink(args: Row) {
  reads.push({ table: "contacts", eqs: [["id", args.p_contact_id], ["workspace_id", args.p_workspace_id]] });
  selectCallCounts.contacts = (selectCallCounts.contacts ?? 0) + 1;
  if (selectErrorPlan.contacts?.includes(selectCallCounts.contacts)) {
    return { data: null, error: { message: "simulated transient read failure" } };
  }
  if (!hubSpotReadyFor(args)) {
    return { data: [{ ready: false, id: null, name: null, phone: null, email: null, tags: null, hs_contact_id: null }], error: null };
  }
  const rows = tables.contacts
    .filter((c) => c.id === args.p_contact_id && c.workspace_id === args.p_workspace_id)
    .map((c) => ({ ready: true, id: c.id, name: c.name, phone: c.phone, email: c.email, tags: c.tags, hs_contact_id: c.hs_contact_id }));
  return { data: rows, error: null };
}

async function rpc(fn: string, args: Row) {
  rpcCalls.push({ fn, args });
  if (fn === "read_hubspot_link") return readHubSpotLink(args);
  if (fn !== "link_hubspot_contact") return { data: null, error: { message: `rpc no esperada: ${fn}` } };
  if (contactUpdateError) return { data: null, error: contactUpdateError };
  const ready = hubSpotReadyFor(args);
  const contact = tables.contacts.find((c) => c.id === args.p_contact_id && c.workspace_id === args.p_workspace_id);
  if (!ready || !contact) return { data: false, error: null };
  contact.hs_contact_id = args.p_hs_contact_id;
  return { data: true, error: null };
}

mock.module("@supabase/supabase-js", {
  exports: { createClient: () => ({ from: (t: string) => query(t), rpc }) },
});

// ── fetch stub: rutas por método + regex; respuestas en cola (la última queda fija) ──

type Reply = (init: RequestInit) => Response | Promise<Response>;
const json =
  (status: number, body: unknown, headers: Record<string, string> = {}): Reply =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

let routes: Array<{ method: string; pattern: RegExp; replies: Reply[] }> = [];
const calls: Array<{ method: string; url: string; body: unknown; auth: string | null }> = [];

function on(method: string, pattern: RegExp, ...replies: Reply[]) {
  routes.push({ method, pattern, replies });
}

globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = String(input);
  const method = (init.method ?? "GET").toUpperCase();
  const headers = (init.headers ?? {}) as Record<string, string>;
  calls.push({
    method,
    url,
    body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    auth: headers.Authorization ?? null,
  });
  const route = routes.find((r) => r.method === method && r.pattern.test(url));
  if (!route) throw new Error(`fetch no esperado: ${method} ${url}`);
  const reply = route.replies.length > 1 ? route.replies.shift()! : route.replies[0];
  return reply(init);
}) as typeof fetch;

const hs = await import("./hubspot-client.ts");
const { encryptCredentials } = await import("@/shared/lib/integration-secrets.ts");

const WS = "ws_1";
const BASE = "https://api.hubapi.com";

function reset() {
  for (const k of Object.keys(tables)) tables[k] = [];
  writes.length = 0;
  rpcCalls.length = 0;
  contactUpdateError = null;
  selectErrorPlan = {};
  selectCallCounts = {};
  reads.length = 0;
  afterHubSpotConfigRead = null;
  routes = [];
  calls.length = 0;
}

/** Huella del token de `connect()`: la que escribe el PUT y exige link_hubspot_contact. */
const FP = hs.hubSpotTokenFingerprint("pat-test");

function connect(config: Row = { properties_ready: true, pipeline_id: "pl_1", deal_stage_id: "st_1" }) {
  tables.integrations.push({
    workspace_id: WS,
    provider: "hubspot",
    enabled: true,
    credentials: { hubspot_token: "pat-test" },
    config: { token_fingerprint: FP, ...config },
  });
}

function eventsOf(type: string): Row[] {
  return tables.events.filter((e) => e.type === type);
}

/** Toda escritura a `table` lleva el filtro de tenant. */
function assertScopedWrites(table: string) {
  const ws = writes.filter((w) => w.table === table);
  assert.ok(ws.length > 0, `no hubo escrituras en ${table}`);
  for (const w of ws) {
    assert.ok(
      w.eqs.some(([c, v]) => c === "workspace_id" && v === WS),
      `UPDATE a ${table} sin filtro workspace_id: ${JSON.stringify(w.eqs)}`,
    );
  }
}

// ── getHubSpotConfig ─────────────────────────────────────────────────────────

test("getHubSpotConfig lee token y config del workspace", async () => {
  reset();
  connect();
  assert.deepEqual(await hs.getHubSpotConfig(WS), {
    token: "pat-test",
    pipelineId: "pl_1",
    dealStageId: "st_1",
    propertiesReady: true,
  });
});

test("getHubSpotConfig descifra un token guardado con el AAD del workspace y proveedor", async () => {
  reset();
  const credentials = await encryptCredentials({ hubspot_token: "pat-cifrado" }, WS, "hubspot");
  tables.integrations.push({ workspace_id: WS, provider: "hubspot", enabled: true, credentials, config: {} });
  const cfg = await hs.getHubSpotConfig(WS);
  assert.equal(cfg?.token, "pat-cifrado");
  assert.equal(cfg?.propertiesReady, false);
});

test("getHubSpotConfig devuelve null sin fila, deshabilitada, sin token o de otro workspace", async () => {
  reset();
  assert.equal(await hs.getHubSpotConfig(WS), null);
  tables.integrations.push({ workspace_id: WS, provider: "hubspot", enabled: false, credentials: { hubspot_token: "x" }, config: {} });
  assert.equal(await hs.getHubSpotConfig(WS), null);
  reset();
  tables.integrations.push({ workspace_id: WS, provider: "hubspot", enabled: true, credentials: { hubspot_token: "" }, config: {} });
  assert.equal(await hs.getHubSpotConfig(WS), null);
  reset();
  tables.integrations.push({ workspace_id: "ws_otro", provider: "hubspot", enabled: true, credentials: { hubspot_token: "t" }, config: {} });
  assert.equal(await hs.getHubSpotConfig(WS), null);
});

test("getHubSpotConfig NO lanza con un ciphertext corrupto", async () => {
  reset();
  tables.integrations.push({ workspace_id: WS, provider: "hubspot", enabled: true, credentials: { hubspot_token: "enc:v1:no-es:un-ciphertext" }, config: {} });
  assert.equal(await hs.getHubSpotConfig(WS), null);
});

test("getHubSpotConfig sigue devolviendo null en los tres casos (not_configured, decrypt_failed, db_error)", async () => {
  reset();
  // not_configured: sin fila.
  assert.equal(await hs.getHubSpotConfig(WS), null);
  // decrypt_failed.
  reset();
  tables.integrations.push({ workspace_id: WS, provider: "hubspot", enabled: true, credentials: { hubspot_token: "enc:v1:no-es:un-ciphertext" }, config: {} });
  assert.equal(await hs.getHubSpotConfig(WS), null);
  // db_error: la lectura de "integrations" falla (504/timeout de PostgREST), no simplemente
  // devuelve vacío. Confirma que un error transitorio NO se distingue hacia afuera de
  // "no configurado" en este wrapper público (solo logHubSpotConversation, vía la función
  // interna, necesita esa distinción para reintentar).
  reset();
  connect();
  selectErrorPlan.integrations = [1];
  assert.equal(await hs.getHubSpotConfig(WS), null);
});

// ── hsFetch ──────────────────────────────────────────────────────────────────

test("hsFetch manda Bearer a la ruta fechada y devuelve el JSON de un 200", async () => {
  reset();
  on("GET", /\/crm\/objects\/2026-09\/contacts\?limit=1$/, json(200, { results: [] }));
  const res = await hs.hsFetch("tok", `/crm/objects/${hs.HS_API_VERSION}/contacts?limit=1`);
  assert.deepEqual(res, { ok: true, status: 200, json: { results: [] } });
  assert.equal(calls[0].url, `${BASE}/crm/objects/2026-09/contacts?limit=1`);
  assert.equal(calls[0].auth, "Bearer tok");
});

test("hsFetch traduce 401 y 403 a códigos, sin reintentar", async () => {
  reset();
  on("GET", /\/a$/, json(401, { message: "Authentication credentials not found" }));
  on("GET", /\/b$/, json(403, {}));
  const a = await hs.hsFetch("tok", "/a");
  const b = await hs.hsFetch("tok", "/b");
  assert.equal(!a.ok && a.code, "unauthorized");
  assert.equal(!b.ok && b.code, "missing_scope");
  assert.equal(calls.length, 2);
});

test("hsFetch reintenta UNA vez un 429", async () => {
  reset();
  on("GET", /\/x$/, json(429, {}, { "retry-after": "0" }), json(200, { ok: 1 }));
  assert.deepEqual(await hs.hsFetch("tok", "/x"), { ok: true, status: 200, json: { ok: 1 } });
  assert.equal(calls.length, 2);
});

test("hsFetch con dos 429 corta en rate_limited tras un solo reintento", async () => {
  reset();
  on("GET", /\/x$/, json(429, {}, { "retry-after": "0" }));
  const res = await hs.hsFetch("tok", "/x");
  assert.equal(!res.ok && res.code, "rate_limited");
  assert.equal(calls.length, 2);
});

test("hsFetch no espera un Retry-After que no cabe en el deadline de la corrida", async () => {
  reset();
  on("GET", /\/x$/, json(429, {}, { "retry-after": "5" }));
  const started = Date.now();
  const res = await hs.hsDeadline.run(Date.now() + 200, () => hs.hsFetch("tok", "/x"));
  assert.equal(!res.ok && res.code, "rate_limited");
  assert.equal(calls.length, 1);
  assert.ok(Date.now() - started < 1000, "no durmió los 5 s");
});

test("hsFetch corta por timeout con el deadline de la corrida y lo reporta como `timeout`", async () => {
  reset();
  // Respuesta que nunca llega: solo termina si el AbortSignal aborta.
  on("GET", /\/lento$/, (init) =>
    new Promise<Response>((_, reject) =>
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
    ),
  );
  const res = await hs.hsDeadline.run(Date.now() + 50, () => hs.hsFetch("tok", "/lento"));
  assert.deepEqual(res, { ok: false, status: 0, code: "timeout", body: "" });
});

test("hsFetch con el deadline ya vencido no llama a HubSpot", async () => {
  reset();
  const res = await hs.hsDeadline.run(Date.now() - 1, () => hs.hsFetch("tok", "/x"));
  assert.deepEqual(res, { ok: false, status: 0, code: "deadline", body: "" });
  assert.equal(calls.length, 0);
});

test("hsFetch convierte una caída de red en `network` y un 200 ilegible en `bad_response`", async () => {
  reset();
  on("GET", /\/red$/, () => {
    throw new TypeError("fetch failed");
  });
  on("GET", /\/html$/, () => new Response("<html>mantención</html>", { status: 200 }));
  assert.equal((await hs.hsFetch("tok", "/red") as { code?: string }).code, "network");
  assert.equal((await hs.hsFetch("tok", "/html") as { code?: string }).code, "bad_response");
});

// ── Huella del token y portal ────────────────────────────────────────────────

test("hubSpotTokenFingerprint es estable, de 32 hex, y distinta por token; no contiene el token", () => {
  const a = hs.hubSpotTokenFingerprint("pat-na1-aaa");
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(a, hs.hubSpotTokenFingerprint("pat-na1-aaa"));
  assert.notEqual(a, hs.hubSpotTokenFingerprint("pat-na1-bbb"));
  assert.ok(!a.includes("pat"));
});

test("getHubSpotPortalId lee portalId de la cuenta; falla con código si no viene", async () => {
  reset();
  on("GET", /\/account-info\/2026-09\/details$/, json(200, { portalId: 123456, accountType: "STANDARD" }), json(200, {}));
  assert.deepEqual(await hs.getHubSpotPortalId("tok"), { ok: true, portalId: "123456" });
  assert.deepEqual(await hs.getHubSpotPortalId("tok"), { ok: false, code: "bad_response" });
});

// ── ensureHubSpotProperties: tipo y unicidad validados ─────────────────────

const PHONE_PROP = /\/crm\/properties\/2026-09\/contacts\/whatsapp_phone$/;
const TAGS_PROP = /\/crm\/properties\/2026-09\/contacts\/whatsapp_tags$/;
const PROPS = /\/crm\/properties\/2026-09\/contacts$/;
const PHONE_DEF = { name: "whatsapp_phone", type: "string", fieldType: "text", hasUniqueValue: true };
const TAGS_DEF = { name: "whatsapp_tags", type: "enumeration", fieldType: "checkbox", options: [] };

test("no crea nada si las dos propiedades existen con el tipo correcto", async () => {
  reset();
  on("GET", PHONE_PROP, json(200, PHONE_DEF));
  on("GET", TAGS_PROP, json(200, TAGS_DEF));
  assert.deepEqual(await hs.ensureHubSpotProperties("tok"), { ok: true });
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
});

test("crea las dos que faltan con su definición exacta y valida lo creado", async () => {
  reset();
  on("GET", PHONE_PROP, json(404, {}));
  on("GET", TAGS_PROP, json(404, {}));
  on("POST", PROPS, json(201, PHONE_DEF), json(201, TAGS_DEF));
  assert.deepEqual(await hs.ensureHubSpotProperties("tok"), { ok: true });
  const posted = calls.filter((c) => c.method === "POST").map((c) => c.body as Row);
  assert.deepEqual(
    posted.map((p) => [p.name, p.type, p.fieldType, p.hasUniqueValue ?? null, p.groupName]),
    [
      ["whatsapp_phone", "string", "text", true, "contactinformation"],
      ["whatsapp_tags", "enumeration", "checkbox", null, "contactinformation"],
    ],
  );
});

// ── whatsapp_tags necesita ≥1 opción o HubSpot devuelve 400
//    MISSING_OPTIONS al crearla. Placeholder oculto que no colisiona con hsTagValue(). ───────────

test("el POST de whatsapp_tags lleva exactamente la opción placeholder oculta", async () => {
  reset();
  on("GET", PHONE_PROP, json(404, {}));
  on("GET", TAGS_PROP, json(404, {}));
  on("POST", PROPS, json(201, PHONE_DEF), json(201, TAGS_DEF));
  assert.deepEqual(await hs.ensureHubSpotProperties("tok"), { ok: true });
  const tagsPost = calls.find((c) => c.method === "POST" && (c.body as Row).name === "whatsapp_tags");
  assert.deepEqual((tagsPost?.body as Row).options, [
    { label: "(sin etiquetas)", value: "wa_placeholder", displayOrder: 0, hidden: true },
  ]);
  // hsTagValue() nunca produce "wa_placeholder" (siempre wa_<20 hex>): no puede colisionar.
  assert.notEqual(hs.hsTagValue("cualquier etiqueta"), "wa_placeholder");
});

test("whatsapp_tags existente con otras opciones y SIN el placeholder sigue siendo válida", async () => {
  reset();
  on("GET", PHONE_PROP, json(200, PHONE_DEF));
  on("GET", TAGS_PROP, json(200, {
    name: "whatsapp_tags",
    type: "enumeration",
    fieldType: "checkbox",
    options: [{ label: "vip", value: hs.hsTagValue("vip"), displayOrder: 0, hidden: false }],
  }));
  assert.deepEqual(await hs.ensureHubSpotProperties("tok"), { ok: true });
});

test("HubSpot RECHAZA (400) crear whatsapp_tags: código específico, no bad_request genérico", async () => {
  reset();
  on("GET", PHONE_PROP, json(200, PHONE_DEF));
  on("GET", TAGS_PROP, json(404, {}));
  on("POST", PROPS, json(400, { category: "VALIDATION_ERROR", message: "no options" }));
  assert.deepEqual(await hs.ensureHubSpotProperties("tok"), { ok: false, code: "tags_property_create_rejected" });
});

test("HubSpot RECHAZA (400) crear whatsapp_phone: código específico", async () => {
  reset();
  on("GET", PHONE_PROP, json(404, {}));
  on("POST", PROPS, json(400, { message: "bad" }));
  assert.deepEqual(await hs.ensureHubSpotProperties("tok"), { ok: false, code: "phone_property_create_rejected" });
});

test("otros códigos de fallo al crear (429, 403) NO se reescriben como rechazo", async () => {
  reset();
  on("GET", PHONE_PROP, json(404, {}));
  on("POST", PROPS, json(429, {}, { "retry-after": "0" }), json(429, {}, { "retry-after": "0" }));
  assert.deepEqual(await hs.ensureHubSpotProperties("tok"), { ok: false, code: "rate_limited" });

  reset();
  on("GET", PHONE_PROP, json(404, {}));
  on("POST", PROPS, json(403, {}));
  assert.deepEqual(await hs.ensureHubSpotProperties("tok"), { ok: false, code: "missing_scope" });
});

test("un whatsapp_tags preexistente de tipo texto NO se declara listo", async () => {
  reset();
  on("GET", PHONE_PROP, json(200, PHONE_DEF));
  on("GET", TAGS_PROP, json(200, { name: "whatsapp_tags", type: "string", fieldType: "text" }));
  assert.deepEqual(await hs.ensureHubSpotProperties("tok"), { ok: false, code: "tags_property_conflict" });
});

test("un whatsapp_phone que existe pero no es único es phone_property_conflict", async () => {
  reset();
  on("GET", PHONE_PROP, json(200, { ...PHONE_DEF, hasUniqueValue: false }));
  assert.deepEqual(await hs.ensureHubSpotProperties("tok"), { ok: false, code: "phone_property_conflict" });
});

test("409 al crear: relee la definición y la valida antes de dar por lista la propiedad", async () => {
  reset();
  on("GET", PHONE_PROP, json(404, {}), json(200, { ...PHONE_DEF, hasUniqueValue: false }));
  on("POST", PROPS, json(409, { message: "Property already exists" }));
  assert.deepEqual(await hs.ensureHubSpotProperties("tok"), { ok: false, code: "phone_property_conflict" });
  assert.equal(calls.filter((c) => PHONE_PROP.test(c.url)).length, 2, "releyó tras el 409");
});

test("409 al crear con una definición correcta al releer: sigue", async () => {
  reset();
  on("GET", PHONE_PROP, json(404, {}), json(200, PHONE_DEF));
  on("GET", TAGS_PROP, json(200, TAGS_DEF));
  on("POST", PROPS, json(409, {}));
  assert.deepEqual(await hs.ensureHubSpotProperties("tok"), { ok: true });
});

test("sin scope de propiedades devuelve missing_scope y no intenta crear", async () => {
  reset();
  on("GET", PHONE_PROP, json(403, {}));
  assert.deepEqual(await hs.ensureHubSpotProperties("tok"), { ok: false, code: "missing_scope" });
  assert.equal(calls.length, 1);
});

// ── Identidad ─────────────────────────────────────────────────────────────────

const SEARCH = /\/crm\/objects\/2026-09\/contacts\/search$/;
const CREATE = /\/crm\/objects\/2026-09\/contacts$/;
const CONTACT = /\/crm\/objects\/2026-09\/contacts\/\d+$/;
const PHONE = "+15550001111";

function addContact(overrides: Row = {}) {
  tables.contacts.push({
    id: "c1",
    workspace_id: WS,
    name: "Ana Pérez",
    phone: PHONE,
    email: null,
    // Sin etiquetas por defecto: toda subida manda TODAS las locales, así que un test que
    // no trata de etiquetas no debe ver un PATCH de whatsapp_tags. Los de etiquetas las pasan.
    tags: [],
    hs_contact_id: null,
    ...overrides,
  });
}

function contactRow(id = "c1"): Row {
  return tables.contacts.find((c) => c.id === id)!;
}

function patches(): Array<{ url: string; body: unknown }> {
  return calls.filter((c) => c.method === "PATCH").map((c) => ({ url: c.url, body: c.body }));
}

test("una sola búsqueda con la identidad propia primero y teléfonos con y sin '+'", async () => {
  reset();
  connect();
  addContact();
  on("POST", SEARCH, json(200, { results: [] }));
  on("POST", CREATE, json(201, { id: "901" }));
  await hs.syncContactToHubSpot(WS, "c1");
  assert.deepEqual(calls[0].body, {
    filterGroups: [
      { filters: [{ propertyName: "whatsapp_phone", operator: "EQ", value: PHONE }] },
      { filters: [{ propertyName: "phone", operator: "EQ", value: PHONE }] },
      { filters: [{ propertyName: "phone", operator: "EQ", value: "15550001111" }] },
      { filters: [{ propertyName: "mobilephone", operator: "EQ", value: PHONE }] },
      { filters: [{ propertyName: "mobilephone", operator: "EQ", value: "15550001111" }] },
    ],
    properties: ["whatsapp_phone"],
    limit: 10,
    // Orden determinístico, para no depender de un orden que HubSpot no
    // garantiza cuando hay varios matches.
    sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
  });
});

test("contacto nuevo: se CREA con perfil y whatsapp_phone, y se enlaza con filtro de tenant", async () => {
  reset();
  connect();
  addContact();
  on("POST", SEARCH, json(200, { results: [] }));
  on("POST", CREATE, json(201, { id: "901" }));
  assert.deepEqual(await hs.syncContactToHubSpot(WS, "c1"), { hs_id: "901" });
  assert.deepEqual(calls[1].body, {
    properties: { phone: PHONE, firstname: "Ana", lastname: "Pérez", whatsapp_phone: PHONE },
  });
  assert.equal(contactRow().hs_contact_id, "901");
  assert.deepEqual(rpcCalls, [
    { fn: "read_hubspot_link", args: { p_workspace_id: WS, p_contact_id: "c1", p_token_fingerprint: FP } },
    {
      fn: "link_hubspot_contact",
      args: { p_workspace_id: WS, p_contact_id: "c1", p_hs_contact_id: "901", p_token_fingerprint: FP },
    },
  ]);
  assert.equal(writes.filter((w) => w.table === "contacts").length, 0, "el enlace va SOLO por la RPC condicional");
  assert.equal(tables.events.length, 0);
});

test("enlace atado al token: si el token cambió mientras se resolvía el id, NO se enlaza y es properties_not_ready (reintentable)", async () => {
  reset();
  connect();
  addContact();
  on("POST", SEARCH, json(200, { results: [] }));
  // Un PUT intercalado guarda otro token: cambia la huella y properties_ready vuelve a false.
  on("POST", CREATE, () => {
    tables.integrations[0].config = { token_fingerprint: "otra-huella", properties_ready: false };
    return new Response(JSON.stringify({ id: "901" }), { status: 201, headers: { "content-type": "application/json" } });
  });
  assert.deepEqual(await hs.pushContactToHubSpot(WS, "c1"), { ok: false, code: "properties_not_ready" });
  assert.equal(contactRow().hs_contact_id, null, "un id de la cuenta vieja no queda enlazado");
  assert.equal(writes.filter((w) => w.table === "contacts").length, 0);
  assert.deepEqual(eventsOf("crm_sync_failed")[0].payload, {
    provider: "hubspot",
    code: "properties_not_ready",
    step: "link",
    contact_id: "c1",
  });
});

test("un error de la RPC de enlace es db_write_failed, sin enlazar", async () => {
  reset();
  connect();
  addContact();
  on("POST", SEARCH, json(200, { results: [{ id: "600", properties: { whatsapp_phone: PHONE } }] }));
  contactUpdateError = { code: "57014", message: "canceling statement due to statement timeout" };
  assert.deepEqual(await hs.pushContactToHubSpot(WS, "c1"), { ok: false, code: "db_write_failed" });
  assert.equal(contactRow().hs_contact_id, null);
});

test("el remoto ya tiene NUESTRO whatsapp_phone (su phone cambió): se enlaza sin escribirle nada", async () => {
  reset();
  connect();
  addContact();
  on("POST", SEARCH, json(200, { results: [{ id: "600", properties: { whatsapp_phone: PHONE } }] }));
  assert.deepEqual(await hs.syncContactToHubSpot(WS, "c1"), { hs_id: "600" });
  assert.deepEqual(patches(), [], "ni perfil ni identidad: ya estaba");
  assert.equal(calls.filter((c) => CREATE.test(c.url)).length, 0);
});

test("contacto que el cliente ya tenía (un match sin whatsapp_phone): solo se le escribe la identidad", async () => {
  reset();
  connect();
  addContact();
  on("POST", SEARCH, json(200, { results: [{ id: "501", properties: { whatsapp_phone: null } }] }));
  on("PATCH", CONTACT, json(200, { id: "501" }));
  assert.deepEqual(await hs.syncContactToHubSpot(WS, "c1"), { hs_id: "501" });
  assert.deepEqual(patches(), [
    { url: `${BASE}/crm/objects/2026-09/contacts/501`, body: { properties: { whatsapp_phone: PHONE } } },
  ]);
});

test("un match cuyo whatsapp_phone es OTRO no se toca: se crea uno propio", async () => {
  reset();
  connect();
  addContact();
  on("POST", SEARCH, json(200, { results: [{ id: "502", properties: { whatsapp_phone: "+15550002222" } }] }));
  on("POST", CREATE, json(201, { id: "903" }));
  assert.deepEqual(await hs.syncContactToHubSpot(WS, "c1"), { hs_id: "903" });
  assert.deepEqual(patches(), []);
});

test("teléfono ambiguo: crea uno nuevo y registra hs_ambiguous_phone", async () => {
  reset();
  connect();
  addContact();
  on("POST", SEARCH, json(200, { results: [{ id: "11", properties: {} }, { id: "12", properties: {} }] }));
  on("POST", CREATE, json(201, { id: "904" }));
  assert.deepEqual(await hs.syncContactToHubSpot(WS, "c1"), { hs_id: "904" });
  const ev = eventsOf("hs_ambiguous_phone");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].level, "warn");
  assert.deepEqual(ev[0].payload, { provider: "hubspot", contact_id: "c1", matches: 2 });
});

test("409 al crear (carrera o email de un contacto sin whatsapp_phone): se enlaza SIN tocar su perfil", async () => {
  reset();
  connect();
  addContact({ email: "ana@ejemplo.cl" });
  on("POST", SEARCH, json(200, { results: [] }));
  on("POST", CREATE, json(409, { message: "Contact already exists. Existing ID: 888", category: "CONFLICT" }));
  on("GET", /\/contacts\/888\?properties=whatsapp_phone$/, json(200, { id: "888", properties: { whatsapp_phone: null } }));
  on("PATCH", CONTACT, json(200, { id: "888" }));

  assert.deepEqual(await hs.syncContactToHubSpot(WS, "c1"), { hs_id: "888" });
  assert.deepEqual(
    patches(),
    [{ url: `${BASE}/crm/objects/2026-09/contacts/888`, body: { properties: { whatsapp_phone: PHONE } } }],
    "nombre y email del contacto existente NO se pisan",
  );
});

// El 409 puede llegar cuando el existente YA tiene NUESTRO whatsapp_phone
// (carrera: otro request ya lo enlazó entre el POST y esta respuesta). No es email_taken ni hace
// falta reescribir la identidad: ya está.
test("409 al crear cuyo existente YA tiene NUESTRO whatsapp_phone: se enlaza sin reescribir nada", async () => {
  reset();
  connect();
  addContact({ email: "ana@ejemplo.cl" });
  on("POST", SEARCH, json(200, { results: [] }));
  on("POST", CREATE, json(409, { message: "Contact already exists. Existing ID: 890" }));
  on("GET", /\/contacts\/890\?properties=whatsapp_phone$/, json(200, { id: "890", properties: { whatsapp_phone: PHONE } }));
  assert.deepEqual(await hs.syncContactToHubSpot(WS, "c1"), { hs_id: "890" });
  assert.deepEqual(patches(), [], "ya tenía nuestra identidad: ningún PATCH de más");
});

test("409 por el email de un contacto con OTRO whatsapp_phone: falla con email_taken, sin escribir", async () => {
  reset();
  connect();
  addContact({ email: "compartido@ejemplo.cl" });
  on("POST", SEARCH, json(200, { results: [] }));
  on("POST", CREATE, json(409, { message: "Contact already exists. Existing ID: 889" }));
  on("GET", /\/contacts\/889\?properties=whatsapp_phone$/, json(200, { properties: { whatsapp_phone: "+15550003333" } }));
  assert.equal(await hs.syncContactToHubSpot(WS, "c1"), null);
  assert.deepEqual(patches(), []);
  assert.equal((eventsOf("crm_sync_failed")[0].payload as Row).code, "email_taken");
});

// API real: el whatsapp_phone único duplicado NO es un 409 "Existing ID"
// sino un 400 VALIDATION_ERROR "... <id> already has that value." Pasa cuando la búsqueda no ve
// todavía el contacto (índice del Search API atrasado tras crear o actualizar) o en una carrera.
const DUP_UNIQUE_400 = {
  status: "error",
  message:
    "Cannot set PropertyValueCoordinates{portalId=12345678, objectTypeId=ObjectTypeId{legacyObjectType=CONTACT}, propertyName=whatsapp_phone, value=+15550004567} on 100000000001. 891 already has that value.",
  correlationId: "01a0d038-933c-7ace-b4af-0a37a64e8d7b",
  category: "VALIDATION_ERROR",
};

test("400 por whatsapp_phone único duplicado (forma real): se enlaza al dueño sin reescribir nada", async () => {
  reset();
  connect();
  addContact();
  on("POST", SEARCH, json(200, { results: [] }));
  on("POST", CREATE, json(400, DUP_UNIQUE_400));
  on("GET", /\/contacts\/891\?properties=whatsapp_phone$/, json(200, { id: "891", properties: { whatsapp_phone: PHONE } }));
  assert.deepEqual(await hs.syncContactToHubSpot(WS, "c1"), { hs_id: "891" });
  assert.deepEqual(patches(), [], "ya tenía nuestra identidad: ningún PATCH de más");
});

test("un 400 que no es el duplicado de whatsapp_phone sigue siendo bad_request", async () => {
  reset();
  connect();
  addContact();
  on("POST", SEARCH, json(200, { results: [] }));
  on("POST", CREATE, json(400, { status: "error", message: "Property values were not valid", category: "VALIDATION_ERROR" }));
  assert.equal(await hs.syncContactToHubSpot(WS, "c1"), null);
  assert.equal((eventsOf("crm_sync_failed")[0].payload as Row).code, "bad_request");
});

test("un 409 sin id reconocible falla con código conflict", async () => {
  reset();
  connect();
  addContact();
  on("POST", SEARCH, json(200, { results: [] }));
  on("POST", CREATE, json(409, { message: "algo distinto" }));
  assert.equal(await hs.syncContactToHubSpot(WS, "c1"), null);
  assert.equal((eventsOf("crm_sync_failed")[0].payload as Row).code, "conflict");
});

test("contacto enlazado y sin opciones: no llama a HubSpot", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  assert.deepEqual(await hs.syncContactToHubSpot(WS, "c1"), { hs_id: "777" });
  assert.equal(calls.length, 0);
});

test("pushProfile (edición del operador) empuja solo nombre y email a un contacto existente, nunca phone", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777", email: "ana@ejemplo.cl" });
  on("PATCH", CONTACT, json(200, {}));
  assert.deepEqual(await hs.syncContactToHubSpot(WS, "c1", { pushProfile: true }), { hs_id: "777" });
  assert.deepEqual(patches()[0].body, {
    properties: { firstname: "Ana", lastname: "Pérez", email: "ana@ejemplo.cl" },
  });
});

test("pushProfile al enlazar por identidad tampoco manda phone", async () => {
  reset();
  connect();
  addContact();
  on("POST", SEARCH, json(200, { results: [{ id: "600", properties: { whatsapp_phone: PHONE } }] }));
  on("PATCH", CONTACT, json(200, {}));
  await hs.syncContactToHubSpot(WS, "c1", { pushProfile: true });
  assert.equal("phone" in (patches()[0].body as { properties: Row }).properties, false);
});

test("pushProfile al enlazar por identidad empuja el perfil una sola vez", async () => {
  reset();
  connect();
  addContact();
  on("POST", SEARCH, json(200, { results: [{ id: "600", properties: { whatsapp_phone: PHONE } }] }));
  on("PATCH", CONTACT, json(200, {}));
  await hs.syncContactToHubSpot(WS, "c1", { pushProfile: true });
  assert.equal(patches().length, 1);
});

test("un contacto recién creado no recibe un segundo PATCH de perfil aunque venga pushProfile", async () => {
  reset();
  connect();
  addContact();
  on("POST", SEARCH, json(200, { results: [] }));
  on("POST", CREATE, json(201, { id: "905" }));
  await hs.syncContactToHubSpot(WS, "c1", { pushProfile: true });
  assert.deepEqual(patches(), []);
});

// ── Un hs_contact_id vencido (contacto borrado o fusionado en HubSpot) nunca se
//    recuperaba. Un 404 del contacto enlazado suelta el enlace con CAS y devuelve un código
//    reintentable, para que el próximo intento resuelva de nuevo por whatsapp_phone. ───────────

test("404 del contacto enlazado: suelta el enlace con CAS (id + tenant + id viejo) y devuelve stale_link", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  on("PATCH", CONTACT, json(404, { message: "resource not found" }));
  assert.deepEqual(await hs.pushContactToHubSpot(WS, "c1", { pushProfile: true }), { ok: false, code: "stale_link" });
  assert.equal(contactRow().hs_contact_id, null);
  const clear = writes.filter((w) => w.table === "contacts");
  assert.equal(clear.length, 1);
  assert.equal(clear[0].patch.hs_contact_id, null);
  assert.deepEqual(
    clear[0].eqs.filter(([c]) => ["id", "workspace_id", "hs_contact_id"].includes(c)),
    [["id", "c1"], ["workspace_id", WS], ["hs_contact_id", "777"]],
  );
  assert.deepEqual(eventsOf("crm_sync_failed")[0].payload, { provider: "hubspot", code: "stale_link", step: "profile", contact_id: "c1" });
  assert.ok(!JSON.stringify(tables.events).includes("resource not found"));

  // El intento siguiente vuelve a resolver por whatsapp_phone y enlaza el contacto vigente.
  routes = [];
  on("POST", SEARCH, json(200, { results: [{ id: "888", properties: { whatsapp_phone: PHONE } }] }));
  on("PATCH", CONTACT, json(200, {}));
  assert.deepEqual(await hs.pushContactToHubSpot(WS, "c1", { pushProfile: true }), { ok: true, hs_id: "888" });
  assert.equal(contactRow().hs_contact_id, "888");
});

test("404 del contacto enlazado al subir etiquetas también suelta el enlace", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777", tags: ["vip"] });
  on("PATCH", CONTACT, json(404, {}));
  assert.deepEqual(await hs.pushContactToHubSpot(WS, "c1", { allTags: true }), { ok: false, code: "stale_link" });
  assert.equal(contactRow().hs_contact_id, null);
});

test("404 al leer las etiquetas del contacto enlazado (quitar) también suelta el enlace", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  on("GET", REMOVE_READ, json(404, {}));
  assert.deepEqual(await hs.pushContactToHubSpot(WS, "c1", { removeTag: "vip" }), { ok: false, code: "stale_link" });
  assert.equal(contactRow().hs_contact_id, null);
});

test("si alguien re-enlazó entretanto, el CAS no afecta la fila y el enlace nuevo queda", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  on("PATCH", CONTACT, () => {
    contactRow().hs_contact_id = "999"; // otro push resolvió y enlazó mientras esperábamos
    return new Response("{}", { status: 404 });
  });
  assert.deepEqual(await hs.pushContactToHubSpot(WS, "c1", { pushProfile: true }), { ok: false, code: "stale_link" });
  assert.equal(contactRow().hs_contact_id, "999");
});

test("un 404 de la PROPIEDAD whatsapp_tags no es un enlace vencido: el enlace queda", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777", tags: ["x"] });
  on("PATCH", CONTACT, INVALID_OPTION);
  on("GET", TAGS_PROP, json(404, {}));
  assert.deepEqual(await hs.pushContactToHubSpot(WS, "c1", { allTags: true }), { ok: false, code: "properties_not_ready" });
  assert.equal(contactRow().hs_contact_id, "777");
  assert.equal(writes.filter((w) => w.table === "contacts").length, 0);
});

test("otros errores del contacto enlazado (401, 429) no sueltan el enlace", async () => {
  for (const status of [401, 429]) {
    reset();
    connect();
    addContact({ hs_contact_id: "777" });
    on("PATCH", CONTACT, json(status, {}, { "retry-after": "0" }));
    const r = await hs.pushContactToHubSpot(WS, "c1", { pushProfile: true });
    assert.equal(r.ok, false);
    assert.equal(contactRow().hs_contact_id, "777", `status ${status}`);
  }
});

test("token inválido: null, evento con CÓDIGO y sin texto de HubSpot", async () => {
  reset();
  connect();
  addContact();
  on("POST", SEARCH, json(401, { message: "Authentication credentials not found." }));
  assert.equal(await hs.syncContactToHubSpot(WS, "c1"), null);
  assert.equal(contactRow().hs_contact_id, null);
  const ev = eventsOf("crm_sync_failed");
  assert.equal(ev[0].conversation_id, null);
  assert.deepEqual(ev[0].payload, { provider: "hubspot", code: "unauthorized", step: "resolve", contact_id: "c1" });
  assert.ok(!JSON.stringify(tables.events).includes("Authentication"));
});

test("sin propiedades listas no llama a HubSpot y lo registra", async () => {
  reset();
  connect({ properties_ready: false });
  addContact();
  assert.equal(await hs.syncContactToHubSpot(WS, "c1"), null);
  assert.equal(calls.length, 0);
  assert.equal((eventsOf("crm_sync_failed")[0].payload as Row).code, "properties_not_ready");
});

test("pushContactToHubSpot sin HubSpot conectado devuelve not_configured, sin llamadas ni eventos", async () => {
  reset();
  addContact();
  assert.deepEqual(await hs.pushContactToHubSpot(WS, "c1"), { ok: false, code: "not_configured" });
  assert.equal(calls.length + tables.events.length, 0);
});

test("pushContactToHubSpot: un error transitorio leyendo su config es db_error, no not_configured", async () => {
  reset();
  connect();
  addContact();
  selectErrorPlan.integrations = [1];
  assert.deepEqual(await hs.pushContactToHubSpot(WS, "c1"), { ok: false, code: "db_error" });
  assert.equal(calls.length + tables.events.length, 0);
});

test("pushContactToHubSpot: un token que no se pudo descifrar es config_decrypt_failed", async () => {
  reset();
  tables.integrations.push({ workspace_id: WS, provider: "hubspot", enabled: true, credentials: { hubspot_token: "enc:v1:no-es:un-ciphertext" }, config: {} });
  addContact();
  assert.deepEqual(await hs.pushContactToHubSpot(WS, "c1"), { ok: false, code: "config_decrypt_failed" });
});

test("el contacto de OTRO workspace no se sincroniza", async () => {
  reset();
  connect();
  addContact({ workspace_id: "ws_otro" });
  assert.deepEqual(await hs.pushContactToHubSpot(WS, "c1"), { ok: false, code: "contact_not_found" });
  assert.equal(calls.length, 0);
});

// Un error TRANSITORIO leyendo el contacto es db_error (reintentable), no
// contact_not_found — antes ambos casos caían en el mismo código y el mismo log engañoso.
test("un error transitorio leyendo el contacto es db_error, no contact_not_found", async () => {
  reset();
  connect();
  addContact();
  selectErrorPlan.contacts = [1];
  assert.deepEqual(await hs.pushContactToHubSpot(WS, "c1"), { ok: false, code: "db_error" });
  assert.equal(calls.length, 0);
});

test("syncContactToHubSpot también loguea (server-side) un db_error leyendo el contacto", async () => {
  reset();
  connect();
  addContact();
  selectErrorPlan.contacts = [1];
  const errSpy = mock.method(console, "error", () => {});
  try {
    assert.equal(await hs.syncContactToHubSpot(WS, "c1"), null);
    assert.ok(
      errSpy.mock.calls.some((c) => c.arguments[0] === "[HS] syncContactToHubSpot: error transitorio leyendo el contacto"),
    );
  } finally {
    errSpy.mock.restore();
  }
});

test("id de HubSpot ya enlazado a otro contacto local: hs_id_taken", async () => {
  reset();
  connect();
  addContact();
  on("POST", SEARCH, json(200, { results: [{ id: "600", properties: { whatsapp_phone: PHONE } }] }));
  contactUpdateError = { code: "23505", message: "duplicate key" };
  assert.equal(await hs.syncContactToHubSpot(WS, "c1"), null);
  assert.equal((eventsOf("crm_sync_failed")[0].payload as Row).code, "hs_id_taken");
  assert.equal(rpcCalls[0].args.p_workspace_id, WS);
});

// ── Etiquetas ────────────────────────────────────────────────────────────────

const INVALID_OPTION = json(400, {
  status: "error",
  category: "VALIDATION_ERROR",
  errors: [{ code: "INVALID_OPTION", message: "wa_x was not one of the allowed options" }],
});
const REMOVE_READ = /\/contacts\/777\?properties=whatsapp_tags$/;

test("hsTagValue: estable, con forma fija y distinta para a;b y a,b", () => {
  assert.match(hs.hsTagValue("a;b"), /^wa_[0-9a-f]{20}$/);
  assert.equal(hs.hsTagValue("a;b"), hs.hsTagValue(" a;b "));
  assert.notEqual(hs.hsTagValue("a;b"), hs.hsTagValue("a,b"));
});

test("addTags agrega por valor estable con ';' inicial (append), sin tocar las demás", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  on("PATCH", CONTACT, json(200, {}));
  await hs.syncContactToHubSpot(WS, "c1", { addTags: ["interesado"] });
  assert.deepEqual(calls[0].body, { properties: { whatsapp_tags: `;${hs.hsTagValue("interesado")}` } });
});

test("opción inexistente: la agrega con la etiqueta original como label y reintenta UNA vez", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  on("PATCH", CONTACT, INVALID_OPTION, json(200, {}));
  on("GET", TAGS_PROP, json(200, {
    name: "whatsapp_tags",
    options: [{ label: "vip", value: hs.hsTagValue("vip"), displayOrder: 0, hidden: false }],
  }));
  on("PATCH", TAGS_PROP, json(200, {}));

  assert.deepEqual(await hs.syncContactToHubSpot(WS, "c1", { addTags: ["a;b"] }), { hs_id: "777" });
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url.replace(BASE, "")}`),
    [
      "PATCH /crm/objects/2026-09/contacts/777",
      "GET /crm/properties/2026-09/contacts/whatsapp_tags",
      "PATCH /crm/properties/2026-09/contacts/whatsapp_tags",
      "PATCH /crm/objects/2026-09/contacts/777",
    ],
  );
  assert.deepEqual(calls[2].body, {
    options: [
      { label: "vip", value: hs.hsTagValue("vip"), displayOrder: 0, hidden: false },
      { label: "a;b", value: hs.hsTagValue("a;b"), displayOrder: 1, hidden: false },
    ],
  });
});

test("addTagOptions conserva una opción existente OCULTA (el placeholder) al agregar una nueva", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  on("PATCH", CONTACT, INVALID_OPTION, json(200, {}));
  on("GET", TAGS_PROP, json(200, {
    name: "whatsapp_tags",
    options: [{ label: "(sin etiquetas)", value: "wa_placeholder", displayOrder: 0, hidden: true }],
  }));
  on("PATCH", TAGS_PROP, json(200, {}));

  assert.deepEqual(await hs.syncContactToHubSpot(WS, "c1", { addTags: ["nueva"] }), { hs_id: "777" });
  const patchOptions = calls.find((c) => c.method === "PATCH" && TAGS_PROP.test(c.url));
  assert.deepEqual(patchOptions?.body, {
    options: [
      { label: "(sin etiquetas)", value: "wa_placeholder", displayOrder: 0, hidden: true },
      { label: "nueva", value: hs.hsTagValue("nueva"), displayOrder: 1, hidden: false },
    ],
  });
});

test("si la opción sigue sin existir tras el alta NO reintenta más: falla con código", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  on("PATCH", CONTACT, INVALID_OPTION);
  on("GET", TAGS_PROP, json(200, { options: [] }));
  on("PATCH", TAGS_PROP, json(200, {}));
  assert.equal(await hs.syncContactToHubSpot(WS, "c1", { addTags: ["x"] }), null);
  assert.equal(calls.filter((c) => CONTACT.test(c.url)).length, 2, "un intento + un reintento");
  assert.deepEqual(eventsOf("crm_sync_failed")[0].payload, {
    provider: "hubspot",
    code: "bad_request",
    step: "tags",
    contact_id: "c1",
  });
});

test("a;b y a,b son etiquetas distintas: quitar a;b deja a,b en HubSpot", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  on("GET", REMOVE_READ, json(200, {
    properties: { whatsapp_tags: `${hs.hsTagValue("a;b")};${hs.hsTagValue("a,b")}` },
  }));
  on("PATCH", CONTACT, json(200, {}));
  await hs.syncContactToHubSpot(WS, "c1", { removeTag: "a;b" });
  assert.deepEqual(patches()[0].body, { properties: { whatsapp_tags: hs.hsTagValue("a,b") } });
});

test("allTags (botón manual) manda todas las locales (unión) y nunca quita, sin opciones de delta", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777", tags: ["vip", "a;b"] });
  on("PATCH", CONTACT, json(200, {}));
  await hs.syncContactToHubSpot(WS, "c1", { allTags: true });
  assert.deepEqual(calls[0].body, {
    properties: { whatsapp_tags: `;${hs.hsTagValue("vip")};${hs.hsTagValue("a;b")}` },
  });
});

// Un push que no toca etiquetas (log, deal, pushProfile
// solo) no manda whatsapp_tags aunque el contacto tenga etiquetas locales, ni siquiera en el
// primer enlace. Solo addTags/removeTag/allTags disparan la subida.
test("un push sin addTags/removeTag/allTags no manda etiquetas (log/deal/profile-only)", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777", tags: ["vip"] });
  on("PATCH", CONTACT, json(200, {}));
  assert.deepEqual(await hs.syncContactToHubSpot(WS, "c1", { pushProfile: true }), { hs_id: "777" });
  assert.equal(patches().length, 1, "solo el PATCH de perfil, ninguno de etiquetas");
  assert.equal("whatsapp_tags" in (patches()[0].body as { properties: Row }).properties, false);
});

test("el primer enlace sin opciones (log/deal) tampoco manda etiquetas", async () => {
  reset();
  connect();
  addContact({ tags: ["vip"] });
  on("POST", SEARCH, json(200, { results: [{ id: "501", properties: { whatsapp_phone: null } }] }));
  on("PATCH", CONTACT, json(200, {}));
  assert.deepEqual(await hs.syncContactToHubSpot(WS, "c1"), { hs_id: "501" });
  assert.deepEqual(patches(), [
    { url: `${BASE}/crm/objects/2026-09/contacts/501`, body: { properties: { whatsapp_phone: PHONE } } },
  ]);
});

// Un add perdido (timeout, 429, properties_not_ready, instancia congelada) nunca
// se curaba porque cada subida mandaba solo el delta. Ahora cada subida manda todas las locales.
test("un add manda TODAS las etiquetas locales, no solo el delta: un add perdido antes se cura", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777", tags: ["a", "x"] });
  on("PATCH", CONTACT, json(200, {}));
  await hs.syncContactToHubSpot(WS, "c1", { addTags: ["x"] });
  assert.deepEqual(patches(), [
    { url: `${BASE}/crm/objects/2026-09/contacts/777`, body: { properties: { whatsapp_tags: `;${hs.hsTagValue("a")};${hs.hsTagValue("x")}` } } },
  ]);
});

test("allTags en el primer enlace sube las etiquetas que el contacto ya tenía", async () => {
  reset();
  connect();
  addContact({ tags: ["vip"] });
  on("POST", SEARCH, json(200, { results: [{ id: "777", properties: { whatsapp_phone: PHONE } }] }));
  on("PATCH", CONTACT, json(200, {}));
  assert.deepEqual(await hs.syncContactToHubSpot(WS, "c1", { allTags: true }), { hs_id: "777" });
  assert.deepEqual(patches().map((p) => p.body), [{ properties: { whatsapp_tags: `;${hs.hsTagValue("vip")}` } }]);
});

test("un remove sigue siendo delta y la etiqueta quitada nunca viaja en el set de altas", async () => {
  reset();
  connect();
  // `b` todavía en la fila (carrera con la RPC local): igual no se re-agrega.
  addContact({ hs_contact_id: "777", tags: ["a", "b"] });
  on("PATCH", CONTACT, json(200, {}));
  on("GET", REMOVE_READ, json(200, { properties: { whatsapp_tags: `${hs.hsTagValue("a")};${hs.hsTagValue("b")}` } }));
  await hs.syncContactToHubSpot(WS, "c1", { removeTag: "b" });
  assert.deepEqual(patches().map((p) => p.body), [
    { properties: { whatsapp_tags: `;${hs.hsTagValue("a")}` } },
    { properties: { whatsapp_tags: hs.hsTagValue("a") } },
  ]);
});

test("quitar una etiqueta que HubSpot no tiene no escribe nada", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  on("GET", REMOVE_READ, json(200, { properties: { whatsapp_tags: hs.hsTagValue("vip") } }));
  assert.deepEqual(await hs.syncContactToHubSpot(WS, "c1", { removeTag: "otra" }), { hs_id: "777" });
  assert.deepEqual(patches(), []);
});

test("sin scope al etiquetar: missing_scope; la etiqueta local no se toca", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777", tags: ["vip"] });
  on("PATCH", CONTACT, json(403, {}));
  assert.equal(await hs.syncContactToHubSpot(WS, "c1", { addTags: ["x"] }), null);
  assert.equal((eventsOf("crm_sync_failed")[0].payload as Row).code, "missing_scope");
  assert.deepEqual(contactRow().tags, ["vip"]);
});

test("etiquetas en blanco no llaman a HubSpot", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  assert.deepEqual(await hs.syncContactToHubSpot(WS, "c1", { addTags: ["  "] }), { hs_id: "777" });
  assert.equal(calls.length, 0);
});

// ── syncContactFromHubSpot ───────────────────────────────────────────────────

const PULL = /\/contacts\/777\?properties=firstname,lastname,email$/;

test("el pull rellena nombre y email vacíos, con filtro de tenant, y NUNCA escribe tags", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777", name: null, email: null, tags: ["vip"] });
  on("GET", PULL, json(200, { properties: { firstname: "Ana", lastname: "Pérez", email: "ana@ejemplo.cl" } }));
  assert.deepEqual(await hs.syncContactFromHubSpot(WS, "c1"), { hs_id: "777", filled: ["name", "email"] });
  assert.equal(contactRow().name, "Ana Pérez");
  assert.equal(contactRow().email, "ana@ejemplo.cl");
  assert.deepEqual(contactRow().tags, ["vip"], "el pull no escribe contacts.tags");
  assertScopedWrites("contacts");
  assert.ok(writes.every((w) => !("tags" in w.patch)), "ninguna escritura toca tags");
});

test("el pull no pisa un nombre local existente", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777", name: "Anita", email: null });
  on("GET", PULL, json(200, { properties: { firstname: "Ana", email: "ana@ejemplo.cl" } }));
  assert.deepEqual(await hs.syncContactFromHubSpot(WS, "c1"), { hs_id: "777", filled: ["email"] });
  assert.equal(contactRow().name, "Anita");
});

// Un nombre local de puros espacios cuenta como vacío tanto en el gate
// de lectura (trim()) como en el guard de escritura, así que el pull SÍ lo rellena.
test("un nombre local de puros espacios cuenta como vacío y el pull lo rellena", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777", name: "   ", email: null });
  on("GET", PULL, json(200, { properties: { firstname: "Ana", lastname: "Pérez", email: "ana@ejemplo.cl" } }));
  assert.deepEqual(await hs.syncContactFromHubSpot(WS, "c1"), { hs_id: "777", filled: ["name", "email"] });
  assert.equal(contactRow().name, "Ana Pérez");
});

test("sin hs_contact_id primero enlaza y después lee", async () => {
  reset();
  connect();
  addContact({ name: null });
  on("POST", SEARCH, json(200, { results: [{ id: "777", properties: { whatsapp_phone: PHONE } }] }));
  on("GET", PULL, json(200, { properties: { firstname: "Ana" } }));
  assert.deepEqual(await hs.syncContactFromHubSpot(WS, "c1"), { hs_id: "777", filled: ["name"] });
  assert.equal(contactRow().hs_contact_id, "777");
});

test("un 404 al leer: null, evento con código y el contacto local intacto", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777", name: null });
  on("GET", PULL, json(404, {}));
  assert.equal(await hs.syncContactFromHubSpot(WS, "c1"), null);
  assert.equal(contactRow().name, null);
  assert.deepEqual(eventsOf("crm_sync_failed")[0].payload, { provider: "hubspot", code: "not_found", step: "pull", contact_id: "c1" });
});

test("el pull no lee ni escribe el contacto de otro workspace", async () => {
  reset();
  connect();
  addContact({ workspace_id: "ws_otro", hs_contact_id: "777", name: null });
  assert.equal(await hs.syncContactFromHubSpot(WS, "c1"), null);
  assert.equal(calls.length + writes.length, 0);
});

test("una edición local entre la lectura y la escritura no se pisa (carrera)", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777", name: null, email: null });
  on("GET", PULL, () => {
    // El operador escribe el nombre MIENTRAS esperamos la respuesta de HubSpot.
    contactRow().name = "Editado a mano";
    return new Response(
      JSON.stringify({ properties: { firstname: "Ana", lastname: "Pérez", email: "ana@ejemplo.cl" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  assert.deepEqual(await hs.syncContactFromHubSpot(WS, "c1"), { hs_id: "777", filled: ["email"] });
  assert.equal(contactRow().name, "Editado a mano", "el nombre editado a mano no se pisa");
  assert.equal(contactRow().email, "ana@ejemplo.cl");
  assertScopedWrites("contacts");
});

test("un error de la base al escribir localmente no se traga: null y evento con código", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777", name: null, email: null });
  on("GET", PULL, json(200, { properties: { firstname: "Ana", lastname: "Pérez", email: "ana@ejemplo.cl" } }));
  contactUpdateError = { code: "40001", message: "serialization failure" };
  assert.equal(await hs.syncContactFromHubSpot(WS, "c1"), null);
  assert.deepEqual(eventsOf("crm_sync_failed")[0].payload, {
    provider: "hubspot",
    code: "local_write_failed",
    step: "pull",
    contact_id: "c1",
  });
});

// ── Negocios y pipelines ─────────────────────────────────────────────────────

const DEALS = /\/crm\/objects\/2026-09\/deals$/;
const PIPELINES = /\/crm\/pipelines\/2026-09\/deals$/;

test("createHubSpotDeal crea el negocio en el pipeline/etapa, asociado al contacto", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  on("POST", DEALS, json(201, { id: "d1" }));
  assert.deepEqual(await hs.createHubSpotDeal(WS, "c1"), { id: "d1" });
  assert.deepEqual(calls[0].body, {
    properties: { dealname: "Ana Pérez", pipeline: "pl_1", dealstage: "st_1" },
    associations: [{ to: { id: "777" }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }] }],
  });
});

test("createHubSpotDeal usa el nombre dado, o el teléfono si no hay nombre", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777", name: null });
  on("POST", DEALS, json(201, { id: "d2" }));
  await hs.createHubSpotDeal(WS, "c1");
  await hs.createHubSpotDeal(WS, "c1", { name: "Plan anual" });
  assert.equal((calls[0].body as { properties: Row }).properties.dealname, PHONE);
  assert.equal((calls[1].body as { properties: Row }).properties.dealname, "Plan anual");
});

// Un error leyendo nombre/teléfono se loguea server-side con un código, en
// vez de quedar indistinguible de un contacto genuinamente sin nombre.
test("createHubSpotDeal: un error leyendo nombre/teléfono se loguea y usa el nombre genérico", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  on("POST", DEALS, json(201, { id: "d3" }));
  selectErrorPlan.contacts = [2]; // 1ra: pushContactToHubSpot; 2da: la de nombre/teléfono del deal.
  const errSpy = mock.method(console, "error", () => {});
  try {
    assert.deepEqual(await hs.createHubSpotDeal(WS, "c1"), { id: "d3" });
    assert.equal((calls[0].body as { properties: Row }).properties.dealname, "Lead de WhatsApp");
    assert.ok(
      errSpy.mock.calls.some((c) => c.arguments[0] === "[HS] createHubSpotDeal: no se pudo leer nombre/teléfono del contacto"),
    );
  } finally {
    errSpy.mock.restore();
  }
});

test("createHubSpotDeal sin pipeline/etapa no llama a HubSpot", async () => {
  reset();
  connect({ properties_ready: true });
  addContact({ hs_contact_id: "777" });
  assert.equal(await hs.createHubSpotDeal(WS, "c1"), null);
  assert.equal(calls.length, 0);
});

test("createHubSpotDeal sin scope de deals: null y evento con código", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  on("POST", DEALS, json(403, {}));
  assert.equal(await hs.createHubSpotDeal(WS, "c1"), null);
  assert.deepEqual(eventsOf("crm_sync_failed")[0].payload, { provider: "hubspot", code: "missing_scope", step: "deal", contact_id: "c1" });
});

test("createHubSpotDeal no crea el negocio si el contacto no se pudo enlazar", async () => {
  reset();
  connect();
  addContact();
  on("POST", SEARCH, json(401, {}));
  assert.equal(await hs.createHubSpotDeal(WS, "c1"), null);
  assert.equal(calls.filter((c) => DEALS.test(c.url)).length, 0);
});

test("listHubSpotPipelines mapea label → name con sus etapas; null ante error o forma rara", async () => {
  reset();
  connect();
  on("GET", PIPELINES, json(200, { results: [{ id: "default", label: "Ventas", stages: [{ id: "st_1", label: "Calificado" }] }] }), json(401, {}), json(200, { results: "x" }));
  assert.deepEqual(await hs.listHubSpotPipelines(WS), [{ id: "default", name: "Ventas", stages: [{ id: "st_1", name: "Calificado" }] }]);
  assert.equal(await hs.listHubSpotPipelines(WS), null);
  assert.equal(await hs.listHubSpotPipelines(WS), null);
  reset();
  assert.equal(await hs.listHubSpotPipelines(WS), null, "sin conexión");
});

// Un 200 con elementos malformados no puede lanzar (contrato
// "nunca lanza"); se trata como respuesta ilegible (null), nunca como "sin pipelines".
test("listHubSpotPipelines con un pipeline null o stages que no es array: null, sin lanzar", async () => {
  reset();
  connect();
  on(
    "GET",
    PIPELINES,
    json(200, { results: [null] }),
    json(200, { results: [{ id: "default", label: "Ventas", stages: "x" }] }),
    json(200, { results: [{ id: "default", label: "Ventas", stages: [null] }] }),
    json(200, { results: [{ id: "default", label: "Ventas" }] }),
  );
  const errSpy = mock.method(console, "error", () => {});
  try {
    assert.equal(await hs.listHubSpotPipelines(WS), null, "results: [null]");
    assert.equal(await hs.listHubSpotPipelines(WS), null, "stages no es array");
    assert.equal(await hs.listHubSpotPipelines(WS), null, "una etapa null");
    assert.ok(errSpy.mock.calls.some((c) => (c.arguments as unknown[]).includes("bad_response")), "queda server-side con su código");
  } finally {
    errSpy.mock.restore();
  }
  // Sin `stages` sigue siendo un pipeline sin etapas (forma válida, igual que antes).
  assert.deepEqual(await hs.listHubSpotPipelines(WS), [{ id: "default", name: "Ventas", stages: [] }]);
});

// id/label que no son string (String() de un objeto lanza; de undefined da
// "undefined") también son respuesta ilegible.
test("C5b: listHubSpotPipelines con id/label que no son string: null, sin lanzar", async () => {
  reset();
  connect();
  on(
    "GET",
    PIPELINES,
    json(200, { results: [{ id: { toString: null }, label: "P", stages: [] }] }),
    json(200, { results: [{ id: "default", label: "Ventas", stages: [{ id: "s1", label: { toString: null } }] }] }),
    json(200, { results: [{}] }),
  );
  const errSpy = mock.method(console, "error", () => {});
  try {
    assert.equal(await hs.listHubSpotPipelines(WS), null, "id objeto");
    assert.equal(await hs.listHubSpotPipelines(WS), null, "label de etapa objeto");
    assert.equal(await hs.listHubSpotPipelines(WS), null, "pipeline vacío");
  } finally {
    errSpy.mock.restore();
  }
});

// ── Registro de la conversación: cuerpo en cascada, sin LLM ────────

const COMMS = /\/crm\/objects\/2026-09\/communications$/;

function addConversation(opts: { summary?: string | null; leadSummary?: string | null; workspaceId?: string } = {}) {
  tables.conversations.push({ id: "conv_1", workspace_id: opts.workspaceId ?? WS, contact_id: "c1", summary: opts.summary ?? null });
  tables.integrations.push({ workspace_id: WS, provider: "kapso", enabled: true, credentials: {}, config: { phone_number: "+1 555 000 0000" } });
  const c = tables.contacts.find((r) => r.id === "c1");
  if (c) c.custom_fields = opts.leadSummary ? { lead_summary: opts.leadSummary } : {};
}

function loggedBody(): string {
  return String((calls.find((c) => COMMS.test(c.url))!.body as { properties: Row }).properties.hs_communication_body);
}

test("traspaso: comunicación WHATS_APP asociada al contacto, con el resumen del agente y su número", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  addConversation({ summary: "Quiere cotizar el plan anual.", leadSummary: "Lead caliente." });
  on("POST", COMMS, json(201, { id: "comm_1" }));
  assert.deepEqual(await hs.logHubSpotConversation(WS, "conv_1", "handoff"), { ok: true });
  const body = calls[0].body as { properties: Row; associations: unknown };
  assert.equal(body.properties.hs_communication_channel_type, "WHATS_APP");
  assert.equal(body.properties.hs_communication_logged_from, "CRM");
  assert.equal(typeof body.properties.hs_timestamp, "string");
  assert.equal(loggedBody(), "[Agente de WhatsApp · +1 555 000 0000] Traspaso a humano\n\nResumen: Quiere cotizar el plan anual.");
  assert.deepEqual(body.associations, [{ to: { id: "777" }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 81 }] }]);
});

test("cascada 2: sin resumen del agente usa el lead_summary del setter", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  addConversation({ summary: "  ", leadSummary: "Busca 3 sedes, presupuesto aprobado." });
  on("POST", COMMS, json(201, {}));
  await hs.logHubSpotConversation(WS, "conv_1", "closed");
  assert.equal(loggedBody(), "[Agente de WhatsApp · +1 555 000 0000] Conversación cerrada\n\nResumen del lead: Busca 3 sedes, presupuesto aprobado.");
});

// El recorte a MAX_BODY_CHARS es por CODE POINT, no por code unit
// UTF-16, para no cortar un emoji (par subrogado) a la mitad y dejar un carácter suelto inválido.
test("el recorte a 4000 no corta un emoji (par subrogado) a la mitad", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  addConversation({ summary: "  " }); // sin resumen del agente: cae al lead_summary
  const emoji = "\u{1F600}";
  // Construido para que el emoji sea exactamente el código 4000: sliced.length===4000 en code
  // points mantiene el emoji ENTERO; un slice ingenuo por code unit lo habría cortado a la mitad.
  const lead = "a".repeat(3920) + emoji;
  const c = tables.contacts.find((r) => r.id === "c1")!;
  c.custom_fields = { lead_summary: lead };
  on("POST", COMMS, json(201, {}));
  await hs.logHubSpotConversation(WS, "conv_1", "closed");
  const body = loggedBody();
  assert.equal(body.length, 4001, "el emoji completo (2 code units) queda adentro, no cortado");
  assert.ok(body.endsWith(emoji), "el emoji quedó entero, no partido en un surrogate suelto");
});

test("cascada 3: sin resúmenes, los últimos 10 mensajes de ESTA conversación y tenant, en orden", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  addConversation();
  for (let i = 1; i <= 12; i++) {
    tables.messages.push({ conversation_id: "conv_1", workspace_id: WS, direction: i % 2 ? "in" : "out", body: `m${i}`, created_at: `2026-09-22T10:${String(i).padStart(2, "0")}:00Z` });
  }
  tables.messages.push({ conversation_id: "conv_otra", workspace_id: WS, direction: "in", body: "ajeno", created_at: "2026-09-22T11:00:00Z" });
  tables.messages.push({ conversation_id: "conv_1", workspace_id: "ws_otro", direction: "in", body: "otro tenant", created_at: "2026-09-22T11:01:00Z" });
  on("POST", COMMS, json(201, {}));
  await hs.logHubSpotConversation(WS, "conv_1", "closed");
  const lines = Array.from({ length: 10 }, (_, k) => k + 3).map((i) => `${i % 2 ? "Cliente" : "Agente"}: m${i}`);
  assert.equal(loggedBody(), `[Agente de WhatsApp · +1 555 000 0000] Conversación cerrada\n\nÚltimos mensajes:\n${lines.join("\n")}`);
});

test("sin mensajes igual deja constancia", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  addConversation();
  on("POST", COMMS, json(201, {}));
  await hs.logHubSpotConversation(WS, "conv_1", "handoff");
  assert.equal(loggedBody(), "[Agente de WhatsApp · +1 555 000 0000] Traspaso a humano\n\n(Sin mensajes.)");
});

test("sin HubSpot conectado: not_configured y ninguna llamada", async () => {
  reset();
  addContact({ hs_contact_id: "777" });
  addConversation();
  assert.deepEqual(await hs.logHubSpotConversation(WS, "conv_1", "handoff"), { ok: false, code: "not_configured" });
  assert.equal(calls.length, 0);
});

test("la conversación de otro workspace: conversation_not_found, sin llamadas", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  addConversation({ workspaceId: "ws_otro" });
  assert.deepEqual(await hs.logHubSpotConversation(WS, "conv_1", "handoff"), { ok: false, code: "conversation_not_found" });
  assert.equal(calls.length, 0);
});

test("contacto que no se pudo enlazar o HubSpot que rechaza: devuelve el código para la cola", async () => {
  reset();
  connect();
  addContact();
  addConversation();
  on("POST", SEARCH, json(401, {}));
  assert.deepEqual(await hs.logHubSpotConversation(WS, "conv_1", "handoff"), { ok: false, code: "unauthorized" });
  assert.equal(calls.filter((c) => COMMS.test(c.url)).length, 0);

  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  addConversation();
  on("POST", COMMS, json(403, {}));
  assert.deepEqual(await hs.logHubSpotConversation(WS, "conv_1", "handoff"), { ok: false, code: "missing_scope" });
});

// ── Un error TRANSITORIO de lectura nunca se convierte en un resultado
//    definitivo o falso. "conversation_not_found"/"not_configured" quedan solo para la AUSENCIA
//    real de datos; cualquier error de PostgREST en el camino devuelve "db_error" (reintentable
//    por la cola) o, para la config, un código propio para el fallo de descifrado. ────────────────

test("error en la lectura de la conversación: db_error, nunca conversation_not_found", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  addConversation();
  selectErrorPlan.conversations = [1];
  assert.deepEqual(await hs.logHubSpotConversation(WS, "conv_1", "handoff"), { ok: false, code: "db_error" });
  assert.equal(calls.length, 0, "no llega a llamar a HubSpot");
});

test("error en la config de HubSpot: db_error, nunca not_configured/cancelled", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  addConversation();
  selectErrorPlan.integrations = [1]; // 1ra lectura de integrations = el propio config check
  assert.deepEqual(await hs.logHubSpotConversation(WS, "conv_1", "handoff"), { ok: false, code: "db_error" });
  assert.equal(calls.length, 0);
});

test("un token que no se pudo descifrar cierra con un código propio, no db_error ni un texto crudo", async () => {
  reset();
  tables.integrations.push({ workspace_id: WS, provider: "hubspot", enabled: true, credentials: { hubspot_token: "enc:v1:no-es:un-ciphertext" }, config: {} });
  addContact({ hs_contact_id: "777" });
  addConversation();
  assert.deepEqual(await hs.logHubSpotConversation(WS, "conv_1", "handoff"), { ok: false, code: "config_decrypt_failed" });
});

test("error en los mensajes: db_error, NUNCA '(Sin mensajes.)' ni un done falso en el CRM", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  addConversation();
  selectErrorPlan.messages = [1];
  assert.deepEqual(await hs.logHubSpotConversation(WS, "conv_1", "handoff"), { ok: false, code: "db_error" });
  assert.equal(calls.filter((c) => COMMS.test(c.url)).length, 0, "nunca se registró la comunicación falsa");
});

test("error al leer el contacto (lead_summary): db_error, no cae en silencio a los mensajes", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  addConversation();
  // 1ra lectura de "contacts" = pushContactToHubSpot (resuelve el hs_id); 2da = buildConversationBody
  // (custom_fields.lead_summary). Apunta a la 2da para no tapar la primera.
  selectErrorPlan.contacts = [2];
  assert.deepEqual(await hs.logHubSpotConversation(WS, "conv_1", "handoff"), { ok: false, code: "db_error" });
  assert.equal(calls.filter((c) => COMMS.test(c.url)).length, 0);
});

// (El test "error de config DENTRO de pushContactToHubSpot" se fue con la segunda lectura: desde
// logHubSpotConversation le pasa su config y pushContactToHubSpot ya no relee. El db_error
// de la lectura directa sigue cubierto en "pushContactToHubSpot: un error transitorio …".)

test("error al leer la config del agente de Kapso (encabezado): db_error, no sale sin número en silencio", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  addConversation();
  // 1ra lectura de "integrations" = la config de HubSpot (una sola); la 2da es la de
  // kapso en buildConversationBody.
  selectErrorPlan.integrations = [2];
  assert.deepEqual(await hs.logHubSpotConversation(WS, "conv_1", "handoff"), { ok: false, code: "db_error" });
  assert.equal(calls.filter((c) => COMMS.test(c.url)).length, 0);
});

test("filtro de tenant: la config de Kapso de OTRO workspace nunca se usa para el encabezado", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  // Sin fila de kapso para WS; solo para "ws_otro" — si el filtro workspace_id fallara, este
  // número se filtraría al encabezado.
  tables.conversations.push({ id: "conv_1", workspace_id: WS, contact_id: "c1", summary: "Resumen breve." });
  tables.integrations.push({ workspace_id: "ws_otro", provider: "kapso", enabled: true, credentials: {}, config: { phone_number: "+15550000000" } });
  on("POST", COMMS, json(201, {}));
  await hs.logHubSpotConversation(WS, "conv_1", "handoff");
  assert.equal(loggedBody(), "[Agente de WhatsApp] Traspaso a humano\n\nResumen: Resumen breve.");
});

test("filtro de tenant: el contacto de OTRO workspace con el mismo id no aporta su lead_summary", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" }); // c1 en WS, sin custom_fields (via addConversation)
  addConversation();
  tables.contacts.push({ id: "c1", workspace_id: "ws_otro", name: "Otro", phone: "+15550000000", email: null, tags: null, hs_contact_id: null, custom_fields: { lead_summary: "NO debería verse" } });
  tables.messages.push({ conversation_id: "conv_1", workspace_id: WS, direction: "in", body: "Hola", created_at: "2026-09-22T10:00:00Z" });
  on("POST", COMMS, json(201, {}));
  await hs.logHubSpotConversation(WS, "conv_1", "handoff");
  const body = loggedBody();
  assert.ok(!body.includes("NO debería verse"), "no debe filtrarse el lead_summary de otro tenant");
  assert.ok(body.includes("Últimos mensajes:\nCliente: Hola"), "debe caer al transcript propio del tenant");
});

// ── El POST de la comunicación NO es idempotente. Con el timeout
//    recortado por el deadline, HubSpot podía confirmarlo, el cliente abortar y la cola repetirlo.

test("sin un timeout completo por delante, NO manda la comunicación y devuelve deadline (reintentable)", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  addConversation({ summary: "Resumen." });
  on("POST", COMMS, json(201, {}));
  const r = await hs.hsDeadline.run(Date.now() + 5_000, () => hs.logHubSpotConversation(WS, "conv_1", "handoff"));
  assert.deepEqual(r, { ok: false, code: "deadline" });
  assert.equal(calls.filter((c) => COMMS.test(c.url)).length, 0);
});

// El mínimo de un timeout completo rige ANTES DE CADA intento, no
// solo del primero. Con 11 s, un 429 con Retry-After 2 dejaba salir un segundo POST con ~8 s.
test("tras un 429, el reintento del POST tampoco sale sin un timeout completo: deadline, un solo POST", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  addConversation({ summary: "Resumen." });
  on("POST", COMMS, json(429, {}, { "retry-after": "2" }), json(201, {}));
  const started = Date.now();
  const r = await hs.hsDeadline.run(Date.now() + 11_000, () => hs.logHubSpotConversation(WS, "conv_1", "handoff"));
  assert.deepEqual(r, { ok: false, code: "deadline" });
  assert.equal(calls.filter((c) => COMMS.test(c.url)).length, 1, "no hubo segundo POST");
  assert.ok(Date.now() - started < 1_500, "ni siquiera durmió el Retry-After inútil");
});

test("hsFetch con minRemainingMs no sale si no queda ese tiempo, y sí si queda", async () => {
  reset();
  on("POST", /\/y$/, json(200, { ok: 1 }));
  const short = await hs.hsDeadline.run(Date.now() + 5_000, () =>
    hs.hsFetch("tok", "/y", { method: "POST", body: {}, minRemainingMs: 10_000 }),
  );
  assert.deepEqual(short, { ok: false, status: 0, code: "deadline", body: "" });
  assert.equal(calls.length, 0);
  const enough = await hs.hsDeadline.run(Date.now() + 25_000, () =>
    hs.hsFetch("tok", "/y", { method: "POST", body: {}, minRemainingMs: 10_000 }),
  );
  assert.equal(enough.ok, true);
  // Sin corrida (sin deadline) el mínimo no aplica: rige el timeout propio.
  assert.equal((await hs.hsFetch("tok", "/y", { method: "POST", body: {}, minRemainingMs: 10_000 })).ok, true);
});

test("con tiempo de sobra, el 429 del POST se reintenta una vez y sale", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  addConversation({ summary: "Resumen." });
  on("POST", COMMS, json(429, {}, { "retry-after": "0" }), json(201, {}));
  const r = await hs.hsDeadline.run(Date.now() + 25_000, () => hs.logHubSpotConversation(WS, "conv_1", "handoff"));
  assert.deepEqual(r, { ok: true });
  assert.equal(calls.filter((c) => COMMS.test(c.url)).length, 2);
});

test("con un timeout completo por delante sí la manda", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  addConversation({ summary: "Resumen." });
  on("POST", COMMS, json(201, {}));
  const r = await hs.hsDeadline.run(Date.now() + 25_000, () => hs.logHubSpotConversation(WS, "conv_1", "handoff"));
  assert.deepEqual(r, { ok: true });
  assert.equal(calls.filter((c) => COMMS.test(c.url)).length, 1);
});

// ── Una sola lectura de la config por operación. Con dos, un PUT
//    entre ellas dejaba enlazado un id del portal B y la llamada final salía con el token A. ─────

/** Simula un PUT de otro token (otra cuenta) justo después de la PRIMERA lectura de la config. */
function swapTokenAfterFirstRead() {
  afterHubSpotConfigRead = (n) => {
    if (n !== 1) return;
    const row = tables.integrations.find((i) => i.provider === "hubspot")!;
    row.credentials = { hubspot_token: "pat-na1-otro" };
    row.config = { ...(row.config as Row), token_fingerprint: hs.hubSpotTokenFingerprint("pat-na1-otro") };
  };
}

/**
 * Todas las llamadas a HubSpot con UN token (o ninguna: con read_hubspot_link un cambio de token corta ya en la
 * lectura del contacto), y la lectura y el enlace atados a la huella de ESE token — sin llamadas,
 * la del token que se leyó al empezar (`connect()`).
 */
function assertOneTokenEndToEnd() {
  const tokens = [...new Set(calls.map((c) => c.auth))];
  assert.ok(tokens.length <= 1, `tokens usados: ${JSON.stringify(tokens)}`);
  const fp = tokens.length === 1 ? hs.hubSpotTokenFingerprint(String(tokens[0]).replace("Bearer ", "")) : FP;
  const bound = rpcCalls.filter((c) => c.fn === "link_hubspot_contact" || c.fn === "read_hubspot_link");
  assert.ok(bound.length > 0, "la lectura del contacto va por read_hubspot_link");
  for (const r of bound) {
    assert.equal(r.args.p_token_fingerprint, fp, `${r.fn} usó la huella de otro token`);
  }
}

test("logHubSpotConversation lee la config UNA vez y enlaza y registra con el mismo token", async () => {
  reset();
  connect();
  addContact();
  addConversation({ summary: "Resumen." });
  on("POST", SEARCH, json(200, { results: [{ id: "777", properties: { whatsapp_phone: PHONE } }] }));
  on("POST", COMMS, json(201, {}));
  assert.deepEqual(await hs.logHubSpotConversation(WS, "conv_1", "handoff"), { ok: true });
  assert.equal(hubSpotConfigReads(), 1);
  assertOneTokenEndToEnd();
});

test("logHubSpotConversation con un PUT en medio: no enlaza con otra huella ni registra con otro token", async () => {
  reset();
  connect();
  addContact();
  addConversation({ summary: "Resumen." });
  on("POST", SEARCH, json(200, { results: [{ id: "777", properties: { whatsapp_phone: PHONE } }] }));
  on("POST", COMMS, json(201, {}));
  swapTokenAfterFirstRead();
  assert.deepEqual(await hs.logHubSpotConversation(WS, "conv_1", "handoff"), { ok: false, code: "properties_not_ready" });
  assert.equal(contactRow().hs_contact_id, null);
  assert.equal(calls.filter((c) => COMMS.test(c.url)).length, 0);
  assertOneTokenEndToEnd();
});

test("syncContactFromHubSpot lee la config UNA vez y enlaza y lee con el mismo token", async () => {
  reset();
  connect();
  addContact({ name: null });
  on("POST", SEARCH, json(200, { results: [{ id: "777", properties: { whatsapp_phone: PHONE } }] }));
  on("GET", PULL, json(200, { properties: { firstname: "Ana" } }));
  assert.deepEqual(await hs.syncContactFromHubSpot(WS, "c1"), { hs_id: "777", filled: ["name"] });
  assert.equal(hubSpotConfigReads(), 1);
  assertOneTokenEndToEnd();
});

test("syncContactFromHubSpot con un PUT en medio: no enlaza con otra huella ni lee con otro token", async () => {
  reset();
  connect();
  addContact({ name: null });
  on("POST", SEARCH, json(200, { results: [{ id: "777", properties: { whatsapp_phone: PHONE } }] }));
  on("GET", PULL, json(200, { properties: { firstname: "Ana" } }));
  swapTokenAfterFirstRead();
  assert.equal(await hs.syncContactFromHubSpot(WS, "c1"), null);
  assert.equal(contactRow().name, null);
  assertOneTokenEndToEnd();
});

test("createHubSpotDeal lee la config UNA vez y enlaza y crea el negocio con el mismo token", async () => {
  reset();
  connect();
  addContact();
  on("POST", SEARCH, json(200, { results: [{ id: "777", properties: { whatsapp_phone: PHONE } }] }));
  on("POST", DEALS, json(201, { id: "d1" }));
  assert.deepEqual(await hs.createHubSpotDeal(WS, "c1"), { id: "d1" });
  assert.equal(hubSpotConfigReads(), 1);
  assertOneTokenEndToEnd();
});

test("createHubSpotDeal con un PUT en medio: no crea un negocio asociado a un id de otro portal", async () => {
  reset();
  connect();
  addContact();
  on("POST", SEARCH, json(200, { results: [{ id: "777", properties: { whatsapp_phone: PHONE } }] }));
  on("POST", DEALS, json(201, { id: "d1" }));
  swapTokenAfterFirstRead();
  assert.equal(await hs.createHubSpotDeal(WS, "c1"), null);
  assert.equal(calls.filter((c) => DEALS.test(c.url)).length, 0);
  assertOneTokenEndToEnd();
});

// ── Un enlace YA EXISTENTE también se ata a la huella del token que
//    lo va a usar. El worker leyó la config del token A; mientras tanto se guardó y probó B y otro
//    sync enlazó el contacto con un id del portal B ("777"). Con el SELECT directo, el id ya estaba
//    y no se pasaba por link_hubspot_contact: la transcripción/etiquetas/perfil/negocio salían con
//    el token A sobre el id 777 de B (otra persona en el portal A). ──────────────────────────────

test("enlace existente:log con un enlace leído bajo otra huella: properties_not_ready y NINGUNA llamada a HubSpot", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  addConversation({ summary: "Resumen." });
  on("POST", COMMS, json(201, {}));
  swapTokenAfterFirstRead();
  assert.deepEqual(await hs.logHubSpotConversation(WS, "conv_1", "handoff"), { ok: false, code: "properties_not_ready" });
  assert.equal(calls.length, 0);
  assert.deepEqual(eventsOf("crm_sync_failed")[0].payload, { provider: "hubspot", code: "properties_not_ready", step: "read", contact_id: "c1" });
  assert.equal(contactRow().hs_contact_id, "777", "el enlace del token vigente no se toca");
});

test("enlace existente:etiquetas y perfil sobre un enlace leído bajo otra huella tampoco salen", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777", tags: ["vip"] });
  swapTokenAfterFirstRead();
  const r = await hs.pushContactToHubSpot(WS, "c1", { addTags: ["nueva"], pushProfile: true });
  assert.deepEqual(r, { ok: false, code: "properties_not_ready" });
  assert.equal(calls.length, 0);
});

test("enlace existente:un negocio no se asocia a un enlace leído bajo otra huella", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  on("POST", DEALS, json(201, { id: "d1" }));
  swapTokenAfterFirstRead();
  assert.equal(await hs.createHubSpotDeal(WS, "c1"), null);
  assert.equal(calls.length, 0);
});

test("enlace existente:el pull tampoco lee con el token viejo el id de un enlace hecho con el nuevo", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777", name: null });
  on("GET", PULL, json(200, { properties: { firstname: "Otra persona" } }));
  swapTokenAfterFirstRead();
  assert.equal(await hs.syncContactFromHubSpot(WS, "c1"), null);
  assert.equal(calls.length, 0);
  assert.equal(contactRow().name, null, "no se rellenó con el nombre de otra persona");
});

test("enlace existente:con la huella vigente, el enlace existente se usa y la lectura va por la RPC con esa huella", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  addConversation({ summary: "Resumen." });
  on("POST", COMMS, json(201, {}));
  assert.deepEqual(await hs.logHubSpotConversation(WS, "conv_1", "handoff"), { ok: true });
  assert.deepEqual(
    rpcCalls.filter((c) => c.fn === "read_hubspot_link").map((c) => c.args),
    [{ p_workspace_id: WS, p_contact_id: "c1", p_token_fingerprint: FP }],
  );
  assertOneTokenEndToEnd();
});

test("enlace existente:un error de la RPC de lectura es db_error (reintentable), sin llamar a HubSpot", async () => {
  reset();
  connect();
  addContact({ hs_contact_id: "777" });
  selectErrorPlan.contacts = [1];
  const errSpy = mock.method(console, "error", () => {});
  try {
    assert.deepEqual(await hs.pushContactToHubSpot(WS, "c1", { allTags: true }), { ok: false, code: "db_error" });
  } finally {
    errSpy.mock.restore();
  }
  assert.equal(calls.length, 0);
});
