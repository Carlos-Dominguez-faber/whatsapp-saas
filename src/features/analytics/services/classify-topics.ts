import { createClient as createSbClient, type SupabaseClient } from "@supabase/supabase-js";
import { isBodyTruncated, MAX_PROMPT_MESSAGES, type PromptMessage, type PromptTopic } from "../lib/classify-prompt";
import {
  classificationTokenCeiling,
  classifyConversation,
  CLASSIFY_MODEL,
  type KeyScope,
  type LlmUsage,
} from "./classifier";
import { resolveOpenRouterKey, type OpenRouterKeyResolution } from "@/features/inbox/services/openrouter-key";

/*
 * ════════════════════════════════════════════════════════════════════════════
 * THE FAILURE AND TURN MODEL of topic classification. Every call ends in
 * exactly one of these classes; each class has one owner and one response.
 *
 * 1. KEY — 401, 402, 403 (not moderation), 429, or an own key that can't be
 *    decrypted, or an empty platform key. Owner: the KEY the call ran on
 *    (classifyConversation says which). Response: that key is dead for the
 *    rest of the run: with a workspace's own key, only that workspace is
 *    skipped; with the platform key, every workspace without its own. No
 *    attempt spent, no backoff (the next run tries the key once again, at no
 *    cost: a refused request bills nothing). NEVER counts toward the breaker.
 *    The dashboard is told (note_classification_blocked 'key').
 * 2. TRANSIENT — 5xx, 408, 409, 404, the network, a timeout. Owner: nobody in
 *    particular. Response: THIS conversation waits TRANSIENT_BACKOFF_SECONDS
 *    (1 h, defer_classification), doubling each time it fails that way again
 *    (2 h, 4 h … up to 24 h; back to 1 h once it is read), no attempt spent,
 *    and the run goes on with the next one — its workspace is not skipped. The
 *    doubling matters: a timeout keeps its estimate reserved (the usage is
 *    unknown), and a conversation that always times out, tried every hour,
 *    would use up its workspace's daily cap by itself.
 * 3. CONTENT — 400, 413, 422, a moderation 403, output that doesn't parse, a
 *    save the database rejects as data. Owner: the conversation. Response: an
 *    attempt, a backoff of 1 h per attempt, quarantine at the third.
 * 4. BUDGET — the reservation doesn't fit the workspace's daily cap. Owner:
 *    the workspace. Response: skipped for the rest of the run; the dashboard
 *    is told (note_classification_blocked 'cap').
 * 5. INFRA — our database: the reservation, the key lookup, a save or a
 *    bookkeeping write fails. Response: the run stops (halt). A paid result
 *    that can't be saved would be paid again by the next conversation.
 *
 * CIRCUIT BREAKER: TRANSIENT_BREAKER (3) transient failures in a row, on
 * different conversations, stop the run: that is the provider, not three bad
 * conversations. Any answer from the provider (a result, a content or a key
 * rejection) resets the count.
 *
 * SETTLEMENT of the reservation made before every call:
 *   result with usage ............................ the real count
 *   result or invalid output without usage ....... the estimate stays (a ceiling)
 *   any HTTP error answer (4xx, 5xx) ............. 0 (nothing was generated)
 *   timeout / network (no answer) ................ the estimate stays
 *   no call made (dead key, no time, no inbound) . no reservation at all
 * The estimate is always a ceiling, so a crash between reservation and
 * settlement overcounts the day, never undercounts it.
 *
 * TURNS. A run (route.ts) gives the backfill of new topics the first
 * BACKFILL_SHARE_MS and the nightly phase the rest, including whatever the
 * backfill didn't use: a backfill with nothing it can do (no topic pending,
 * over the cap, a dead key) returns at once. Inside each phase the order is
 * the database's (select_conversations_to_classify): workspaces take turns;
 * inside each, customers of the last 48 h oldest first, then the rest newest
 * first. Guards (dead keys, workspaces over the cap, the breaker) are shared
 * by both phases of a run.
 * ════════════════════════════════════════════════════════════════════════════
 */

/**
 * La clasificación se detiene con 300k tokens del día UTC. Tope DURO: ninguna
 * llamada sale sin una reserva de su techo (`reserve_classification_tokens`),
 * y la reserva se niega si consumo del día + techo > tope. It is its own
 * budget: the sum counts classification spend only (event type
 * 'topic_classification'), and the bot's daily budget does not count it, so
 * neither can starve the other.
 */
export const CLASSIFY_DAILY_TOKEN_CAP = 300_000;

/** Transient failures in a row, on different conversations, that stop a run. */
export const TRANSIENT_BREAKER = 3;
/** How long a conversation waits after a transient failure (no attempt spent). */
export const TRANSIENT_BACKOFF_SECONDS = 3600;

/**
 * Cuántas conversaciones se RECLAMAN por vuelta (con lease). Las llamadas
 * al LLM sobre ese lote van en SECUENCIA; el tope lo garantiza la reserva, no
 * el orden.
 */
const BATCH_SIZE = 5;
const MIN_REMAINING_MS = 15_000;
const LLM_TIMEOUT_MS = 20_000;
/** Techo por consulta a la base; además nunca excede lo que queda de deadline. */
const DB_TIMEOUT_MS = 5_000;
/**
 * Escrituras que van DESPUÉS del LLM. El
 * presupuesto del LLM reserva DB_TIMEOUT_MS para cada una, así que si el LLM
 * responde a tiempo todas tienen su techo completo.
 * - Fase 1: liquidación del consumo + save_conversation_topics.
 * - Fase 2: las mismas + advance_topic_backfill. Con dos, un LLM y dos
 *   escrituras lentas dejarían al avance sin tiempo: el resultado quedaría
 *   guardado, el cursor no se movería y la corrida siguiente volvería a pagarlo.
 * La reserva de tokens va ANTES del LLM y se cuenta aparte (ver classifyOne).
 */
const POST_LLM_WRITES_CLASSIFY = 2;
const POST_LLM_WRITES_BACKFILL = 3;
/**
 * Lease de las DOS fases: conversación y tema de reprocesamiento.
 * Invariante: RUN_BUDGET_MS (100 s, route.ts) < maxDuration (120 s) < LEASE_SECONDS.
 * Una corrida nunca sobrevive a su propio lease; por eso los leases no llevan
 * token de propiedad. Subir RUN_BUDGET_MS o maxDuration por encima de esto
 * rompe la exclusión.
 */
export const LEASE_SECONDS = 180;

/**
 * The backfill's share of a run, taken first: its floor per call (40 s) plus
 * room for a handful of calls. What it doesn't use goes to the nightly phase.
 */
export const BACKFILL_SHARE_MS = 55_000;

export interface ClassificationPhaseResult {
  classified: number;
  /** Content failures: an attempt spent. */
  failed: number;
  /** Transient failures: the conversation waits an hour, no attempt spent. */
  deferred: number;
  /** Workspaces over their daily cap, skipped for the rest of the run. */
  skipped_workspaces: number;
  /** Workspaces skipped for the rest of the run because their key failed. */
  unavailable_workspaces: number;
  /**
   * true = the run stops: the breaker tripped, or our database failed. The
   * route doesn't run the other phase.
   */
  halt: boolean;
  error?: string;
}

export interface BackfillPhaseResult {
  processed: number;
  failed: number;
  deferred: number;
  topics_done: number;
  /** Lote vacío porque la ventana de 30 días se venció, no por terminar. */
  topics_expired: number;
  skipped_workspaces: number;
  unavailable_workspaces: number;
  halt: boolean;
  error?: string;
}

interface ConversationRow {
  conversation_id: string;
  workspace_id: string;
  contact_id: string;
  /**
   * The customer's newest message when the row was picked. The run covers the
   * customer's messages up to here (classified_until, the backfill cursor).
   */
  last_inbound_at: string;
}

/** What a run knows about keys, caps and the provider; shared by both phases. */
export interface RunGuards {
  /** Each workspace's key, resolved once per run. */
  keys: Map<string, OpenRouterKeyResolution>;
  /** Keys that failed this run: "platform", or "own:<workspace id>". */
  deadKeys: Set<string>;
  /** Workspaces out of the rest of the run: a dead key, or over the cap. */
  skipped: Set<string>;
  /** Conversations with a transient failure since the provider last answered. */
  transientStreak: Set<string>;
}

export function newRunGuards(): RunGuards {
  return { keys: new Map(), deadKeys: new Set(), skipped: new Set(), transientStreak: new Set() };
}

const keyId = (workspaceId: string, scope: KeyScope) => (scope === "platform" ? "platform" : `own:${workspaceId}`);

/** The outcome of one conversation, in the model's classes. */
type Outcome =
  | { kind: "ok" }
  | { kind: "no_time" }
  | { kind: "budget" }
  /** No call made: the workspace's key is dead this run (or unusable). */
  | { kind: "key"; scope: KeyScope; called: boolean }
  | { kind: "transient"; code: string }
  | { kind: "content"; code: string }
  | { kind: "infra"; code: string };

function svc(): SupabaseClient {
  return createSbClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

const remainingMs = (deadline: number) => deadline - Date.now();
const hasTime = (deadline: number) => remainingMs(deadline) > MIN_REMAINING_MS;

/**
 * Toda espera a la base lleva el deadline común. Si solo el LLM lo
 * mirara, una selección lenta podría devolver pasado el minuto de Vercel con
 * la corrida ya muerta a mitad de la contabilización.
 */
function dbSignal(deadline: number): AbortSignal {
  return AbortSignal.timeout(Math.max(0, Math.min(DB_TIMEOUT_MS, remainingMs(deadline))));
}

type DbError = { code?: string | null };

/**
 * ¿La base rechazó los DATOS de esta conversación? postgrest-js 2.108
 * no lanza: un abort, un timeout o una caída de red vuelven como `{error}` con
 * `code: ""` (dist/index.cjs, `res.catch`), y una respuesta de PostgREST trae
 * en `code` el SQLSTATE (o un `PGRST…`). Solo las clases 22 (dato inválido),
 * 23 (integridad) y P0 (RAISE de la RPC, p. ej. conversation_not_in_workspace)
 * son culpa de la fila. Todo lo demás —código vacío, PGRST*, 08, 40, 42501,
 * 53, 57014, XX— es infraestructura o configuración. Lista blanca a
 * propósito: un código desconocido corta la fase (500 visible) en vez de
 * mandar a cuarentena conversaciones sanas.
 */
const isDataRejection = (error: DbError) => /^(22|23|P0)/.test(error.code ?? "");

/**
 * La consulta se cortó porque venció el deadline común, no
 * porque algo esté roto. Solo un error sin SQLSTATE (abort/red) con el
 * deadline ya pasado; eso es "sin tiempo", no un fallo.
 */
const isDeadlineAbort = (error: DbError, deadline: number) => !error.code && remainingMs(deadline) <= 0;

/** Tells the dashboard why a workspace isn't being analysed. Best effort. */
async function noteBlocked(db: SupabaseClient, workspaceId: string, reason: "key" | "cap", deadline: number) {
  const { error } = await db
    .rpc("note_classification_blocked", { p_workspace_id: workspaceId, p_reason: reason })
    .abortSignal(dbSignal(deadline));
  if (error) console.error("[classify-topics] could not note a blocked workspace", error.code);
}

/**
 * The key the workspace's calls run on this run: resolved once, and dead
 * when it already failed (its own, or the platform's for everyone on it).
 */
async function keyFor(
  db: SupabaseClient,
  guards: RunGuards,
  workspaceId: string,
): Promise<OpenRouterKeyResolution> {
  let resolution = guards.keys.get(workspaceId);
  if (!resolution) {
    resolution = await resolveOpenRouterKey(workspaceId, db);
    guards.keys.set(workspaceId, resolution);
  }
  return resolution;
}

/**
 * Reserva el techo de la llamada ANTES de hacerla.
 * La RPC suma el consumo del día y, si cabe, inserta la fila con la
 * estimación, todo bajo un lock por workspace (mismo patrón que
 * reserve_llm_turn). Devuelve el id de la reserva, `null` si no cabe bajo el
 * tope, o "failed". "No pude reservar" ≠ "sin saldo".
 */
async function reserveTokens(
  db: SupabaseClient,
  row: ConversationRow,
  estimate: number,
  deadline: number,
): Promise<{ id: string | null } | "failed"> {
  const { data, error } = await db
    .rpc("reserve_classification_tokens", {
      p_workspace_id: row.workspace_id,
      p_conversation_id: row.conversation_id,
      p_estimate: estimate,
      p_cap: CLASSIFY_DAILY_TOKEN_CAP,
    })
    .abortSignal(dbSignal(deadline));
  if (error) {
    console.error("[classify-topics] token reservation failed", error.code);
    return "failed";
  }
  return { id: typeof data === "string" ? data : null };
}

/**
 * Liquida la reserva (ver SETTLEMENT en la cabecera). Si falla, la fila
 * conserva la estimación, que es un techo: el día queda SOBREcontado, nunca
 * subcontado. Por eso NO corta la fase; se deja en el log.
 */
async function settleTokens(
  db: SupabaseClient,
  row: ConversationRow,
  reservationId: string,
  estimate: number,
  usage: LlmUsage,
  deadline: number,
): Promise<void> {
  const total = usage.promptTokens + usage.completionTokens;
  // Alarma: la estimación dejó de ser un techo. Se registra lo real igual.
  if (total > estimate) console.error("[classify-topics] usage above reservation", total, estimate);
  const { error } = await db
    .rpc("settle_classification_tokens", {
      p_reservation_id: reservationId,
      p_workspace_id: row.workspace_id,
      p_model: CLASSIFY_MODEL,
      p_prompt_tokens: usage.promptTokens,
      p_completion_tokens: usage.completionTokens,
    })
    .abortSignal(dbSignal(deadline));
  if (error) console.error("[classify-topics] token settlement failed", error.code);
}

/** Lanza ante error: el caller lo trata como infraestructura. */
async function loadTopics(
  db: SupabaseClient,
  workspaceId: string,
  deadline: number,
): Promise<PromptTopic[]> {
  const { data, error } = await db
    .from("insight_topics")
    .select("id, name, description")
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .order("created_at")
    .limit(10)
    .abortSignal(dbSignal(deadline));
  if (error) throw new Error("load_topics_failed");
  return (data ?? []) as PromptTopic[];
}

/**
 * The last MAX_PROMPT_MESSAGES messages up to the customer's newest one. Ending
 * there keeps what made the conversation eligible inside the prompt however
 * many replies or reminders came after it, and anything the customer writes
 * after the pick waits for the next run (classified_until stops at the pick).
 * The team's internal notes and sends that never went out are left out in the
 * query, before the limit, as the bot's own history does
 * (conversation-history.ts): notes are never sent to an LLM.
 */
async function loadMessages(
  db: SupabaseClient,
  row: ConversationRow,
  deadline: number,
): Promise<PromptMessage[]> {
  const { data, error } = await db
    .from("messages")
    .select("id, direction, sender_user_id, body, created_at")
    .eq("conversation_id", row.conversation_id)
    .eq("workspace_id", row.workspace_id)
    .lte("created_at", row.last_inbound_at)
    .not("meta", "cs", JSON.stringify({ internal: true }))
    .or("status.is.null,status.neq.failed")
    .order("created_at", { ascending: false })
    .limit(MAX_PROMPT_MESSAGES)
    .abortSignal(dbSignal(deadline));
  if (error) throw new Error("load_messages_failed");
  return ((data ?? []) as PromptMessage[]).reverse();
}

/**
 * One conversation, start to end, in the model's classes. `backfillTopic`:
 * the topic a backfill reads it for (null for the nightly phase).
 */
async function classifyOne(
  db: SupabaseClient,
  guards: RunGuards,
  row: ConversationRow,
  topics: PromptTopic[],
  deadline: number,
  backfillTopic: string | null,
): Promise<Outcome> {
  const postLlmWrites = backfillTopic ? POST_LLM_WRITES_BACKFILL : POST_LLM_WRITES_CLASSIFY;
  let messages: PromptMessage[];
  try {
    messages = await loadMessages(db, row, deadline);
  } catch {
    return { kind: "infra", code: "load_messages_failed" };
  }

  try {
    let matches: Array<{ topic_id: string; message_id: string }> = [];

    // Only the customer's messages can carry a topic: with none in view there
    // is nothing to ask the LLM, and the row is saved as analysed.
    if (messages.some((m) => m.direction === "in")) {
      // Piso de LLM COMPLETO antes de reservar: la reserva, los 20 s enteros
      // del LLM y el techo de cada escritura posterior. Toda llamada que sale
      // tiene su presupuesto completo, y un corte siempre es el proveedor
      // lento. Fase 1: 5 + 20 + 2×5 = 35 s; fase 2: 40 s.
      if (remainingMs(deadline) < DB_TIMEOUT_MS + LLM_TIMEOUT_MS + postLlmWrites * DB_TIMEOUT_MS) {
        return { kind: "no_time" };
      }

      // KEY: resolved once per workspace and run. A key already dead, an own
      // key that can't be decrypted or an empty platform key: no call.
      let key: OpenRouterKeyResolution;
      try {
        key = await keyFor(db, guards, row.workspace_id);
      } catch {
        return { kind: "infra", code: "key_lookup_failed" };
      }
      if (key.scope === null) return { kind: "infra", code: "key_lookup_failed" };
      if (guards.deadKeys.has(keyId(row.workspace_id, key.scope))) {
        return { kind: "key", scope: key.scope, called: false };
      }
      if (!key.key) return { kind: "key", scope: key.scope, called: false };

      // Sin reserva no hay llamada.
      const estimate = classificationTokenCeiling(topics, messages);
      const reservation = await reserveTokens(db, row, estimate, deadline);
      if (reservation === "failed") return { kind: "infra", code: "budget_reserve_failed" };
      if (reservation.id === null) return { kind: "budget" };

      const result = await classifyConversation({
        workspaceId: row.workspace_id,
        topics,
        messages,
        abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
        key: { scope: key.scope, key: key.key },
      });
      // SETTLEMENT: a known count (0 included) settles; unknown keeps the estimate.
      if (result.usage) await settleTokens(db, row, reservation.id, estimate, result.usage, deadline);
      if (!result.ok) {
        switch (result.code) {
          case "key_rejected":
            return { kind: "key", scope: result.keyScope, called: true };
          case "provider_unavailable":
          case "timeout":
            return { kind: "transient", code: result.code };
          default:
            return { kind: "content", code: result.code };
        }
      }
      matches = result.matches;
    }

    const { error } = await db
      .rpc("save_conversation_topics", {
        p_workspace_id: row.workspace_id,
        p_conversation_id: row.conversation_id,
        p_matches: matches,
        p_classified_until: backfillTopic ? null : row.last_inbound_at,
        // Cobertura parcial declarada. La RPC decide qué quedó fuera
        // (mensajes anteriores al más viejo que vio el LLM y aún no analizados)
        // y lo suma a los recortados. loadMessages ya trae los últimos 60 en
        // orden: son exactamente los que entran al prompt.
        p_window_from: messages[0]?.created_at ?? null,
        p_truncated_at: messages
          .filter((m) => m.direction === "in" && isBodyTruncated(m))
          .map((m) => m.created_at),
        // The nightly phase records which catalog it read the conversation
        // with; a backfill, the topic it read it for.
        ...(backfillTopic ? { p_backfill_topic: backfillTopic } : { p_catalog: topics.map((t) => t.id) }),
      })
      .abortSignal(dbSignal(deadline));
    if (!error) return { kind: "ok" };
    if (isDeadlineAbort(error, deadline)) return { kind: "no_time" };
    if (isDataRejection(error)) return { kind: "content", code: "save_failed" };
    console.error("[classify-topics] save_conversation_topics failed", error.code);
    return { kind: "infra", code: "save_infra_failed" };
  } catch {
    return { kind: "content", code: "unexpected" };
  }
}

/**
 * The response to a KEY outcome: the key is dead for the rest of the run
 * (its workspace, or every workspace on the platform key), and the dashboard
 * is told. Never a halt.
 */
async function killKey(
  db: SupabaseClient,
  guards: RunGuards,
  workspaceId: string,
  scope: KeyScope,
  deadline: number,
): Promise<void> {
  const id = keyId(workspaceId, scope);
  if (!guards.deadKeys.has(id)) {
    console.error("[classify-topics] OpenRouter key failed; skipped for this run", scope === "platform" ? "platform" : workspaceId);
  }
  guards.deadKeys.add(id);
  guards.skipped.add(workspaceId);
  guards.transientStreak.clear();
  await noteBlocked(db, workspaceId, "key", deadline);
}

/** TRANSIENT: true when the breaker trips (the run must stop). */
function transientTrips(guards: RunGuards, conversationId: string): boolean {
  guards.transientStreak.add(conversationId);
  return guards.transientStreak.size >= TRANSIENT_BREAKER;
}

export async function runClassificationPhase(
  deadline: number,
  db: SupabaseClient = svc(),
  guards: RunGuards = newRunGuards(),
): Promise<ClassificationPhaseResult> {
  const result: ClassificationPhaseResult = {
    classified: 0, failed: 0, deferred: 0, skipped_workspaces: 0, unavailable_workspaces: 0, halt: false,
  };
  const topicsByWorkspace = new Map<string, PromptTopic[]>();

  while (hasTime(deadline)) {
    const { data, error } = await db
      .rpc("select_conversations_to_classify", {
        p_limit: BATCH_SIZE,
        p_skip_workspaces: [...guards.skipped],
        p_lease_seconds: LEASE_SECONDS,
      })
      .abortSignal(dbSignal(deadline));
    if (error) return { ...result, error: "select_failed" };
    const rows = (data ?? []) as ConversationRow[];
    if (rows.length === 0) break;

    // SECUENCIAL. Lo que quede del lote sin procesar sigue reclamado hasta
    // que vence el lease (LEASE_SECONDS) y lo retoma la corrida siguiente.
    for (const row of rows) {
      if (!hasTime(deadline)) return result;
      if (guards.skipped.has(row.workspace_id)) continue;

      let topics = topicsByWorkspace.get(row.workspace_id);
      if (!topics) {
        try {
          topics = await loadTopics(db, row.workspace_id, deadline);
        } catch {
          return { ...result, error: "load_topics_failed", halt: true };
        }
        topicsByWorkspace.set(row.workspace_id, topics);
      }
      const outcome = await classifyOne(db, guards, row, topics, deadline, null);

      switch (outcome.kind) {
        case "ok":
          result.classified++;
          guards.transientStreak.clear();
          break;
        case "no_time":
          return result;
        case "budget":
          guards.skipped.add(row.workspace_id);
          result.skipped_workspaces++;
          await noteBlocked(db, row.workspace_id, "cap", deadline);
          break;
        case "key":
          await killKey(db, guards, row.workspace_id, outcome.scope, deadline);
          result.unavailable_workspaces++;
          break;
        case "transient": {
          const { error: deferErr } = await db
            .rpc("defer_classification", {
              p_workspace_id: row.workspace_id,
              p_conversation_id: row.conversation_id,
              p_code: outcome.code,
              p_seconds: TRANSIENT_BACKOFF_SECONDS,
            })
            .abortSignal(dbSignal(deadline));
          if (deferErr) {
            if (isDeadlineAbort(deferErr, deadline)) return result;
            return { ...result, error: "defer_failed", halt: true };
          }
          result.deferred++;
          if (transientTrips(guards, row.conversation_id)) {
            return { ...result, error: outcome.code, halt: true };
          }
          break;
        }
        case "content": {
          guards.transientStreak.clear();
          result.failed++;
          const { error: failErr } = await db
            .rpc("record_classification_failure", {
              p_workspace_id: row.workspace_id,
              p_conversation_id: row.conversation_id,
              p_code: outcome.code,
            })
            .abortSignal(dbSignal(deadline));
          if (failErr) {
            // Cortado por el deadline = sin tiempo; el intento no se contó.
            if (isDeadlineAbort(failErr, deadline)) return result;
            return { ...result, error: "record_failure_failed", halt: true };
          }
          break;
        }
        case "infra":
          return { ...result, error: outcome.code, halt: true };
      }
    }
  }

  return result;
}

export async function runBackfillPhase(
  deadline: number,
  db: SupabaseClient = svc(),
  guards: RunGuards = newRunGuards(),
): Promise<BackfillPhaseResult> {
  const result: BackfillPhaseResult = {
    processed: 0, failed: 0, deferred: 0, topics_done: 0, topics_expired: 0,
    skipped_workspaces: 0, unavailable_workspaces: 0, halt: false,
  };
  const TOPIC_PAGE = 20;
  let offset = 0;
  // Una escritura cortada por el deadline es "sin tiempo", no un 500.
  // El cursor que no avanzó solo repite trabajo idempotente la próxima corrida.
  const stopped = (err: DbError, code: string): BackfillPhaseResult =>
    isDeadlineAbort(err, deadline) ? result : { ...result, error: code, halt: true };

  // Se PAGINA: los temas de workspaces sin saldo o con la clave caída se
  // saltan sin cortar el recorrido, así el de otro workspace no espera.
  while (hasTime(deadline)) {
    const { data: topics, error } = await db
      .from("insight_topics")
      .select("id, workspace_id, name, description")
      .eq("status", "active")
      .eq("backfill_status", "pending")
      .order("created_at")
      .range(offset, offset + TOPIC_PAGE - 1)
      .abortSignal(dbSignal(deadline));
    if (error) return { ...result, error: "backfill_topics_failed", halt: true };
    const page = (topics ?? []) as Array<PromptTopic & { workspace_id: string }>;
    if (page.length === 0) break;
    offset += page.length;

    for (const topic of page) {
      if (!hasTime(deadline)) return result;
      if (guards.skipped.has(topic.workspace_id)) continue;

      // Lease por tema (ver LEASE_SECONDS). Si otra corrida lo tiene,
      // se salta sin cortar la paginación.
      const { data: claimed, error: claimErr } = await db
        .rpc("claim_topic_backfill", { p_topic_id: topic.id, p_lease_seconds: LEASE_SECONDS })
        .abortSignal(dbSignal(deadline));
      if (claimErr) return { ...result, error: "backfill_claim_failed", halt: true };
      if (claimed !== true) continue;

      // Reprocesamiento: solo ese tema, para no redetectar los viejos.
      const prompt: PromptTopic[] = [{ id: topic.id, name: topic.name, description: topic.description }];

      topicLoop: while (hasTime(deadline)) {
        const { data, error: batchErr } = await db
          .rpc("next_backfill_batch", { p_topic_id: topic.id, p_limit: BATCH_SIZE })
          .abortSignal(dbSignal(deadline));
        if (batchErr) return { ...result, error: "backfill_batch_failed", halt: true };
        const batch = (data ?? []) as ConversationRow[];

        if (batch.length === 0) {
          // Lote vacío = terminado O ventana vencida. Lo decide la RPC.
          const { data: status, error: doneErr } = await db
            .rpc("advance_topic_backfill", {
              p_topic_id: topic.id,
              p_cursor_at: null,
              p_cursor_id: null,
              p_done: true,
            })
            .abortSignal(dbSignal(deadline));
          if (doneErr) return stopped(doneErr, "backfill_advance_failed");
          if (status === "expired") result.topics_expired++;
          else result.topics_done++;
          break;
        }

        // In cursor order: the cursor only moves past consecutive successes.
        let done = 0;
        let stop: Outcome | null = null;
        for (const row of batch) {
          if (!hasTime(deadline)) {
            stop = { kind: "no_time" };
            break;
          }
          const outcome = await classifyOne(db, guards, row, prompt, deadline, topic.id);
          if (outcome.kind === "ok") {
            done++;
            guards.transientStreak.clear();
            continue;
          }
          stop = outcome;
          break;
        }
        result.processed += done;

        // Avanzar primero hasta el último éxito consecutivo: advance resetea
        // backfill_attempts, así que va antes de registrar un fallo.
        if (done > 0) {
          const last = batch[done - 1];
          const { error: advErr } = await db
            .rpc("advance_topic_backfill", {
              p_topic_id: topic.id,
              p_cursor_at: last.last_inbound_at,
              p_cursor_id: last.conversation_id,
              p_done: false,
            })
            .abortSignal(dbSignal(deadline));
          if (advErr) return stopped(advErr, "backfill_advance_failed");
        }

        if (!stop) continue;
        switch (stop.kind) {
          case "no_time":
            return result;
          case "infra":
            return { ...result, error: stop.code, halt: true };
          case "budget":
            guards.skipped.add(topic.workspace_id);
            result.skipped_workspaces++;
            await noteBlocked(db, topic.workspace_id, "cap", deadline);
            break topicLoop;
          case "key":
            await killKey(db, guards, topic.workspace_id, stop.scope, deadline);
            result.unavailable_workspaces++;
            break topicLoop;
          case "transient":
          case "content": {
            // A cursor can't step around one conversation, so both count on
            // the topic: three failures at the same spot and it is skipped (a
            // conversation that always times out can't block a backfill).
            if (stop.kind === "transient") {
              result.deferred++;
              if (transientTrips(guards, batch[done].conversation_id)) {
                return { ...result, error: stop.code, halt: true };
              }
            } else {
              guards.transientStreak.clear();
              result.failed++;
            }
            const { data: attempts, error: recErr } = await db
              .rpc("record_backfill_failure", { p_topic_id: topic.id })
              .abortSignal(dbSignal(deadline));
            if (recErr) return stopped(recErr, "record_failure_failed");
            if (Number(attempts ?? 0) < 3) break topicLoop; // se reintenta en la próxima corrida

            const failedRow = batch[done];
            const { error: skipErr } = await db
              .rpc("advance_topic_backfill", {
                p_topic_id: topic.id,
                p_cursor_at: failedRow.last_inbound_at,
                p_cursor_id: failedRow.conversation_id,
                p_done: false,
              })
              .abortSignal(dbSignal(deadline));
            if (skipErr) return stopped(skipErr, "backfill_advance_failed");
            break;
          }
        }
      }

      // Terminado con el tema: se suelta el lease (el cierre done/expired ya lo
      // soltó en su UPDATE). Los `return` de arriba dejan que venza solo.
      const { error: relErr } = await db
        .rpc("release_topic_backfill", { p_topic_id: topic.id })
        .abortSignal(dbSignal(deadline));
      if (relErr) console.error("[classify-topics] backfill lease release failed", relErr.code);
    }
  }

  return result;
}
