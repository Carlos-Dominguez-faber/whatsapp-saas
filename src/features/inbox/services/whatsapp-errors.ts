/**
 * whatsapp-errors.ts — traduce un error de WhatsApp/Kapso a algo que un
 * operador puede leer y accionar, y deja el detalle técnico aparte.
 *
 * Módulo PURO a propósito: sin `@/`, sin Supabase, sin fetch. Así corre bajo
 * `node --test` sin levantar Next ni la base.
 *
 * Regla de Meta (Graph v24.0, que Kapso espeja): ramificar SIEMPRE por
 * `error.code` + `error_data.details`. `error_subcode` ya no se devuelve desde
 * v16.0, y los títulos (`message`) van a ser deprecados — nunca se matchea por
 * texto.
 *
 * Invariante de seguridad: `message` sale SIEMPRE de las tablas de este archivo.
 * Nada del payload remoto se copia ahí. El texto crudo vive en `detail`, que es
 * solo para `console.error` del servidor.
 */

import type { MessageErrorRow } from "../types";

/** Fila de `message_errors` lista para insertar (id y created_at los pone la DB). */
export type MessageErrorInsert = Omit<MessageErrorRow, "id" | "created_at">;

/**
 * Lo mínimo de un cliente Supabase para insertar en `message_errors`. Tipado
 * estructural para no importar `@supabase/supabase-js` acá (ver cabecera).
 */
export interface MessageErrorWriter {
  from(table: string): {
    upsert(
      row: MessageErrorInsert,
      options: { onConflict: string; ignoreDuplicates: boolean },
    ): PromiseLike<{
      error: { message: string } | null;
    }>;
  };
}

export interface WhatsAppError {
  /** Código numérico de Meta, o null cuando el payload no trae ninguno. */
  code: number | null;
  /** Texto en español para el operador. Nunca contiene datos del payload. */
  message: string;
  /** True solo si reintentar el mismo envío tiene sentido (backoff 4^X). */
  retryable: boolean;
  /** Detalle crudo (inglés, `details`/`title`). SOLO logs del servidor. */
  detail: string | null;
  /** De dónde se extrajo, para depurar después. */
  source: "response" | "webhook" | "kapso" | "unknown";
  httpStatus: number | null;
  fbtraceId: string | null;
}

interface Entry {
  text: string;
  retry: boolean;
}

/** Lo que ve el operador cuando no sabemos nada más. Nunca revienta. */
export const GENERIC_SEND_ERROR =
  "No se pudo enviar el mensaje. Vuelve a intentar en unos minutos; si sigue fallando, avisa al equipo.";

/** Errores propios (no vienen de Meta) que también llegan al operador. */
export const WINDOW_EXPIRED_MESSAGE =
  "Pasaron más de 24 horas desde el último mensaje del contacto. Envía una plantilla para retomar la conversación.";

export const OPT_OUT_MESSAGE =
  "Este contacto pidió no recibir más mensajes por WhatsApp. Solo puedes escribirle si vuelve a contactarte.";

/**
 * Códigos de la Cloud API → texto accionable + si conviene reintentar.
 * Fuente: referencia de error codes de Meta (verificada 2026-08-11).
 * Reintentables según Meta: 130429, 131056, 131016, 131000 y 5xx.
 */
const CATALOG: Record<number, Entry> = {
  0: {
    text: "La conexión con WhatsApp perdió la sesión. Hay que volver a conectar la cuenta en Ajustes.",
    retry: false,
  },
  33: {
    text: "El número de WhatsApp configurado ya no existe. Revisa la conexión en Ajustes.",
    retry: false,
  },
  100: {
    text: "WhatsApp rechazó el mensaje porque alguno de sus datos no es válido. Revisa el contenido y vuelve a intentar.",
    retry: false,
  },
  190: {
    text: "La conexión con WhatsApp expiró. Hay que reconectar la cuenta en Ajustes.",
    retry: false,
  },
  130429: {
    text: "Se están enviando demasiados mensajes por minuto. Espera un momento y vuelve a intentar.",
    retry: true,
  },
  131000: {
    text: "WhatsApp no pudo procesar el mensaje. Vuelve a intentar en unos minutos.",
    retry: true,
  },
  131008: {
    text: "Falta información obligatoria en el mensaje. Revísalo y vuelve a intentar.",
    retry: false,
  },
  131009: {
    text: "Alguno de los datos del mensaje no es válido para WhatsApp. Revísalo y vuelve a intentar.",
    retry: false,
  },
  131016: {
    text: "WhatsApp no está disponible en este momento. Vuelve a intentar en unos minutos.",
    retry: true,
  },
  131021: {
    text: "El número de destino es el mismo número de la cuenta. Usa otro destinatario.",
    retry: false,
  },
  131026: {
    text: "No se pudo entregar el mensaje: puede que ese número no tenga WhatsApp. Confirma el número con el contacto.",
    retry: false,
  },
  131031: {
    text: "La cuenta de WhatsApp está restringida por una revisión de Meta. Hay que resolverlo en WhatsApp Manager antes de seguir enviando.",
    retry: false,
  },
  131042: {
    text: "Hay un problema con el método de pago de la cuenta de WhatsApp. Revisa la facturación en Meta.",
    retry: false,
  },
  131047: {
    text: "Pasaron más de 24 horas desde el último mensaje del contacto. Envía una plantilla para retomar la conversación.",
    retry: false,
  },
  131049: {
    text: "WhatsApp limitó los mensajes promocionales hacia este contacto. Espera al menos 24 horas antes de volver a escribirle.",
    retry: false,
  },
  131051: {
    text: "Ese tipo de mensaje no está disponible para este número. Envía el contenido como texto o como plantilla.",
    retry: false,
  },
  131052: {
    text: "No se pudo descargar el archivo que envió el contacto. Pídele que lo mande de nuevo o por otra vía.",
    retry: false,
  },
  131053: {
    text: "No se pudo subir el archivo adjunto. Revisa que el formato sea compatible y vuelve a intentar.",
    retry: false,
  },
  131056: {
    text: "Se enviaron varios mensajes seguidos a este contacto. Espera unos segundos y vuelve a intentar.",
    retry: true,
  },
  131064: {
    text: "La cuenta superó su límite de mensajes por una revisión de plantillas de Meta. El límite se levanta solo al terminar esa revisión.",
    retry: false,
  },
  132000: {
    text: "La plantilla espera más datos de los que se enviaron. Completa todas sus variables.",
    retry: false,
  },
  132001: {
    text: "La plantilla no existe o no está aprobada en ese idioma. Elige otra plantilla.",
    retry: false,
  },
  132005: {
    text: "El texto traducido de la plantilla es demasiado largo. Acórtalo en WhatsApp Manager.",
    retry: false,
  },
  132007: {
    text: "El contenido de la plantilla no cumple las políticas de WhatsApp. Hay que corregirla y volver a enviarla a aprobación.",
    retry: false,
  },
  132012: {
    text: "El formato de las variables no coincide con el de la plantilla aprobada. Revisa sus datos.",
    retry: false,
  },
  132015: {
    text: "La plantilla está pausada por baja calidad. Usa otra plantilla mientras se corrige.",
    retry: false,
  },
  132016: {
    text: "La plantilla fue deshabilitada de forma permanente. Hay que crear una plantilla nueva con otro contenido.",
    retry: false,
  },
  // Creación/edición de plantillas (Graph 2388xxx).
  2388039: {
    text: "La plantilla no se puede modificar mientras WhatsApp la está revisando. Espera a que termine la revisión.",
    retry: false,
  },
  2388040: {
    text: "Algún campo de la plantilla supera el largo permitido por WhatsApp. Acorta el texto y vuelve a enviarla.",
    retry: false,
  },
  2388047: {
    text: "El encabezado de la plantilla no tiene el formato que exige WhatsApp. Revísalo y vuelve a enviarla.",
    retry: false,
  },
  2388072: {
    text: "El cuerpo de la plantilla no tiene el formato que exige WhatsApp. Revísalo y vuelve a enviarla.",
    retry: false,
  },
  2388073: {
    text: "El pie de la plantilla no tiene el formato que exige WhatsApp. Revísalo y vuelve a enviarla.",
    retry: false,
  },
  2388293: {
    text: "La plantilla tiene demasiadas variables para el largo de su texto. Agrega más texto fijo o quita variables.",
    retry: false,
  },
  133010: {
    text: "El número de WhatsApp no está registrado en la plataforma. Hay que registrarlo antes de enviar.",
    retry: false,
  },
};

/** Fallback cuando no hay código numérico (típico de los errores propios de Kapso). */
function fromHttpStatus(status: number | null): Entry {
  if (status === null) return { text: GENERIC_SEND_ERROR, retry: false };
  if (status >= 500 || status === 408)
    return {
      text: "WhatsApp no está disponible en este momento. Vuelve a intentar en unos minutos.",
      retry: true,
    };
  if (status === 429)
    return {
      text: "Se enviaron demasiados mensajes en poco tiempo. Espera unos minutos y vuelve a intentar.",
      retry: true,
    };
  if (status === 401 || status === 403)
    return {
      text: "La conexión con WhatsApp no está autorizada. Revisa las credenciales en Ajustes.",
      retry: false,
    };
  if (status >= 400)
    return {
      text: "WhatsApp rechazó el mensaje. Revisa el contenido y el número de destino.",
      retry: false,
    };
  return { text: GENERIC_SEND_ERROR, retry: false };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Tope de anidamiento de `{ error: { error: … } }`. Graph anida 1–2 niveles; el
 * límite existe para que un payload hostil (o corrupto) con miles de niveles no
 * tire un RangeError por desbordar la pila y se pierda el evento en silencio.
 */
const MAX_UNWRAP_DEPTH = 10;

/** Devuelve el nodo que realmente lleva el error, desenvolviendo `{ error: … }`. */
function unwrap(
  payload: unknown,
  depth = 0,
): {
  node: Record<string, unknown> | null;
  text: string | null;
  source: WhatsAppError["source"];
} {
  if (typeof payload === "string")
    return { node: null, text: asText(payload), source: "kapso" };

  if (Array.isArray(payload)) {
    // errors[] de un webhook de status: nos quedamos con el primero que traiga code.
    const withCode = payload.find((e) => asCode(asRecord(e)?.code) !== null);
    return {
      node: asRecord(withCode ?? payload[0]),
      text: null,
      source: "webhook",
    };
  }

  const rec = asRecord(payload);
  if (!rec) return { node: null, text: null, source: "unknown" };

  // Formato propio de Kapso: { "error": "texto plano" }, sin código.
  const plain = asText(rec.error);
  if (plain) return { node: null, text: plain, source: "kapso" };

  if (Array.isArray(rec.error) || asRecord(rec.error)) {
    // Demasiado profundo: se corta y cae al mensaje genérico, sin reventar.
    if (depth >= MAX_UNWRAP_DEPTH)
      return { node: null, text: null, source: "unknown" };
    const inner = unwrap(rec.error, depth + 1);
    return {
      node: inner.node,
      text: inner.text,
      // { error: { code, … } } es la respuesta del POST (Graph).
      source: Array.isArray(rec.error) ? "webhook" : "response",
    };
  }

  // Ya viene desenvuelto: { code, title, error_data … }
  return {
    node: rec,
    text: null,
    source: asCode(rec.code) !== null ? "response" : "unknown",
  };
}

/**
 * Normaliza cualquier error de envío de WhatsApp/Kapso.
 *
 * Acepta la respuesta del POST (Graph: `error.code`, `error.error_data.details`,
 * `fbtrace_id`), una entrada del array `errors[]` de un webhook de status
 * (`code` + `title`), y el formato propio de Kapso (`{"error": "texto plano"}`).
 * Con `null`, `undefined` o `{}` devuelve el fallback genérico — nunca lanza.
 */
export function parseWhatsAppError(
  payload: unknown,
  httpStatus: number | null = null,
): WhatsAppError {
  const { node, text, source } = unwrap(payload);

  const code = asCode(node?.code);
  const errorData = asRecord(node?.error_data);
  // El detalle útil vive en error_data.details; `title`/`message` son el respaldo
  // (y solo para el log: nunca se muestran al operador).
  const detail =
    asText(errorData?.details) ??
    asText(node?.details) ??
    asText(node?.title) ??
    asText(node?.message) ??
    text;

  const entry = (code !== null ? CATALOG[code] : undefined) ??
    fromHttpStatus(httpStatus);

  return {
    code,
    message: entry.text,
    retryable: entry.retry,
    detail,
    source,
    httpStatus,
    fbtraceId: asText(node?.fbtrace_id),
  };
}

/** Fallback cuando falla CREAR una plantilla y el código no está en el catálogo. */
export const GENERIC_TEMPLATE_ERROR =
  "WhatsApp no aceptó la plantilla. Revisa el nombre, el texto y los botones, y vuelve a intentar.";

/**
 * Igual que `parseWhatsAppError`, pero para la creación de plantillas: reusa el
 * mismo catálogo de códigos y solo cambia el fallback, porque el texto de envío
 * ("revisa el número de destino") no aplica a crear una plantilla.
 */
export function parseTemplateError(
  payload: unknown,
  httpStatus: number | null = null,
): WhatsAppError {
  const parsed = parseWhatsAppError(payload, httpStatus);
  if (parsed.code !== null && parsed.code in CATALOG) return parsed;
  // Estos textos hablan de la conexión o de la disponibilidad, no del envío:
  // sirven igual para una plantilla.
  if (
    httpStatus !== null &&
    (httpStatus >= 500 ||
      httpStatus === 408 ||
      httpStatus === 429 ||
      httpStatus === 401 ||
      httpStatus === 403)
  )
    return parsed;
  return { ...parsed, message: GENERIC_TEMPLATE_ERROR, retryable: false };
}

/**
 * Busca el error dentro del sobre de un webhook de status de Kapso.
 *
 * OJO: dónde cuelga el array de errores en el sobre de Kapso NO está verificado
 * contra un payload real — Kapso parte cada status de Meta en su propio evento y
 * su documentación no muestra el `failed`. Por eso se recorren los candidatos
 * razonables y se toma el primero que traiga un `code`. Cuando llegue un
 * `whatsapp.message.failed` real, confirmar la ruta y dejar solo esa.
 */
export function extractWebhookError(event: unknown): WhatsAppError {
  const rec = asRecord(event);
  const message = asRecord(rec?.message);
  const candidates: unknown[] = [
    message?.errors,
    rec?.errors,
    rec?.error,
    asRecord(message?.kapso)?.error,
  ];

  let fallback: WhatsAppError | null = null;
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    const parsed = parseWhatsAppError(candidate);
    if (parsed.code !== null) return { ...parsed, source: "webhook" };
    if (!fallback && parsed.detail) fallback = { ...parsed, source: "webhook" };
  }

  return fallback ?? parseWhatsAppError(null);
}

/** Una línea para `console.error`. Server-side ONLY — jamás va al cliente. */
export function formatErrorForLog(error: WhatsAppError): string {
  return [
    `code=${error.code ?? "-"}`,
    `http=${error.httpStatus ?? "-"}`,
    `source=${error.source}`,
    `fbtrace=${error.fbtraceId ?? "-"}`,
    `detail=${error.detail ?? "-"}`,
  ].join(" ");
}

/**
 * La fila de `message_errors` para depurar después.
 *
 * Antes esto era `toMetaError`, que iba a `messages.meta.wa_error` — y de ahí
 * al navegador, porque el inbox hace `select("*")` y Realtime replica la fila
 * entera. Ahora el detalle vive en su propia tabla, con RLS y sin políticas.
 * `retryable` ya no se persiste: se deriva del código y solo se usa en vuelo.
 */
export function toMessageErrorRow(
  error: WhatsAppError,
  workspaceId: string,
  messageId: string,
): MessageErrorInsert {
  return {
    workspace_id: workspaceId,
    message_id: messageId,
    code: error.code,
    detail: error.detail,
    source: error.source,
    http_status: error.httpStatus,
    fbtrace_id: error.fbtraceId,
  };
}

/**
 * Escribe la fila de `message_errors`. Best-effort a propósito.
 *
 * Nunca lanza ni devuelve error: perder el registro técnico es preferible a
 * perder el mensaje (dispatch) o a responder 500 y que Kapso reintente el
 * webhook entero. Si falla, queda en el log del servidor y se sigue.
 *
 * Es un upsert con `ignoreDuplicates` (ON CONFLICT DO NOTHING) contra el índice
 * único de `message_id`: la firma de Kapso no lleva timestamp, así que el mismo
 * evento `failed` se puede reproducir y no debe multiplicar filas ni fallar.
 *
 * El cliente se recibe por parámetro para que este módulo siga sin importar
 * Supabase y pueda correr bajo `node --test`.
 */
export async function recordMessageError(
  client: MessageErrorWriter,
  error: WhatsAppError,
  workspaceId: string,
  messageId: string,
): Promise<void> {
  // Contexto mínimo para depurar sin ir a buscar la request: qué workspace, qué
  // mensaje y qué código se estaba registrando cuando la escritura falló.
  const ctx = `ws=${workspaceId} msg=${messageId} code=${error.code ?? "-"}`;
  try {
    const { error: insertError } = await client
      .from("message_errors")
      .upsert(toMessageErrorRow(error, workspaceId, messageId), {
        onConflict: "message_id",
        ignoreDuplicates: true,
      });
    if (insertError) {
      console.error(
        `[message_errors] insert failed (${ctx}):`,
        insertError.message,
      );
    }
  } catch (err) {
    console.error(
      `[message_errors] insert threw (${ctx}):`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
