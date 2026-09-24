import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

interface QueueEntry {
  data?: unknown;
  error?: unknown;
}

let responseQueue: QueueEntry[] = [];
let inserts: Array<{ table: string; row: unknown }> = [];
let updates: Array<{ table: string; row: unknown }> = [];
let upserts: Array<{ table: string; row: unknown }> = [];
/**
 * Cada `.eq(columna, valor)` de cada select, CON su tabla. Un fake que descarta
 * los argumentos de `eq()` deja borrar el filtro de workspace con la suite
 * entera en verde: es exactamente el aislamiento que estos tests protegen.
 *
 * La tabla no es decorativa: `loadConversationAndPhoneResult` filtra en DOS
 * lugares (conversations y contacts), así que un `some(...)` sin tabla se
 * conforma con uno de los dos y borrar el otro queda en verde.
 */
let selectFilters: Array<{ table: string; column: string; value: unknown }> = [];

function nextResponse(): QueueEntry {
  return responseQueue.shift() ?? { data: null, error: null };
}

function makeSelectChain(table: string) {
  const chain: any = {
    eq(column: string, value: unknown) {
      selectFilters.push({ table, column, value });
      return chain;
    },
    single() {
      return Promise.resolve(nextResponse());
    },
    maybeSingle() {
      return Promise.resolve(nextResponse());
    },
  };
  return chain;
}

const fakeClient = {
  from(table: string) {
    return {
      select() {
        return makeSelectChain(table);
      },
      insert(row: unknown) {
        inserts.push({ table, row });
        return {
          select() {
            return { maybeSingle: () => Promise.resolve(nextResponse()) };
          },
          then(resolve: (v: QueueEntry) => void) {
            resolve(nextResponse());
          },
        };
      },
      update(row: unknown) {
        // Encadenable: `sendPreparedTemplate` filtra por id Y por workspace.
        let recorded = false;
        const chain: any = {
          eq() {
            if (!recorded) {
              updates.push({ table, row });
              recorded = true;
            }
            return chain;
          },
          then(resolve: (v: QueueEntry) => void) {
            resolve(nextResponse());
          },
        };
        return chain;
      },
      upsert(row: unknown) {
        upserts.push({ table, row });
        return Promise.resolve(nextResponse());
      },
    };
  },
};

mock.module("@supabase/supabase-js", {
  exports: { createClient: () => fakeClient },
});

class FakeKapsoError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
    this.name = "KapsoError";
  }
}

let sendTextImpl: (...args: unknown[]) => Promise<{ wamid: string }> = async () => ({
  wamid: "wamid_1",
});
let sendTemplateImpl: (...args: unknown[]) => Promise<{ wamid: string }> = async () => ({
  wamid: "wamid_1",
});
/** Cada POST de plantilla a Kapso: es el "no hubo request externo". */
let sendTemplateCalls: unknown[] = [];
mock.module("./kapso-client.ts", {
  exports: {
    KapsoError: FakeKapsoError,
    sendText: (...args: unknown[]) => sendTextImpl(...args),
    sendTemplate: (...args: unknown[]) => {
      sendTemplateCalls.push(args[0]);
      return sendTemplateImpl(...args);
    },
  },
});

const { dispatchText, dispatchTemplate, prepareTemplateDispatch } = await import(
  "./dispatch.ts"
);

function reset() {
  responseQueue = [];
  inserts = [];
  updates = [];
  upserts = [];
  selectFilters = [];
  sendTemplateCalls = [];
  sendTextImpl = async () => ({ wamid: "wamid_1" });
  sendTemplateImpl = async () => ({ wamid: "wamid_1" });
}

/**
 * `process.env.NODE_ENV` es readonly en los tipos de Next, así que se escribe
 * por el índice. Sin esto el test del centinela no puede simular producción.
 */
function setNodeEnv(value: string | undefined) {
  const env = process.env as Record<string, string | undefined>;
  if (value === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = value;
}

/** ¿Esa tabla se leyó filtrando por ESE workspace? (mismo patrón que executor.test) */
const filteredByWorkspace = (table: string, workspaceId: string) =>
  selectFilters.some(
    (f) => f.table === table && f.column === "workspace_id" && f.value === workspaceId,
  );

const REAL_INTEGRATION = {
  credentials: { kapso_api_key: "real_key" },
  config: { phone_number_id: "pn_1" },
};
const NOT_EXPIRED = new Date(Date.now() + 3_600_000).toISOString();
const EXPIRED = new Date(Date.now() - 3_600_000).toISOString();

// ── dispatchText ─────────────────────────────────────────────────────────

test("dispatchText sends via Kapso, persists 'sent', and refreshes last_message_at", async () => {
  reset();
  responseQueue = [
    { data: { window_expires_at: NOT_EXPIRED, contact_id: "contact_1" }, error: null }, // conversations (window)
    { data: { phone: "+15550000001", opt_in: true }, error: null }, // contacts (phone + opt_in)
    { data: REAL_INTEGRATION, error: null }, // integrations
    { error: null }, // messages insert (final persist)
    { error: null }, // conversations update (last_message_at)
  ];
  const result = await dispatchText({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    body: "hola **mundo**",
  });
  assert.deepEqual(result, { ok: true, wamid: "wamid_1" });
  const messageInsert = inserts.find((i) => i.table === "messages");
  assert.equal((messageInsert!.row as { status: string }).status, "sent");
  assert.equal((messageInsert!.row as { body: string }).body, "hola *mundo*");
  assert.equal(updates.length, 1);
});

test("dispatchText persists 'queued' without calling Kapso when the API key is the dev placeholder", async () => {
  reset();
  responseQueue = [
    { data: { window_expires_at: NOT_EXPIRED, contact_id: "contact_1" }, error: null },
    { data: { phone: "+15550000001", opt_in: true }, error: null },
    { data: { credentials: { kapso_api_key: "placeholder" }, config: {} }, error: null },
    { error: null },
    { error: null },
  ];
  let sendTextCalled = false;
  sendTextImpl = async () => {
    sendTextCalled = true;
    return { wamid: "wamid_1" };
  };
  const result = await dispatchText({ workspaceId: "ws_1", conversationId: "conv_1", body: "hola" });
  assert.equal(result.ok, true);
  assert.equal(sendTextCalled, false);
  const messageInsert = inserts.find((i) => i.table === "messages");
  assert.equal((messageInsert!.row as { status: string }).status, "queued");
});

test("dispatchText blocks with OPT_OUT before loading integration credentials when the contact opted out", async () => {
  reset();
  responseQueue = [
    { data: { window_expires_at: NOT_EXPIRED, contact_id: "contact_1" }, error: null },
    { data: { phone: "+15550000001", opt_in: false }, error: null },
  ];
  const result = await dispatchText({ workspaceId: "ws_1", conversationId: "conv_1", body: "hola" });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "OPT_OUT");
  assert.equal(inserts.length, 0);
});

test("dispatchText returns WINDOW_EXPIRED when the 24h window elapsed and there is no admin override", async () => {
  reset();
  responseQueue = [
    { data: { window_expires_at: EXPIRED, contact_id: "contact_1" }, error: null },
    { data: { phone: "+15550000001", opt_in: true }, error: null },
  ];
  const result = await dispatchText({ workspaceId: "ws_1", conversationId: "conv_1", body: "hola" });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "WINDOW_EXPIRED");
});

test("dispatchText's overrideAdmin bypasses an expired window", async () => {
  reset();
  responseQueue = [
    { data: { window_expires_at: EXPIRED, contact_id: "contact_1" }, error: null },
    { data: { phone: "+15550000001", opt_in: true }, error: null },
    { data: REAL_INTEGRATION, error: null },
    { error: null },
    { error: null },
  ];
  const result = await dispatchText({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    body: "hola",
    overrideAdmin: true,
  });
  assert.equal(result.ok, true);
});

test("dispatchText maps a KapsoError to a WhatsAppError, persists the failed message, and records message_errors", async () => {
  reset();
  responseQueue = [
    { data: { window_expires_at: NOT_EXPIRED, contact_id: "contact_1" }, error: null },
    { data: { phone: "+15550000001", opt_in: true }, error: null },
    { data: REAL_INTEGRATION, error: null },
    { data: { id: "msg_failed_1" }, error: null }, // failed-message insert .select("id").maybeSingle()
  ];
  // No `code` field → falls through the CATALOG to fromHttpStatus(400); traced
  // against whatsapp-errors.ts's unwrap()/parseWhatsAppError() (only `message`
  // feeds `detail`, `error_user_msg` is never read by any code path).
  sendTextImpl = async () => {
    throw new FakeKapsoError(400, { error: { message: "x" } }, "x");
  };
  const result = await dispatchText({ workspaceId: "ws_1", conversationId: "conv_1", body: "hola" });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "SEND_FAILED");
  assert.equal(
    result.error,
    "WhatsApp rechazó el mensaje. Revisa el contenido y el número de destino.",
  );
  const failedInsert = inserts.find((i) => i.table === "messages");
  assert.equal((failedInsert!.row as { status: string }).status, "failed");
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].table, "message_errors");
  const errorRow = upserts[0].row as {
    message_id: string;
    code: number | null;
    detail: string | null;
    source: string;
    http_status: number | null;
  };
  assert.equal(errorRow.message_id, "msg_failed_1");
  assert.equal(errorRow.code, null);
  assert.equal(errorRow.detail, "x");
  assert.equal(errorRow.source, "response");
  assert.equal(errorRow.http_status, 400);
  // 400 sale del catálogo como permanente: el buffer no debe reencolar.
  assert.equal(result.retryable, false);
});

test("dispatchText marks a network-level send failure (not a KapsoError) as retryable", async () => {
  reset();
  responseQueue = [
    { data: { window_expires_at: NOT_EXPIRED, contact_id: "contact_1" }, error: null },
    { data: { phone: "+15550000001", opt_in: true }, error: null },
    { data: REAL_INTEGRATION, error: null },
    { data: { id: "msg_failed_net" }, error: null },
  ];
  // Kapso caído del todo: fetch revienta antes de que haya respuesta HTTP, así
  // que el error NO es KapsoError y no hay status que consultar en el catálogo.
  sendTextImpl = async () => {
    throw new TypeError("fetch failed");
  };
  const result = await dispatchText({ workspaceId: "ws_1", conversationId: "conv_1", body: "hola" });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "SEND_FAILED");
  assert.equal(result.retryable, true);
});

test("dispatchText returns DB_ERROR when the final message insert fails after a successful send", async () => {
  reset();
  responseQueue = [
    { data: { window_expires_at: NOT_EXPIRED, contact_id: "contact_1" }, error: null },
    { data: { phone: "+15550000001", opt_in: true }, error: null },
    { data: REAL_INTEGRATION, error: null },
    { error: { message: "constraint violation" } }, // final messages insert fails
  ];
  const result = await dispatchText({ workspaceId: "ws_1", conversationId: "conv_1", body: "hola" });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "DB_ERROR");
});

// ── dispatchTemplate ─────────────────────────────────────────────────────

test("dispatchTemplate sends the template, bypassing the 24h window entirely", async () => {
  reset();
  // La cola es más corta que antes: prepareTemplateDispatch lee conversación y
  // contacto UNA vez (el opt_in viene en el mismo select del teléfono), no dos.
  responseQueue = [
    { data: { window_expires_at: EXPIRED, contact_id: "contact_1" }, error: null }, // window ignored for templates
    { data: { phone: "+15550000001", opt_in: true }, error: null },
    { data: REAL_INTEGRATION, error: null },
    { error: null },
    { error: null },
  ];
  const result = await dispatchTemplate({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    templateName: "confirmacion",
  });
  assert.equal(result.ok, true);
  const templateInsert = inserts.find((i) => i.table === "messages");
  assert.equal((templateInsert!.row as { type: string }).type, "template");
});

test("dispatchTemplate blocks with OPT_OUT for an opted-out contact", async () => {
  reset();
  responseQueue = [
    { data: { window_expires_at: NOT_EXPIRED, contact_id: "contact_1" }, error: null },
    { data: { phone: "+15550000001", opt_in: false }, error: null },
  ];
  const result = await dispatchTemplate({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    templateName: "confirmacion",
  });
  assert.equal(result.errorCode, "OPT_OUT");
});

test("dispatchTemplate records message_errors on a send failure, same as dispatchText", async () => {
  reset();
  responseQueue = [
    { data: { window_expires_at: NOT_EXPIRED, contact_id: "contact_1" }, error: null },
    { data: { phone: "+15550000001", opt_in: true }, error: null },
    { data: REAL_INTEGRATION, error: null },
    { data: { id: "msg_failed_2" }, error: null },
  ];
  // Empty body → no code, no detail candidate → fromHttpStatus(500).
  sendTemplateImpl = async () => {
    throw new FakeKapsoError(500, {}, "x");
  };
  const result = await dispatchTemplate({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    templateName: "confirmacion",
  });
  assert.equal(result.errorCode, "SEND_FAILED");
  assert.equal(
    result.error,
    "WhatsApp no está disponible en este momento. Vuelve a intentar en unos minutos.",
  );
  assert.equal(upserts.length, 1);
  const errorRow = upserts[0].row as {
    message_id: string;
    code: number | null;
    detail: string | null;
    source: string;
    http_status: number | null;
  };
  assert.equal(errorRow.message_id, "msg_failed_2");
  assert.equal(errorRow.code, null);
  assert.equal(errorRow.detail, null);
  assert.equal(errorRow.source, "unknown");
  assert.equal(errorRow.http_status, 500);
});

// ── providerCode: el código numérico de Meta ─────────────────────────────────

test("dispatchTemplate propaga el código numérico de Meta en providerCode cuando el envío falla", async () => {
  reset();
  responseQueue = [
    { data: { window_expires_at: NOT_EXPIRED, contact_id: "contact_1" }, error: null },
    { data: { phone: "+15550000001", opt_in: true }, error: null },
    { data: REAL_INTEGRATION, error: null },
    { data: { id: "msg_failed_3" }, error: null },
  ];
  sendTemplateImpl = async () => {
    throw new FakeKapsoError(400, { error: { code: 132015, message: "x" } }, "x");
  };
  const result = await dispatchTemplate({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    templateName: "confirmacion",
  });
  assert.equal(result.errorCode, "SEND_FAILED");
  assert.equal(result.providerCode, 132015);
});

test("dispatchTemplate deja providerCode undefined (no 0, no NaN) cuando Meta no manda código", async () => {
  reset();
  responseQueue = [
    { data: { window_expires_at: NOT_EXPIRED, contact_id: "contact_1" }, error: null },
    { data: { phone: "+15550000001", opt_in: true }, error: null },
    { data: REAL_INTEGRATION, error: null },
    { data: { id: "msg_failed_4" }, error: null },
  ];
  sendTemplateImpl = async () => {
    throw new FakeKapsoError(500, {}, "x");
  };
  const result = await dispatchTemplate({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    templateName: "confirmacion",
  });
  assert.equal(result.errorCode, "SEND_FAILED");
  assert.equal(result.providerCode, undefined);
});

test("dispatchTemplate deja providerCode undefined cuando el código de Meta no es numérico", async () => {
  reset();
  responseQueue = [
    { data: { window_expires_at: NOT_EXPIRED, contact_id: "contact_1" }, error: null },
    { data: { phone: "+15550000001", opt_in: true }, error: null },
    { data: REAL_INTEGRATION, error: null },
    { data: { id: "msg_failed_5" }, error: null },
  ];
  sendTemplateImpl = async () => {
    throw new FakeKapsoError(400, { error: { code: "abc", message: "x" } }, "x");
  };
  const result = await dispatchTemplate({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    templateName: "confirmacion",
  });
  assert.equal(result.errorCode, "SEND_FAILED");
  assert.equal(result.providerCode, undefined);
});

test("dispatchTemplate no incluye providerCode en un envío exitoso", async () => {
  reset();
  responseQueue = [
    { data: { window_expires_at: NOT_EXPIRED, contact_id: "contact_1" }, error: null },
    { data: { phone: "+15550000001", opt_in: true }, error: null },
    { data: REAL_INTEGRATION, error: null },
    { error: null },
    { error: null },
  ];
  const result = await dispatchTemplate({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    templateName: "confirmacion",
  });
  assert.equal(result.ok, true);
  assert.equal("providerCode" in result, false);
});

// ── Aislamiento por workspace y la costura preparar/enviar ───────────────────

test("dispatchTemplate carga la conversación filtrando por workspace", async () => {
  reset();
  responseQueue = [
    { data: { window_expires_at: EXPIRED, contact_id: "contact_1" }, error: null },
    { data: { phone: "+15550000001", opt_in: true }, error: null },
    { data: REAL_INTEGRATION, error: null },
    { error: null }, // insert del mensaje
    { error: null }, // last_message_at
  ];
  await dispatchTemplate({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    templateName: "confirmacion",
  });
  // Por TABLA: el filtro está en conversations Y en contacts, y borrar solo el
  // segundo dejaba en verde un `some()` sin tabla.
  assert.ok(
    filteredByWorkspace("conversations", "ws_1"),
    "sin este filtro un conversationId ajeno recibiría el template",
  );
  assert.ok(
    filteredByWorkspace("contacts", "ws_1"),
    "sin este filtro se leería el teléfono de un contacto de otro tenant",
  );
});

test("prepareTemplateDispatch no lanza ante una base caída y NO envía nada", async () => {
  reset();
  // El punto entero de la costura: el ejecutor tiene que poder clasificar esto
  // ANTES de escribir dispatched_at. Si esta función lanzara —como lanzaba
  // loadConversationAndPhone—, el ejecutor no podría distinguirlo de un envío
  // fallido y perdería el mensaje sin haber llamado nunca a Kapso.
  responseQueue = [{ data: null, error: { message: "connection refused" } }];
  const prep = await prepareTemplateDispatch({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    templateName: "confirmacion",
  });
  assert.equal(prep.ok, false);
  assert.equal((prep as { errorCode: string }).errorCode, "DB_ERROR");
  assert.equal(
    (prep as { retryable: boolean }).retryable,
    true,
    "una base caída se reintenta; una integración ausente no",
  );
  assert.equal(sendTemplateCalls.length, 0, "no hubo request externo");
});

test("dispatchText también filtra por workspace al cargar la conversación", async () => {
  reset();
  // El opt_in viene en la misma consulta del contacto: no hay segunda lectura.
  responseQueue = [
    { data: { window_expires_at: NOT_EXPIRED, contact_id: "contact_1" }, error: null },
    { data: { phone: "+15550000001", opt_in: true }, error: null },
    { data: REAL_INTEGRATION, error: null },
    { error: null },
    { error: null },
  ];
  const result = await dispatchText({ workspaceId: "ws_1", conversationId: "conv_1", body: "hola" });
  assert.equal(result.ok, true);
  assert.ok(filteredByWorkspace("conversations", "ws_1"));
  assert.ok(filteredByWorkspace("contacts", "ws_1"));
});

test("integración habilitada sin credenciales es config rota, no un envío en cola", async () => {
  // Camino de error: enabled = true pero credentials/config vacíos.
  reset();
  responseQueue = [
    { data: { window_expires_at: NOT_EXPIRED, contact_id: "contact_1" }, error: null },
    { data: { phone: "+15550000001", opt_in: true }, error: null },
    { data: { credentials: {}, config: {} }, error: null },
  ];

  const prep = await prepareTemplateDispatch({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    templateName: "bienvenida",
  });

  assert.equal(prep.ok, false);
  assert.equal((prep as { errorCode: string }).errorCode, "CONFIG_ERROR");
  assert.equal((prep as { error: string }).error, "missing_kapso_credentials");
  assert.equal(
    (prep as { retryable: boolean }).retryable,
    false,
    "una credencial que falta no se arregla reintentando",
  );
  assert.equal(sendTemplateCalls.length, 0, "no hay POST");
  assert.equal(
    inserts.filter((i) => i.table === "messages").length,
    0,
    "y NO se escribe un mensaje 'queued' que haga parecer que salió",
  );

  // Camino correcto: con las dos credenciales presentes, prepara y deja listo
  // el envío.
  reset();
  responseQueue = [
    { data: { window_expires_at: NOT_EXPIRED, contact_id: "contact_1" }, error: null },
    { data: { phone: "+15550000001", opt_in: true }, error: null },
    {
      data: {
        credentials: { kapso_api_key: "key_1" },
        config: { phone_number_id: "pn_1" },
      },
      error: null,
    },
  ];

  const ok = await prepareTemplateDispatch({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    templateName: "bienvenida",
  });
  assert.equal(ok.ok, true);
});

test("una credencial cifrada ilegible es config rota sin reintento, y prepareTemplateDispatch no lanza", async () => {
  reset();
  responseQueue = [
    { data: { window_expires_at: NOT_EXPIRED, contact_id: "contact_1" }, error: null },
    { data: { phone: "+15550000001", opt_in: true }, error: null },
    {
      data: {
        credentials: { kapso_api_key: "enc:1:not-an-iv:not-a-ciphertext" },
        config: { phone_number_id: "pn_1" },
      },
      error: null,
    },
  ];

  const prep = await prepareTemplateDispatch({
    workspaceId: "ws_1",
    conversationId: "conv_1",
    templateName: "bienvenida",
  });

  assert.equal(prep.ok, false);
  assert.equal((prep as { errorCode: string }).errorCode, "CONFIG_ERROR");
  assert.equal((prep as { error: string }).error, "credentials_unreadable");
  assert.equal((prep as { retryable: boolean }).retryable, false);
  assert.equal(sendTemplateCalls.length, 0, "no hay POST");
});

test("el centinela 'placeholder' es config rota fuera de desarrollo, y sigue encolando dentro", async () => {
  // El modo dev encola el mensaje como `queued` y devuelve ok SIN llamar a
  // Kapso. Fuera de desarrollo eso es una mentira que el motor de
  // automatizaciones consume: cerraba el run como `done` sin WhatsApp.
  const PLACEHOLDER_INTEGRATION = {
    credentials: { kapso_api_key: "placeholder" },
    config: { phone_number_id: "pn_1" },
  };
  const queueFor = () => [
    { data: { window_expires_at: NOT_EXPIRED, contact_id: "contact_1" }, error: null },
    { data: { phone: "+15550000001", opt_in: true }, error: null },
    { data: PLACEHOLDER_INTEGRATION, error: null },
  ];
  const original = process.env.NODE_ENV;

  try {
    // Camino de error: producción con la api key de mentira.
    reset();
    responseQueue = queueFor();
    setNodeEnv("production");

    const prod = await prepareTemplateDispatch({
      workspaceId: "ws_1",
      conversationId: "conv_1",
      templateName: "bienvenida",
    });

    assert.equal(prod.ok, false);
    assert.equal((prod as { errorCode: string }).errorCode, "CONFIG_ERROR");
    assert.equal((prod as { error: string }).error, "missing_kapso_credentials");
    assert.equal(
      (prod as { retryable: boolean }).retryable,
      false,
      "una api key de mentira no se arregla reintentando",
    );
    assert.equal(
      inserts.filter((i) => i.table === "messages").length,
      0,
      "y NO se escribe un mensaje 'queued' que haga parecer que salió",
    );

    // Camino correcto: en desarrollo el centinela sigue siendo el no-op de
    // siempre, así que prepara y `sendPreparedTemplate` encola.
    reset();
    responseQueue = queueFor();
    setNodeEnv("development");

    const dev = await prepareTemplateDispatch({
      workspaceId: "ws_1",
      conversationId: "conv_1",
      templateName: "bienvenida",
    });

    assert.equal(dev.ok, true);
    assert.equal(
      (dev as { prepared: { apiKey: string } }).prepared.apiKey,
      "placeholder",
    );
  } finally {
    setNodeEnv(original);
  }
});
