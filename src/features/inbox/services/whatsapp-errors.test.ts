/**
 * Corre con `npm run test:unit` (node --test, sin framework).
 * El módulo bajo prueba es puro a propósito: no importa `@/` ni Supabase.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  parseWhatsAppError,
  extractWebhookError,
  formatErrorForLog,
  toMessageErrorRow,
  recordMessageError,
  parseTemplateError,
  GENERIC_SEND_ERROR,
  GENERIC_TEMPLATE_ERROR,
} from "./whatsapp-errors.ts";

// Texto técnico que NUNCA puede aparecer en el mensaje del operador.
const LEAKS = [
  "error",
  "code",
  "131",
  "132",
  "http",
  "fbtrace",
  "kapso",
  "undefined",
  "null",
  "[object",
  "sandbox",
];

function assertNoLeak(message: string) {
  assert.ok(message.length > 0, "el mensaje al operador no puede ir vacío");
  const lower = message.toLowerCase();
  for (const needle of LEAKS) {
    assert.ok(
      !lower.includes(needle),
      `el mensaje al operador filtró "${needle}": ${message}`,
    );
  }
}

// ── camino feliz: códigos conocidos ──────────────────────────────────────────

test("131047 → texto de ventana de 24 h, no reintentable", () => {
  const err = parseWhatsAppError(
    {
      error: {
        message: "(#131047) Re-engagement message",
        type: "OAuthException",
        code: 131047,
        error_data: {
          messaging_product: "whatsapp",
          details:
            "Message failed to send because more than 24 hours have passed since the customer last replied to this number.",
        },
        fbtrace_id: "AbC123",
      },
    },
    400,
  );

  assert.equal(err.code, 131047);
  assert.match(err.message, /24 horas/);
  assert.match(err.message, /plantilla/);
  assert.equal(err.retryable, false);
  assert.equal(err.source, "response");
  assert.equal(err.httpStatus, 400);
  assert.equal(err.fbtraceId, "AbC123");
  assert.match(err.detail ?? "", /24 hours/); // el inglés queda en detail
  assertNoLeak(err.message);
});

test("131056 (pair rate limit) es reintentable; 132015 (plantilla pausada) no", () => {
  assert.equal(parseWhatsAppError({ error: { code: 131056 } }).retryable, true);
  assert.equal(parseWhatsAppError({ error: { code: 132015 } }).retryable, false);
  assert.equal(parseWhatsAppError({ error: { code: 130429 } }).retryable, true);
  assert.equal(parseWhatsAppError({ error: { code: 131016 } }).retryable, true);
  assert.equal(parseWhatsAppError({ error: { code: 131000 } }).retryable, true);
});

test("todos los códigos del alcance traen texto propio en español", () => {
  const codes = [
    131047, 131026, 131021, 131049, 131051, 131052, 131053, 131056, 130429,
    131016, 131000, 131042, 131031, 132000, 132001, 132005, 132007, 132012,
    132015, 132016, 133010, 100, 190, 0, 33, 131008, 131009, 131064,
  ];
  const seen = new Set<string>();
  for (const code of codes) {
    const err = parseWhatsAppError({ error: { code } });
    assert.equal(err.code, code);
    assert.notEqual(
      err.message,
      GENERIC_SEND_ERROR,
      `el código ${code} cayó al fallback genérico`,
    );
    assertNoLeak(err.message);
    seen.add(err.message);
  }
  assert.equal(seen.size, codes.length, "hay textos duplicados entre códigos");
});

test("el código viaja como string numérico (algunos webhooks lo mandan así)", () => {
  const err = parseWhatsAppError({ error: { code: "131047" } });
  assert.equal(err.code, 131047);
  assert.match(err.message, /24 horas/);
});

// ── caminos de error ─────────────────────────────────────────────────────────

test("código desconocido → fallback genérico, sin reventar", () => {
  const err = parseWhatsAppError({ error: { code: 999999, message: "boom" } });
  assert.equal(err.code, 999999);
  assert.equal(err.message, GENERIC_SEND_ERROR);
  assert.equal(err.retryable, false);
  assert.equal(err.detail, "boom");
  assertNoLeak(err.message);
});

test("sin código + HTTP 503 → fallback por status, reintentable", () => {
  const err = parseWhatsAppError({}, 503);
  assert.equal(err.code, null);
  assert.equal(err.retryable, true);
  assert.match(err.message, /no está disponible/);
  assertNoLeak(err.message);
});

test("sin código + HTTP 429 / 401 / 400 → fallback por status", () => {
  assert.equal(parseWhatsAppError(null, 429).retryable, true);
  assert.match(parseWhatsAppError(null, 401).message, /credenciales/);
  assert.equal(parseWhatsAppError(null, 401).retryable, false);
  assert.match(parseWhatsAppError(null, 400).message, /rechazó/);
  assertNoLeak(parseWhatsAppError(null, 400).message);
});

test("formato propio de Kapso: string suelto en `error`, sin código", () => {
  const err = parseWhatsAppError(
    { error: "Active sandbox session required to send messages" },
    403,
  );
  assert.equal(err.code, null);
  assert.equal(err.source, "kapso");
  assert.equal(err.detail, "Active sandbox session required to send messages");
  assert.equal(err.retryable, false);
  // El texto inglés de Kapso NO puede llegar al operador.
  assertNoLeak(err.message);
});

test("null / undefined / objeto vacío → genérico, nunca lanza", () => {
  for (const input of [null, undefined, {}, [], "", 42, true]) {
    const err = parseWhatsAppError(input);
    assert.equal(err.message, GENERIC_SEND_ERROR);
    assert.equal(err.retryable, false);
    assertNoLeak(err.message);
  }
});

// ── webhook de status ────────────────────────────────────────────────────────

test("errors[] de un webhook de status usa `title` (no `type`)", () => {
  const err = extractWebhookError({
    message: {
      id: "wamid.ABC",
      errors: [
        {
          code: 131026,
          title: "Message undeliverable",
          error_data: { details: "Receiver is incapable of receiving message" },
        },
      ],
    },
  });

  assert.equal(err.code, 131026);
  assert.equal(err.source, "webhook");
  assert.match(err.message, /no tenga WhatsApp/);
  assert.equal(err.detail, "Receiver is incapable of receiving message");
  assertNoLeak(err.message);
});

test("el extractor busca en los distintos candidatos del sobre de Kapso", () => {
  const shapes = [
    { message: { errors: [{ code: 131047 }] } },
    { errors: [{ code: 131047 }] },
    { error: { code: 131047 } },
    { message: { kapso: { error: { code: 131047 } } } },
  ];
  for (const shape of shapes) {
    assert.equal(extractWebhookError(shape).code, 131047, JSON.stringify(shape));
  }
});

test("errors[] con varias entradas se queda con la primera que trae código", () => {
  const err = extractWebhookError({
    errors: [{ title: "sin codigo" }, { code: 132015 }],
  });
  assert.equal(err.code, 132015);
});

test("webhook failed sin ningún error reconocible → genérico, no rompe", () => {
  for (const input of [
    {},
    { message: { id: "wamid.X" } },
    { errors: [] },
    { errors: "roto" },
    null,
  ]) {
    const err = extractWebhookError(input);
    assert.equal(err.message, GENERIC_SEND_ERROR);
    assertNoLeak(err.message);
  }
});

// ── salidas auxiliares ───────────────────────────────────────────────────────

test("el log del servidor sí lleva el detalle técnico", () => {
  const err = parseWhatsAppError(
    { error: { code: 131047, error_data: { details: "24h passed" } } },
    400,
  );
  const line = formatErrorForLog(err);
  assert.match(line, /code=131047/);
  assert.match(line, /http=400/);
  assert.match(line, /24h passed/);
});

test("toMessageErrorRow arma la fila de message_errors con su tenant y mensaje", () => {
  const row = toMessageErrorRow(
    parseWhatsAppError({ error: { code: 132001, fbtrace_id: "Zz" } }, 400),
    "ws-1",
    "msg-1",
  );
  assert.deepEqual(Object.keys(row).sort(), [
    "code",
    "detail",
    "fbtrace_id",
    "http_status",
    "message_id",
    "source",
    "workspace_id",
  ]);
  assert.equal(row.workspace_id, "ws-1");
  assert.equal(row.message_id, "msg-1");
  assert.equal(row.code, 132001);
  assert.equal(row.fbtrace_id, "Zz");
  assert.equal(row.http_status, 400);
  assert.equal(row.source, "response");
});

test("toMessageErrorRow tolera un payload sin nada: la fila igual se puede insertar", () => {
  const row = toMessageErrorRow(parseWhatsAppError(null), "ws-1", "msg-1");
  assert.equal(row.code, null);
  assert.equal(row.detail, null);
  assert.equal(row.http_status, null);
  assert.equal(row.fbtrace_id, null);
  // `source` es NOT NULL en la tabla: nunca puede quedar vacío.
  assert.equal(row.source, "unknown");
});

/** Cliente Supabase de mentira: registra el upsert y devuelve lo que se le diga. */
function fakeClient(result: { error: { message: string } | null } | Error) {
  const calls: {
    table: string;
    row: Record<string, unknown>;
    options: { onConflict: string; ignoreDuplicates: boolean };
  }[] = [];
  return {
    calls,
    from(table: string) {
      return {
        upsert(
          row: Record<string, unknown>,
          options: { onConflict: string; ignoreDuplicates: boolean },
        ) {
          calls.push({ table, row, options });
          return result instanceof Error
            ? Promise.reject(result)
            : Promise.resolve(result);
        },
      };
    },
  };
}

test("recordMessageError inserta en message_errors, nunca en messages.meta", async () => {
  const client = fakeClient({ error: null });
  await recordMessageError(
    client,
    parseWhatsAppError({ error: { code: 131047 } }, 400),
    "ws-1",
    "msg-1",
  );
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].table, "message_errors");
  assert.equal(client.calls[0].row.workspace_id, "ws-1");
  assert.equal(client.calls[0].row.code, 131047);
  // El detalle técnico no vuelve a `meta` por ninguna vía.
  assert.equal(client.calls[0].row.wa_error, undefined);
});

test("recordMessageError escribe ON CONFLICT DO NOTHING: un replay no duplica", async () => {
  const client = fakeClient({ error: null });
  const err = parseWhatsAppError({ error: { code: 131047 } }, 400);
  // El mismo evento firmado reproducido dos veces (la firma de Kapso no lleva
  // timestamp): las dos escrituras van contra la misma clave y la segunda no
  // agrega fila porque la base la descarta.
  await recordMessageError(client, err, "ws-1", "msg-1");
  await recordMessageError(client, err, "ws-1", "msg-1");
  for (const call of client.calls) {
    assert.equal(call.options.onConflict, "message_id");
    assert.equal(call.options.ignoreDuplicates, true);
  }
});

test("recordMessageError con la base rechazando: loguea y sigue, no lanza", async () => {
  const client = fakeClient({ error: { message: "permission denied" } });
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    await recordMessageError(
      client,
      parseWhatsAppError({ error: { code: 131047 } }, 400),
      "ws-1",
      "msg-1",
    );
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 1, "el fallo queda en el log del servidor");
  // Sin workspace/mensaje/código en el log, el registro perdido es indepurable.
  const line = logged[0].join(" ");
  assert.match(line, /ws-1/);
  assert.match(line, /msg-1/);
  assert.match(line, /131047/);
  assert.match(line, /permission denied/);
});

test("recordMessageError con la conexión caída (promesa rechazada): no lanza", async () => {
  const client = fakeClient(new Error("ECONNRESET"));
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    await assert.doesNotReject(() =>
      recordMessageError(
        client,
        parseWhatsAppError({ error: { code: 131047 } }, 400),
        "ws-1",
        "msg-1",
      ),
    );
  } finally {
    console.error = original;
  }
  const line = logged[0].join(" ");
  assert.match(line, /ws-1/);
  assert.match(line, /msg-1/);
  assert.match(line, /ECONNRESET/);
});

// ── anidamiento hostil: nunca desbordar la pila ──────────────────────────────

test("payload con anidamiento razonable: sigue leyendo el código", () => {
  const err = parseWhatsAppError({ error: { error: { code: 131047 } } }, 400);
  assert.equal(err.code, 131047);
  assert.match(err.message, /24 horas/);
});

test("payload con 20.000 niveles de `error`: devuelve el genérico, no revienta", () => {
  let payload: Record<string, unknown> = { code: 131047 };
  for (let i = 0; i < 20_000; i++) payload = { error: payload };

  const err = parseWhatsAppError(payload, 400);
  assert.equal(err.code, null, "se corta antes de llegar al código");
  assert.equal(
    err.message,
    "WhatsApp rechazó el mensaje. Revisa el contenido y el número de destino.",
  );
  assertNoLeak(err.message);
});

// ── plantillas: creación (submit) ────────────────────────────────────────────

test("plantillas: los códigos del catálogo llegan traducidos al operador", () => {
  for (const [code, needle] of [
    [132000, /variables/i],
    [132001, /no existe o no está aprobada/i],
    [132007, /políticas/i],
    [2388040, /largo permitido/i],
    [2388072, /cuerpo de la plantilla/i],
    [2388293, /demasiadas variables/i],
  ] as [number, RegExp][]) {
    const err = parseTemplateError({ error: { code } }, 400);
    assert.equal(err.code, code);
    assert.match(err.message, needle);
    assertNoLeak(err.message);
  }
});

test("plantillas: un código desconocido NO filtra el texto de Meta", () => {
  const err = parseTemplateError(
    {
      error: {
        code: 999999,
        message: "(#100) Invalid parameter",
        error_data: { details: "template name is invalid" },
      },
    },
    400,
  );
  assert.equal(err.message, GENERIC_TEMPLATE_ERROR);
  assert.ok(!err.message.includes("100"), "el código de Meta no puede salir");
  assert.ok(!err.message.includes("Invalid"), "el inglés de Meta no puede salir");
  assertNoLeak(err.message);
  // El detalle técnico sí queda disponible para el log del servidor.
  assert.match(formatErrorForLog(err), /template name is invalid/);
});

test("plantillas: el error plano de Kapso tampoco llega al operador", () => {
  const err = parseTemplateError({ error: "Active sandbox session required" }, 403);
  assertNoLeak(err.message);
  assert.match(err.message, /no está autorizada/i, "403 conserva el texto de credenciales");
  assert.match(formatErrorForLog(err), /Active sandbox session required/);
});

test("plantillas: un 5xx conserva el texto de 'vuelve a intentar' y es reintentable", () => {
  const err = parseTemplateError(null, 503);
  assert.equal(err.retryable, true);
  assert.match(err.message, /vuelve a intentar/i);
  assertNoLeak(err.message);
});

test("plantillas: sin payload ni status devuelve el genérico de plantilla", () => {
  const err = parseTemplateError(null, null);
  assert.equal(err.message, GENERIC_TEMPLATE_ERROR);
  assert.equal(err.retryable, false);
  assertNoLeak(err.message);
});
