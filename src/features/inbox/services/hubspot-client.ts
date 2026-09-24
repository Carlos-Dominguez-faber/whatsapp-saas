/**
 * hubspot-client.ts — cliente de HubSpot CRM.
 *
 * Espejo de highlevel-client.ts SIN una interfaz CrmProvider común. El único switch por
 * proveedor vive en crm-sync.ts. Auth: token de Private App en
 * integrations.credentials.hubspot_token, cifrado con integration-secrets.ts.
 *
 * Contrato: NINGUNA función exportada lanza. Devuelven null / {ok:false, code}; el detalle queda
 * server-side. A `events` y a la cola solo van CÓDIGOS.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { createClient as createSbClient } from "@supabase/supabase-js";
import { decryptCredentials } from "@/shared/lib/integration-secrets";
import { splitName } from "./highlevel-client";

const HS_BASE_URL = "https://api.hubapi.com";
/** Versión fechada de la API. Un solo lugar: si el smoke da 404, se cambia acá. */
export const HS_API_VERSION = "2026-09";
const HS_TIMEOUT_MS = 10_000;
const HS_MAX_RETRY_AFTER_S = 10;

export const HS_PHONE_PROPERTY = "whatsapp_phone";
export const HS_TAGS_PROPERTY = "whatsapp_tags";

/**
 * Deadline absoluto (ms epoch) de la corrida en curso. Lo fija el procesador de la cola del cron
 * con `hsDeadline.run(deadline, …)`; cada hsFetch recorta su timeout a lo que quede. Fuera de
 * una corrida no hay deadline y rige HS_TIMEOUT_MS. Se usa AsyncLocalStorage (stdlib) para no
 * pasar el deadline por cada firma.
 */
export const hsDeadline = new AsyncLocalStorage<number>();

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export interface HubSpotConfig {
  token: string;
  pipelineId: string | null;
  dealStageId: string | null;
  /** true cuando "Probar conexión" validó ESTE token y las propiedades del agente. */
  propertiesReady: boolean;
}

export type HsErrorCode =
  | "unauthorized"
  | "missing_scope"
  | "rate_limited"
  | "not_found"
  | "conflict"
  | "bad_request"
  | "bad_response"
  | "network"
  | "timeout"
  | "deadline"
  | "http_error";

export type HsResponse =
  | { ok: true; status: number; json: unknown }
  | { ok: false; status: number; code: HsErrorCode; body: string };

/** Resultado interno: éxito con datos, o un CÓDIGO (nunca texto de HubSpot). */
export type Outcome<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; code: string };

function codeForStatus(status: number): HsErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "missing_scope";
  if (status === 429) return "rate_limited";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 400) return "bad_request";
  return "http_error";
}

function retryAfterMs(res: Response): number {
  const raw = res.headers.get("retry-after");
  const seconds = raw === null ? 1 : Number(raw);
  const safe = Number.isFinite(seconds) && seconds >= 0 ? seconds : 1;
  return Math.min(safe, HS_MAX_RETRY_AFTER_S) * 1000;
}

/**
 * Único punto por el que sale una llamada a HubSpot. Nunca lanza. El `body` de un error queda
 * para que el caller lo PARSEE (409, INVALID_OPTION), nunca para loguearlo ni mostrarlo.
 */
export async function hsFetch(
  token: string,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    /**
     * Tiempo mínimo que tiene que quedar en el deadline de la corrida para mandar CADA intento (el
     * primero y el reintento del 429); si no queda, `deadline` sin llamar. Para un POST no
     * idempotente: con el timeout recortado, HubSpot puede confirmarlo después del aborto y
     * la cola lo repetiría. Sin corrida (sin deadline) no aplica.
     */
    minRemainingMs?: number;
  } = {},
): Promise<HsResponse> {
  const deadline = hsDeadline.getStore();
  const minRemaining = init.minRemainingMs ?? 0;
  const fits = (remaining: number) => deadline === undefined || remaining >= minRemaining;
  for (let attempt = 0; ; attempt++) {
    const remaining = deadline === undefined ? HS_TIMEOUT_MS : deadline - Date.now();
    if (remaining <= 0 || !fits(remaining)) return { ok: false, status: 0, code: "deadline", body: "" };

    let res: Response;
    try {
      res = await fetch(`${HS_BASE_URL}${path}`, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          // Un GET sin cuerpo no manda Content-Type (cosmético, pero un
          // proxy/WAF estricto puede rechazar un Content-Type sin body).
          ...(init.body !== undefined && { "Content-Type": "application/json" }),
        },
        ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(Math.min(HS_TIMEOUT_MS, remaining)),
      });
    } catch (err) {
      const timedOut =
        err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return { ok: false, status: 0, code: timedOut ? "timeout" : "network", body: "" };
    }

    // 429: un solo reintento, y solo si la espera cabe en el deadline.
    if (res.status === 429 && attempt === 0) {
      const wait = retryAfterMs(res);
      if (deadline !== undefined && Date.now() + wait >= deadline) {
        return { ok: false, status: 429, code: "rate_limited", body: "" };
      }
      // La espera cabe, pero después no quedaría el mínimo: no se duerme para nada (el chequeo de
      // arriba del loop igual lo cortaría al volver).
      if (deadline !== undefined && !fits(deadline - Date.now() - wait)) {
        return { ok: false, status: 0, code: "deadline", body: "" };
      }
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    const text = await res.text().catch(() => "");
    if (!res.ok) {
      return { ok: false, status: res.status, code: codeForStatus(res.status), body: text };
    }
    try {
      return { ok: true, status: res.status, json: text ? JSON.parse(text) : null };
    } catch {
      return { ok: false, status: res.status, code: "bad_response", body: "" };
    }
  }
}

export type HsConfigErrorCode = "not_configured" | "decrypt_failed" | "db_error";

/**
 * Igual que `getHubSpotConfig`, pero distingue "no configurado" de "no se pudo leer":
 * un error transitorio de PostgREST (504/timeout) no puede convertirse en "no configurado". La
 * usan `logHubSpotConversation` y `pushContactToHubSpot` (a la que aquella llama), que sí
 * necesitan reintentar un `db_error`; el resto de los callers de config sigue con el contrato
 * null de `getHubSpotConfig`. Exportada además para `integrations/hubspot/test`, que necesita distinguir "no configurado" de "no se pudo leer" para no mostrarle al
 * admin "guarda primero el token" cuando el problema es transitorio o el descifrado falló.
 */
export async function readHubSpotConfig(
  workspaceId: string,
): Promise<{ ok: true; config: HubSpotConfig } | { ok: false; code: HsConfigErrorCode }> {
  const { data, error } = await svc()
    .from("integrations")
    .select("credentials, config")
    .eq("workspace_id", workspaceId)
    .eq("provider", "hubspot")
    .eq("enabled", true)
    .maybeSingle();
  if (error) return { ok: false, code: "db_error" };
  if (!data) return { ok: false, code: "not_configured" };

  let creds: Record<string, unknown>;
  try {
    creds = await decryptCredentials(
      data.credentials as Record<string, unknown> | null,
      workspaceId,
      "hubspot",
    );
  } catch (err) {
    console.error("[HS] getHubSpotConfig: no se pudo descifrar credentials", {
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "decrypt_failed" };
  }

  const token = creds.hubspot_token;
  if (typeof token !== "string" || token.length === 0) return { ok: false, code: "not_configured" };

  const config = (data.config as Record<string, unknown> | null) ?? {};
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    ok: true,
    config: {
      token,
      pipelineId: str(config.pipeline_id),
      dealStageId: str(config.deal_stage_id),
      propertiesReady: config.properties_ready === true,
    },
  };
}

/**
 * Token y config del workspace; null si HubSpot no está habilitado, no tiene token, el token no
 * se puede descifrar O la lectura falló. Contrato nunca-lanza: un descifrado fallido degrada a
 * null (queda registrado server-side) en vez de propagar. Los callers que necesitan distinguir un error transitorio de "no
 * configurado" usan `readHubSpotConfig` en su lugar (hoy solo `logHubSpotConversation`).
 */
export async function getHubSpotConfig(workspaceId: string): Promise<HubSpotConfig | null> {
  const r = await readHubSpotConfig(workspaceId);
  return r.ok ? r.config : null;
}

/**
 * Huella del token para `config.token_fingerprint`: permite saber si un token nuevo es el mismo
 * sin guardarlo en claro, y ata "Probar conexión" al token que probó. Se calcula SIEMPRE sobre el
 * token en claro (el PUT antes de cifrar, el resto después de descifrar), nunca sobre el texto
 * cifrado: el cifrado usa IV aleatorio y la huella cambiaría en cada guardado del mismo token.
 */
export function hubSpotTokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

/** Identidad de la cuenta de HubSpot del token. */
export async function getHubSpotPortalId(token: string): Promise<Outcome<{ portalId: string }>> {
  const res = await hsFetch(token, `/account-info/${HS_API_VERSION}/details`);
  if (!res.ok) return { ok: false, code: res.code };
  const portalId = (res.json as { portalId?: unknown } | null)?.portalId;
  if (typeof portalId !== "number" && typeof portalId !== "string") {
    return { ok: false, code: "bad_response" };
  }
  return { ok: true, portalId: String(portalId) };
}

// ── Propiedades propias ─────────────────────────────────────────────

const PROPERTY_DEFINITIONS = [
  {
    conflictCode: "phone_property_conflict",
    createRejectedCode: "phone_property_create_rejected",
    body: {
      groupName: "contactinformation",
      name: HS_PHONE_PROPERTY,
      label: "WhatsApp (teléfono)",
      description: "Teléfono E.164 del contacto en el agente de WhatsApp. Lo escribe la integración.",
      type: "string",
      fieldType: "text",
      hasUniqueValue: true,
    },
  },
  {
    conflictCode: "tags_property_conflict",
    createRejectedCode: "tags_property_create_rejected",
    body: {
      groupName: "contactinformation",
      name: HS_TAGS_PROPERTY,
      label: "Etiquetas WhatsApp",
      description: "Etiquetas que pone el agente de WhatsApp. Las opciones se agregan solas.",
      type: "enumeration",
      fieldType: "checkbox",
      // HubSpot exige ≥1 opción para crear una enumeración (400 MISSING_OPTIONS si va vacía):
      // placeholder oculto, nunca visible al usuario ni usado como etiqueta real (hsTagValue()
      // siempre da wa_<20 hex>, nunca "wa_placeholder"). No se borra: sin ella, crear la
      // propiedad falla en cuentas nuevas. `addTagOptions` conserva esta opción al agregar etiquetas.
      options: [{ label: "(sin etiquetas)", value: "wa_placeholder", displayOrder: 0, hidden: true }],
    },
  },
] as const;

/** La propiedad remota sirve solo si tiene el tipo esperado (y es única, si se exige). */
function matchesDefinition(
  def: (typeof PROPERTY_DEFINITIONS)[number]["body"],
  remote: unknown,
): boolean {
  const p = remote as { type?: unknown; fieldType?: unknown; hasUniqueValue?: unknown } | null;
  if (!p || p.type !== def.type || p.fieldType !== def.fieldType) return false;
  return !("hasUniqueValue" in def) || p.hasUniqueValue === true;
}

/**
 * Crea whatsapp_phone (texto, único) y whatsapp_tags (casillas) si faltan, y VALIDA las que ya
 * existen o las que devuelve un 409. Idempotente. La llama integrations/hubspot/test.
 */
export async function ensureHubSpotProperties(token: string): Promise<Outcome> {
  for (const { body, conflictCode, createRejectedCode } of PROPERTY_DEFINITIONS) {
    const path = `/crm/properties/${HS_API_VERSION}/contacts/${body.name}`;
    const found = await hsFetch(token, path);
    if (found.ok) {
      if (!matchesDefinition(body, found.json)) return { ok: false, code: conflictCode };
      continue;
    }
    if (found.code !== "not_found") return { ok: false, code: found.code };

    const created = await hsFetch(token, `/crm/properties/${HS_API_VERSION}/contacts`, {
      method: "POST",
      body,
    });
    if (created.ok) {
      if (!matchesDefinition(body, created.json)) return { ok: false, code: conflictCode };
      continue;
    }
    // 400: HubSpot RECHAZÓ crear la propiedad — no es transitorio, reintentar no lo
    // arregla. Código específico por propiedad en vez del `bad_request` genérico, para que la ruta
    // muestre un mensaje que no lo disfrace de error pasajero. Otros códigos (401/403/429/5xx, red)
    // siguen su camino normal más abajo.
    if (created.code === "bad_request") return { ok: false, code: createRejectedCode };
    if (created.code !== "conflict") return { ok: false, code: created.code };

    // 409: otra llamada (o alguien a mano) la creó en el medio. Se relee y se valida.
    const again = await hsFetch(token, path);
    if (!again.ok) return { ok: false, code: again.code };
    if (!matchesDefinition(body, again.json)) return { ok: false, code: conflictCode };
  }
  return { ok: true };
}

// ── Contactos ──────────────────────────────────────────────────────

/** Qué cambió localmente. crm-sync.ts la pasa tal cual; HighLevel la ignora. */
export interface CrmSyncOptions {
  /**
   * Etiquetas recién agregadas localmente. Presente ⇒ la subida manda TODAS las etiquetas locales
   * (unión, nunca quita), no solo estas.
   */
  addTags?: string[];
  /** Etiqueta recién quitada localmente: se quita en HubSpot (delta). También activa el envío del set completo de altas (ver `addTags`). */
  removeTag?: string;
  /** Empuja nombre/email a un contacto existente. Solo la edición del operador. */
  pushProfile?: boolean;
  /**
   * Botón "Sincronizar CRM": manda TODAS las etiquetas locales aunque no haya
   * un delta. Sin esto, un log/deal/profile-only push (sin cambio de etiquetas) no las tocaría y
   * una copia perdida solo se curaría en el próximo add/remove real.
   */
  allTags?: boolean;
}

interface HsContactRow {
  id: string;
  name: string | null;
  phone: string;
  email: string | null;
  tags: string[] | null;
  hs_contact_id: string | null;
}

type HsEventType = "crm_sync_failed" | "hs_ambiguous_phone";

/**
 * Evento con CÓDIGOS (nunca texto de HubSpot). Best-effort. Exportado para que
 * hubspot-log-queue.ts lo reuse en el cierre de un ítem en vez de duplicar el insert.
 */
export async function recordHsEvent(
  workspaceId: string,
  type: HsEventType,
  payload: Record<string, unknown>,
  conversationId: string | null = null,
): Promise<void> {
  const { error } = await svc()
    .from("events")
    .insert({
      type,
      level: "warn",
      workspace_id: workspaceId,
      conversation_id: conversationId,
      payload: { provider: "hubspot", ...payload },
    });
  if (error) console.error("[HS] no se pudo registrar el evento", { type, workspaceId });
}

/**
 * Solo lo no vacío: un vacío local nunca borra un dato de HubSpot. Sin `phone`: a un contacto
 * existente solo se le empujan nombre y email; `phone` viaja solo al crear (el teléfono de un contacto que
 * el cliente ya tenía en HubSpot no se pisa; la identidad propia va en whatsapp_phone).
 */
function profileProperties(contact: HsContactRow): Record<string, string> {
  const { firstName, lastName } = splitName(contact.name);
  return {
    ...(firstName && { firstname: firstName }),
    ...(lastName && { lastname: lastName }),
    ...(contact.email && { email: contact.email }),
  };
}

const V = HS_API_VERSION;

function remoteIdentity(r: { properties?: Record<string, unknown> }): string | null {
  const v = r.properties?.[HS_PHONE_PROPERTY];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Una sola búsqueda (5 grupos en OR): la identidad propia (whatsapp_phone) y el respaldo por
 * phone/mobilephone con y sin "+". `identity`: el contacto que ya es de este teléfono.
 * `free`: matches por teléfono SIN whatsapp_phone. Los que tienen otro whatsapp_phone son de otra
 * identidad y no se tocan.
 */
async function findContacts(
  token: string,
  phone: string,
): Promise<Outcome<{ identity: string | null; free: string[] }>> {
  const variants = [...new Set([phone, phone.replace(/^\+/, "")])];
  const filterGroups = [
    { filters: [{ propertyName: HS_PHONE_PROPERTY, operator: "EQ", value: phone }] },
    ...["phone", "mobilephone"].flatMap((propertyName) =>
      variants.map((value) => ({ filters: [{ propertyName, operator: "EQ", value }] })),
    ),
  ];
  const res = await hsFetch(token, `/crm/objects/${V}/contacts/search`, {
    method: "POST",
    // Orden determinístico. Sin `sorts`, HubSpot no garantiza el orden
    // de resultados; con varios matches, `free[0]` (contacto que ya tenía el cliente) o el
    // conteo de `hs_ambiguous_phone` no pueden depender de un orden que cambia entre llamadas.
    body: {
      filterGroups,
      properties: [HS_PHONE_PROPERTY],
      limit: 10,
      sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
    },
  });
  if (!res.ok) return { ok: false, code: res.code };
  const results = (res.json as { results?: Array<{ id?: unknown; properties?: Record<string, unknown> }> } | null)?.results;
  if (!Array.isArray(results)) return { ok: false, code: "bad_response" };

  const valid = results.filter((r): r is { id: string; properties?: Record<string, unknown> } =>
    typeof r.id === "string" && r.id.length > 0,
  );
  const identity = valid.find((r) => remoteIdentity(r) === phone)?.id ?? null;
  const free = [...new Set(valid.filter((r) => remoteIdentity(r) === null).map((r) => r.id))];
  return { ok: true, identity, free };
}

/**
 * Id del contacto existente en un rechazo por duplicado (formato verificado contra la API real):
 * - email de otro contacto → `409` "Contact already exists. Existing ID: 123";
 * - whatsapp_phone único → `400` VALIDATION_ERROR "... on 456. 123 already has that value."
 */
function existingIdFrom(text: string): string | null {
  const m = /Existing ID:\s*(\d+)/i.exec(text) ?? /(\d+) already has that value/i.exec(text);
  return m ? m[1] : null;
}

async function writeIdentity(token: string, id: string, phone: string): Promise<Outcome> {
  const res = await hsFetch(token, `/crm/objects/${V}/contacts/${id}`, {
    method: "PATCH",
    body: { properties: { [HS_PHONE_PROPERTY]: phone } },
  });
  return res.ok ? { ok: true } : { ok: false, code: res.code };
}

/**
 * Crea el contacto con perfil + whatsapp_phone. Un 409 (carrera por el whatsapp_phone único, o
 * el email de otro contacto) se resuelve ENLAZANDO sin tocar el perfil. Si el existente ya
 * es de otra identidad, no se lo roba.
 */
async function createContact(
  token: string,
  contact: HsContactRow,
): Promise<Outcome<{ id: string; created: boolean }>> {
  const res = await hsFetch(token, `/crm/objects/${V}/contacts`, {
    method: "POST",
    body: { properties: { ...profileProperties(contact), phone: contact.phone, [HS_PHONE_PROPERTY]: contact.phone } },
  });
  if (res.ok) {
    const id = (res.json as { id?: unknown } | null)?.id;
    return typeof id === "string" && id ? { ok: true, id, created: true } : { ok: false, code: "bad_response" };
  }
  if (res.code !== "conflict" && res.code !== "bad_request") return { ok: false, code: res.code };

  const existing = existingIdFrom(res.body);
  if (!existing) return { ok: false, code: res.code };
  const current = await hsFetch(
    token,
    `/crm/objects/${V}/contacts/${existing}?properties=${HS_PHONE_PROPERTY}`,
  );
  if (!current.ok) return { ok: false, code: current.code };
  const owner = remoteIdentity((current.json as { properties?: Record<string, unknown> } | null) ?? {});
  if (owner && owner !== contact.phone) return { ok: false, code: "email_taken" };
  if (!owner) {
    const linked = await writeIdentity(token, existing, contact.phone);
    if (!linked.ok) return linked;
  }
  return { ok: true, id: existing, created: false };
}

async function resolveHubSpotContactId(
  token: string,
  workspaceId: string,
  contact: HsContactRow,
): Promise<Outcome<{ id: string; created: boolean }>> {
  const found = await findContacts(token, contact.phone);
  if (!found.ok) return found;
  if (found.identity) return { ok: true, id: found.identity, created: false };

  if (found.free.length === 1) {
    const id = found.free[0];
    // Contacto que el cliente ya tenía: solo la identidad. Nombre y email los manda HubSpot;
    // el pull los trae.
    const linked = await writeIdentity(token, id, contact.phone);
    return linked.ok ? { ok: true, id, created: false } : linked;
  }
  if (found.free.length > 1) {
    await recordHsEvent(workspaceId, "hs_ambiguous_phone", {
      contact_id: contact.id,
      matches: found.free.length,
    });
  }
  return createContact(token, contact);
}

/**
 * Empuja el contacto local a HubSpot y deja `contacts.hs_contact_id` escrito. Devuelve el
 * CÓDIGO del fallo (lo usa la cola de conversaciones); los fallos de HubSpot quedan además en
 * `events` (crm_sync_failed). Filtra el tenant en cada lectura y escritura.
 * Nunca lanza.
 *
 * Sin `preloaded`, usa `readHubSpotConfig` (no el wrapper público) para distinguir "no
 * configurado" de un error TRANSITORIO de lectura: un `db_error` tiene que
 * poder reintentarse, no cerrar `cancelled` como si HubSpot no estuviera conectado. Los callers
 * que ya leyeron la config (log, pull, negocio) la pasan en `preloaded` y no se relee.
 */
export async function pushContactToHubSpot(
  workspaceId: string,
  contactId: string,
  opts: CrmSyncOptions = {},
  /**
   * Config que el caller ya leyó: una sola lectura por
   * operación, para que el enlace y la llamada final del caller usen el MISMO token. Sin ella,
   * un PUT entre dos lecturas enlazaba un id del portal B y el caller lo usaba con el token A.
   */
  preloaded?: HubSpotConfig,
): Promise<Outcome<{ hs_id: string }>> {
  const cfgResult = preloaded
    ? ({ ok: true, config: preloaded } as const)
    : await readHubSpotConfig(workspaceId);
  if (!cfgResult.ok) {
    if (cfgResult.code === "db_error") return { ok: false, code: "db_error" };
    if (cfgResult.code === "decrypt_failed") return { ok: false, code: "config_decrypt_failed" };
    return { ok: false, code: "not_configured" };
  }
  const cfg = cfgResult.config;

  const fail = async (code: string, step: string): Promise<{ ok: false; code: string }> => {
    await recordHsEvent(workspaceId, "crm_sync_failed", { code, step, contact_id: contactId });
    return { ok: false, code };
  };
  if (!cfg.propertiesReady) return fail("properties_not_ready", "config");

  const db = svc();
  const fingerprint = hubSpotTokenFingerprint(cfg.token);
  // El contacto —y sobre todo su hs_contact_id ya existente— se lee
  // con la RPC read_hubspot_link, atada a la huella del token que se va a usar (misma condición y
  // FOR SHARE que link_hubspot_contact). Con un SELECT suelto, un worker con la config del token A
  // leía un enlace que otro sync ya había hecho con B y, como el id estaba, se saltaba la RPC de
  // enlace y su chequeo: escribía con el token A sobre el id de B. mark_hubspot_ready limpia los
  // enlaces en la misma transacción que cambia el portal, así que un enlace leído con la huella
  // vigente es del portal de ese token.
  const { data, error } = await db.rpc("read_hubspot_link", {
    p_workspace_id: workspaceId,
    p_contact_id: contactId,
    p_token_fingerprint: fingerprint,
  });
  // Un error TRANSITORIO de lectura no es lo mismo que "no existe" — el primero es reintentable
  // (la cola vuelve a intentar), el segundo no.
  if (error) {
    console.error("[HS] pushContactToHubSpot: error transitorio leyendo el contacto", { workspaceId, contactId });
    return { ok: false, code: "db_error" };
  }
  const row = ((data as Array<HsContactRow & { ready: boolean }> | null) ?? [])[0];
  // Huella que ya no es la vigente (o integración no lista): el mismo estado reintentable que el
  // rechazo de link_hubspot_contact; el próximo intento lee la config nueva.
  if (row && !row.ready) return fail("properties_not_ready", "read");
  if (!row) {
    console.error("[HS] pushContactToHubSpot: contacto no encontrado", { workspaceId, contactId });
    return { ok: false, code: "contact_not_found" };
  }
  const contact: HsContactRow = row;

  let hsId = contact.hs_contact_id;
  let profileSent = false;
  if (!hsId) {
    const resolved = await resolveHubSpotContactId(cfg.token, workspaceId, contact);
    if (!resolved.ok) return fail(resolved.code, "resolve");
    // El enlace se escribe SOLO si el token con que se resolvió el id sigue vigente
    // (huella) y la integración sigue lista, en una sentencia (RPC link_hubspot_contact). Un
    // UPDATE directo dejaría enlazado un id de la cuenta vieja si un PUT cambió el token en medio.
    const { data: linked, error: linkError } = await db.rpc("link_hubspot_contact", {
      p_workspace_id: workspaceId,
      p_contact_id: contactId,
      p_hs_contact_id: resolved.id,
      p_token_fingerprint: fingerprint,
    });
    if (linkError) {
      return fail(linkError.code === "23505" ? "hs_id_taken" : "db_write_failed", "link");
    }
    // false = el token cambió o la integración dejó de estar lista: el mismo estado que
    // `properties_not_ready` de arriba, reintentable en la cola hasta que se pruebe el token nuevo.
    if (linked !== true) return fail("properties_not_ready", "link");
    hsId = resolved.id;
    profileSent = resolved.created;
  }

  // Un 404 del CONTACTO = lo borraron o fusionaron en HubSpot: el enlace quedó vencido y nunca se
  // recuperaría solo. Se suelta con CAS y el código es reintentable: el
  // próximo intento vuelve a resolver por whatsapp_phone.
  const linkedId = hsId;
  const contactFail = async (code: string, step: string) => {
    if (code !== "not_found") return fail(code, step);
    await clearStaleLink(db, workspaceId, contactId, linkedId);
    return fail("stale_link", step);
  };

  if (opts.pushProfile && !profileSent) {
    const res = await hsFetch(cfg.token, `/crm/objects/${V}/contacts/${hsId}`, {
      method: "PATCH",
      body: { properties: profileProperties(contact) },
    });
    if (!res.ok) return contactFail(res.code, "profile");
  }

  // Solo una subida CON cambio de etiquetas (addTags/
  // removeTag dados) o el botón manual (allTags) toca whatsapp_tags. Un log, un deal o un
  // pushProfile solo no la tocan, así no se acopla su éxito a una etiqueta que HubSpot rechaza.
  // Cuando sí toca, manda TODAS las etiquetas locales como altas (unión, nunca pisa) para que un
  // add perdido (timeout, 429, properties_not_ready, instancia congelada) se cure en la próxima
  // subida CON cambio de etiquetas. Los removes siguen siendo delta: uno perdido no se reintenta
  // (no hay cola de removes).
  if (opts.addTags !== undefined || opts.removeTag !== undefined || opts.allTags === true) {
    const removed = opts.removeTag?.trim();
    const addTags = [...new Set([...(contact.tags ?? []), ...(opts.addTags ?? [])])].filter(
      (t) => t.trim() !== removed,
    );
    if (addTags.length > 0) {
      const res = await appendTags(cfg.token, hsId, addTags);
      if (!res.ok) return contactFail(res.code, "tags");
    }
    if (opts.removeTag) {
      const res = await removeTagFromHubSpot(cfg.token, hsId, opts.removeTag);
      if (!res.ok) return contactFail(res.code, "tags");
    }
  }

  return { ok: true, hs_id: hsId };
}

/**
 * Suelta un enlace vencido. La regla "el enlace se escribe SOLO por link_hubspot_contact" trata
 * de PONER un id; esto solo lo quita, y con CAS sobre el id vencido: si otro push re-enlazó
 * entretanto, no afecta ninguna fila y el enlace nuevo queda. Best-effort: si falla, el próximo
 * intento recibe el mismo 404 y lo vuelve a intentar.
 */
async function clearStaleLink(
  db: ReturnType<typeof svc>,
  workspaceId: string,
  contactId: string,
  staleId: string,
): Promise<void> {
  const { error } = await db
    .from("contacts")
    .update({ hs_contact_id: null, updated_at: new Date().toISOString() })
    .eq("id", contactId)
    .eq("workspace_id", workspaceId)
    .eq("hs_contact_id", staleId);
  if (error) console.error("[HS] no se pudo soltar el enlace vencido", { workspaceId, contactId });
}

// ── Etiquetas: whatsapp_tags es la ÚNICA representación en HubSpot ───────

/**
 * Valor interno de la opción: estable y sin colisiones. La etiqueta original viaja como label
 * (`a;b` y `a,b` son etiquetas distintas).
 */
export function hsTagValue(tag: string): string {
  return `wa_${createHash("sha256").update(tag.trim()).digest("hex").slice(0, 20)}`;
}

function isInvalidOption(res: HsResponse): boolean {
  return !res.ok && res.code === "bad_request" && /INVALID_OPTION|allowed options/i.test(res.body);
}

async function addTagOptions(token: string, tags: string[]): Promise<Outcome> {
  const path = `/crm/properties/${V}/contacts/${HS_TAGS_PROPERTY}`;
  const prop = await hsFetch(token, path);
  if (!prop.ok) return { ok: false, code: prop.code };
  const options = (prop.json as {
    options?: Array<{ label: string; value: string; displayOrder?: number; hidden?: boolean }>;
  } | null)?.options;
  if (!Array.isArray(options)) return { ok: false, code: "bad_response" };

  const known = new Set(options.map((o) => o.value));
  const missing = tags.filter((t) => !known.has(hsTagValue(t)));
  if (missing.length === 0) return { ok: true };

  // El PATCH reescribe la lista completa; dos altas concurrentes pueden pisarse una
  // opción. El próximo add de esa etiqueta la vuelve a agregar; con el volumen del bot no
  // justifica un lock.
  const res = await hsFetch(token, path, {
    method: "PATCH",
    body: {
      options: [
        ...options,
        ...missing.map((t, i) => ({
          label: t,
          value: hsTagValue(t),
          displayOrder: options.length + i,
          hidden: false,
        })),
      ],
    },
  });
  return res.ok ? { ok: true } : { ok: false, code: res.code };
}

/** Append con ";" inicial. Opción inexistente → alta + UN reintento. */
async function appendTags(token: string, hsId: string, tags: string[]): Promise<Outcome> {
  const clean = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
  if (clean.length === 0) return { ok: true };
  const patch = () =>
    hsFetch(token, `/crm/objects/${V}/contacts/${hsId}`, {
      method: "PATCH",
      body: { properties: { [HS_TAGS_PROPERTY]: `;${clean.map(hsTagValue).join(";")}` } },
    });
  let res = await patch();
  if (isInvalidOption(res)) {
    const added = await addTagOptions(token, clean);
    // 404 acá es de la PROPIEDAD whatsapp_tags (la borraron), no del contacto: no es un enlace
    // vencido. "Probar conexión" la vuelve a crear, igual que con properties_not_ready.
    if (!added.ok) return added.code === "not_found" ? { ok: false, code: "properties_not_ready" } : added;
    res = await patch();
  }
  return res.ok ? { ok: true } : { ok: false, code: res.code };
}

/** HubSpot no tiene "quitar uno": se lee, se filtra por valor y se reescribe. */
async function removeTagFromHubSpot(token: string, hsId: string, tag: string): Promise<Outcome> {
  const target = hsTagValue(tag);
  const current = await hsFetch(token, `/crm/objects/${V}/contacts/${hsId}?properties=${HS_TAGS_PROPERTY}`);
  if (!current.ok) return { ok: false, code: current.code };
  const raw = (current.json as { properties?: Record<string, unknown> } | null)?.properties?.[HS_TAGS_PROPERTY];
  const values = typeof raw === "string" && raw ? raw.split(";").filter(Boolean) : [];
  if (!values.includes(target)) return { ok: true };
  // Leer-filtrar-reescribir. Una etiqueta puesta en HubSpot entre el GET y el PATCH se
  // pierde; ventana de milisegundos, y la etiqueta local (fuente de verdad) no se toca.
  const res = await hsFetch(token, `/crm/objects/${V}/contacts/${hsId}`, {
    method: "PATCH",
    body: { properties: { [HS_TAGS_PROPERTY]: values.filter((v) => v !== target).join(";") } },
  });
  return res.ok ? { ok: true } : { ok: false, code: res.code };
}

// ── Pull a demanda: sin webhooks con Private App ─────────────────────────────

/**
 * Trae nombre y email de HubSpot a los campos locales VACÍOS; si el contacto no está enlazado,
 * primero lo enlaza. `tags` NO va acá, a propósito: en HubSpot las etiquetas viven solo en
 * whatsapp_tags y las gobierna el lado local (nunca se traen de vuelta a contacts.tags).
 */
export async function syncContactFromHubSpot(
  workspaceId: string,
  contactId: string,
): Promise<{ hs_id: string; filled: Array<"name" | "email"> } | null> {
  const cfg = await getHubSpotConfig(workspaceId);
  if (!cfg) return null;

  const db = svc();
  const { data, error } = await db
    .from("contacts")
    .select("id, name, email")
    .eq("id", contactId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error || !data) return null;
  const local = data as { name: string | null; email: string | null };

  // El id sale SIEMPRE de pushContactToHubSpot (vía read_hubspot_link, atado a la huella de
  // `cfg.token`), nunca del SELECT de arriba: un enlace hecho con otro token no se lee con este.
  // Sin opciones y ya enlazado, no llama a HubSpot.
  const linked = await syncContactToHubSpot(workspaceId, contactId, {}, cfg);
  if (!linked) return null;
  const hsId = linked.hs_id;

  const res = await hsFetch(cfg.token, `/crm/objects/${V}/contacts/${hsId}?properties=firstname,lastname,email`);
  if (!res.ok) {
    await recordHsEvent(workspaceId, "crm_sync_failed", { code: res.code, step: "pull", contact_id: contactId });
    return null;
  }

  const props = (res.json as { properties?: Record<string, unknown> } | null)?.properties ?? {};
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const remoteName = [str(props.firstname), str(props.lastname)].filter(Boolean).join(" ");
  const remoteEmail = str(props.email);

  const filled: Array<"name" | "email"> = [];
  if (!local.name?.trim() && remoteName) {
    const r = await fillFieldIfStillEmpty(db, workspaceId, contactId, "name", remoteName);
    if (!r.ok) {
      await recordHsEvent(workspaceId, "crm_sync_failed", { code: "local_write_failed", step: "pull", contact_id: contactId });
      return null;
    }
    if (r.filled) filled.push("name");
  }
  if (!local.email?.trim() && remoteEmail) {
    const r = await fillFieldIfStillEmpty(db, workspaceId, contactId, "email", remoteEmail);
    if (!r.ok) {
      await recordHsEvent(workspaceId, "crm_sync_failed", { code: "local_write_failed", step: "pull", contact_id: contactId });
      return null;
    }
    if (r.filled) filled.push("email");
  }
  return { hs_id: hsId, filled };
}

/**
 * UPDATE condicionado a que el campo SIGA vacío al momento de escribir (no solo al momento de
 * leer): entre el SELECT y este UPDATE puede mediar un round-trip de hasta 10 s a HubSpot, y una
 * edición humana en el medio no se pisa. `filled` sale de si el UPDATE de verdad afectó una fila,
 * nunca del estado leído antes del round-trip.
 *
 * "Vacío" incluye un valor de puros espacios: el guard de escritura
 * matchea con una regex (`match`, POSIX `~`) en vez de solo `is.null`/`eq.''`, para que coincida
 * con el gate de LECTURA de más arriba, que usa `trim()`.
 */
async function fillFieldIfStillEmpty(
  db: ReturnType<typeof svc>,
  workspaceId: string,
  contactId: string,
  field: "name" | "email",
  value: string,
): Promise<{ ok: true; filled: boolean } | { ok: false }> {
  const { data, error } = await db
    .from("contacts")
    .update({ [field]: value, updated_at: new Date().toISOString() })
    .eq("id", contactId)
    .eq("workspace_id", workspaceId)
    .or(`${field}.is.null,${field}.match.^\\s*$`)
    .select("id");
  if (error) return { ok: false };
  return { ok: true, filled: Array.isArray(data) && data.length > 0 };
}

/** Wrapper para los callers que solo necesitan el id: null si no hubo sync. */
export async function syncContactToHubSpot(
  workspaceId: string,
  contactId: string,
  opts: CrmSyncOptions = {},
  preloaded?: HubSpotConfig,
): Promise<{ hs_id: string } | null> {
  const r = await pushContactToHubSpot(workspaceId, contactId, opts, preloaded);
  if (r.ok) return { hs_id: r.hs_id };
  if (r.code === "not_configured") {
    console.warn("[HS] syncContactToHubSpot: HubSpot no está conectado", workspaceId);
  }
  // Un error transitorio de lectura del contacto también queda server-side
  // en este wrapper (no solo en pushContactToHubSpot), para los callers que solo ven el `null`.
  if (r.code === "db_error") {
    console.error("[HS] syncContactToHubSpot: error transitorio leyendo el contacto", { workspaceId, contactId });
  }
  return null;
}

// ── Negocios: gemelo de las oportunidades de HighLevel ───────────────────────

/** Asociación HUBSPOT_DEFINED deal → contact (verificar en el smoke). */
const DEAL_TO_CONTACT = 3;

export interface HubSpotPipeline {
  id: string;
  name: string;
  stages: { id: string; name: string }[];
}

export async function listHubSpotPipelines(workspaceId: string): Promise<HubSpotPipeline[] | null> {
  const cfg = await getHubSpotConfig(workspaceId);
  if (!cfg) return null;
  const res = await hsFetch(cfg.token, `/crm/pipelines/${V}/deals`);
  if (!res.ok) {
    console.error("[HS] listHubSpotPipelines:", res.code, res.status);
    return null;
  }
  const results = (res.json as { results?: unknown } | null)?.results;
  // La forma se valida por elemento, no solo el array de afuera. Un
  // pipeline o una etapa que no es objeto, o `stages` que no es array, es respuesta ilegible
  // (null, con su código server-side): nunca un TypeError, y nunca "sin pipelines" en silencio.
  // `id` y `label` tienen que ser strings: String() de un objeto puede
  // lanzar, y de undefined da "undefined" como nombre.
  type Item = { id: string; label: string };
  const isItem = (v: unknown): v is Item & Record<string, unknown> =>
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>).id === "string" &&
    typeof (v as Record<string, unknown>).label === "string";
  const wellFormed =
    Array.isArray(results) &&
    results.every(
      (p) =>
        isItem(p) &&
        (p.stages === undefined || (Array.isArray(p.stages) && p.stages.every(isItem))),
    );
  if (!wellFormed) {
    console.error("[HS] listHubSpotPipelines:", "bad_response", res.status);
    return null;
  }
  return (results as Array<Item & { stages?: Item[] }>).map((p) => ({
    id: p.id,
    name: p.label,
    stages: (p.stages ?? []).map((s) => ({ id: s.id, name: s.label })),
  }));
}

/**
 * Crea un negocio en el pipeline/etapa configurados, asociado al contacto (lo enlaza primero si
 * hace falta). null si HubSpot no está conectado, falta configuración, el contacto no se pudo
 * enlazar o la API falló. Nunca lanza. El guard de "CRM activo" lo hace el caller (buffer.ts).
 */
export async function createHubSpotDeal(
  workspaceId: string,
  contactId: string,
  opts?: { name?: string },
): Promise<{ id: string } | null> {
  const cfg = await getHubSpotConfig(workspaceId);
  if (!cfg) return null;
  if (!cfg.pipelineId || !cfg.dealStageId) {
    console.warn("[HS] createHubSpotDeal: pipeline/etapa sin configurar", workspaceId);
    return null;
  }

  const linked = await syncContactToHubSpot(workspaceId, contactId, {}, cfg);
  if (!linked) return null;

  // Un error de esta lectura NO es lo mismo que un contacto genuinamente sin nombre: cae al
  // nombre genérico, pero queda server-side con su código.
  const { data, error } = await svc()
    .from("contacts")
    .select("name, phone")
    .eq("id", contactId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) {
    console.error("[HS] createHubSpotDeal: no se pudo leer nombre/teléfono del contacto", {
      workspaceId,
      contactId,
      code: "contact_read_failed",
    });
  }
  const contact = (!error && (data as { name: string | null; phone: string } | null)) || null;
  const dealname = opts?.name?.trim() || contact?.name?.trim() || contact?.phone || "Lead de WhatsApp";

  const res = await hsFetch(cfg.token, `/crm/objects/${V}/deals`, {
    method: "POST",
    body: {
      properties: { dealname, pipeline: cfg.pipelineId, dealstage: cfg.dealStageId },
      associations: [
        { to: { id: linked.hs_id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: DEAL_TO_CONTACT }] },
      ],
    },
  });
  if (!res.ok) {
    await recordHsEvent(workspaceId, "crm_sync_failed", { code: res.code, step: "deal", contact_id: contactId });
    return null;
  }
  const id = (res.json as { id?: unknown } | null)?.id;
  return typeof id === "string" && id ? { id } : null;
}

// ── Registro de la conversación en el timeline ───────────────────────────────

/** Asociación HUBSPOT_DEFINED communication → contact (verificar en el smoke). */
const COMMUNICATION_TO_CONTACT = 81;
const TRANSCRIPT_MESSAGES = 10;
const MAX_BODY_CHARS = 4000;
const REASON_LABEL = { handoff: "Traspaso a humano", closed: "Conversación cerrada" } as const;

function nonEmpty(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Recorta por CODE POINT, no por code unit UTF-16: `.slice(0, n)` puede
 * cortar un par subrogado (emoji) a la mitad y dejar un carácter suelto inválido en el body que
 * HubSpot recibe. `Array.from` itera por code point.
 */
function sliceCodePoints(s: string, max: number): string {
  return Array.from(s).slice(0, max).join("");
}

/**
 * Cascada SIN LLM: resumen del agente → lead_summary del setter → últimos 10 mensajes. El
 * encabezado lleva el número del agente para distinguirlo del inbox nativo de HubSpot.
 *
 * Un dato ilegible nunca se convierte en "no hay datos": un error de lectura en
 * CUALQUIER paso (kapso, contacto, mensajes) devuelve `db_error` para que la cola reintente, en
 * vez de dejar un registro falso (`(Sin mensajes.)`/sin número) permanente en el CRM.
 */
async function buildConversationBody(
  db: ReturnType<typeof svc>,
  workspaceId: string,
  conversationId: string,
  contactId: string,
  agentSummary: unknown,
  reason: "handoff" | "closed",
): Promise<{ ok: true; body: string } | { ok: false; code: "db_error" }> {
  const { data: kapso, error: kapsoError } = await db
    .from("integrations")
    .select("config")
    .eq("workspace_id", workspaceId)
    .eq("provider", "kapso")
    .eq("enabled", true)
    .maybeSingle();
  if (kapsoError) return { ok: false, code: "db_error" };
  const agentPhone = nonEmpty((kapso?.config as { phone_number?: unknown } | null)?.phone_number);
  const header = `[Agente de WhatsApp${agentPhone ? ` · ${agentPhone}` : ""}] ${REASON_LABEL[reason]}`;

  let content: string;
  const summary = nonEmpty(agentSummary);
  if (summary) {
    content = `Resumen: ${summary}`;
  } else {
    const { data: contact, error: contactError } = await db
      .from("contacts")
      .select("custom_fields")
      .eq("id", contactId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (contactError) return { ok: false, code: "db_error" };
    const lead = nonEmpty((contact?.custom_fields as { lead_summary?: unknown } | null)?.lead_summary);
    if (lead) {
      content = `Resumen del lead: ${lead}`;
    } else {
      const { data: msgs, error: msgsError } = await db
        .from("messages")
        .select("direction, body, created_at")
        .eq("conversation_id", conversationId)
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: false })
        .limit(TRANSCRIPT_MESSAGES);
      if (msgsError) return { ok: false, code: "db_error" };
      const lines = ((msgs as Array<{ direction: string; body: string | null }> | null) ?? [])
        .reverse()
        .filter((m) => m.body)
        .map((m) => `${m.direction === "in" ? "Cliente" : "Agente"}: ${m.body}`);
      content = lines.length > 0 ? `Últimos mensajes:\n${lines.join("\n")}` : "(Sin mensajes.)";
    }
  }
  return { ok: true, body: sliceCodePoints(`${header}\n\n${content}`, MAX_BODY_CHARS) };
}

/**
 * Registra en el timeline del contacto una comunicación WHATS_APP con el resumen. Lo llama
 * SOLO el procesador de la cola (hubspot-log-queue.ts), dentro de un hsDeadline; nunca la
 * transición. Devuelve el código del fallo para decidir reintento. Nunca lanza.
 */
export async function logHubSpotConversation(
  workspaceId: string,
  conversationId: string,
  reason: "handoff" | "closed",
): Promise<Outcome> {
  const cfgResult = await readHubSpotConfig(workspaceId);
  if (!cfgResult.ok) {
    if (cfgResult.code === "not_configured") return { ok: false, code: "not_configured" };
    if (cfgResult.code === "decrypt_failed") return { ok: false, code: "config_decrypt_failed" };
    return { ok: false, code: "db_error" };
  }
  const cfg = cfgResult.config;

  const db = svc();
  const { data: conv, error } = await db
    .from("conversations")
    .select("contact_id, summary")
    .eq("id", conversationId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) return { ok: false, code: "db_error" };
  if (!conv) return { ok: false, code: "conversation_not_found" };
  const contactId = conv.contact_id as string;

  const linked = await pushContactToHubSpot(workspaceId, contactId, {}, cfg);
  if (!linked.ok) return linked;

  const bodyResult = await buildConversationBody(db, workspaceId, conversationId, contactId, conv.summary, reason);
  if (!bodyResult.ok) return bodyResult;

  // El POST de la comunicación NO es idempotente: con el timeout recortado por el deadline,
  // HubSpot puede confirmarlo, el cliente abortar y la cola repetirlo. Si no queda un timeout
  // completo, no se manda: `deadline` es reintentable y no duplica. El mínimo lo chequea hsFetch
  // antes de CADA intento, también el reintento del 429.
  const res = await hsFetch(cfg.token, `/crm/objects/${V}/communications`, {
    minRemainingMs: HS_TIMEOUT_MS,
    method: "POST",
    body: {
      properties: {
        hs_communication_channel_type: "WHATS_APP",
        hs_communication_logged_from: "CRM",
        hs_communication_body: bodyResult.body,
        hs_timestamp: new Date().toISOString(),
      },
      associations: [
        { to: { id: linked.hs_id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: COMMUNICATION_TO_CONTACT }] },
      ],
    },
  });
  return res.ok ? { ok: true } : { ok: false, code: res.code };
}
