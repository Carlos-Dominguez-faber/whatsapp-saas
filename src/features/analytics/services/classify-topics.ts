import { createClient as createSbClient, type SupabaseClient } from "@supabase/supabase-js";
import { isBodyTruncated, MAX_PROMPT_MESSAGES, type PromptMessage, type PromptTopic } from "../lib/classify-prompt";
import {
  classificationTokenCeiling,
  classifyConversation,
  CLASSIFY_MODEL,
  type KeyScope,
  type LlmUsage,
} from "./classifier";
import { openRouterKeyId, resolveOpenRouterKey } from "@/features/inbox/services/openrouter-key";

/*
 * ════════════════════════════════════════════════════════════════════════════
 * THE FAILURE AND TURN MODEL of topic classification.
 *
 * Every call ends in exactly one class. Each class has ONE owner, and a
 * failure only moves its owner's state:
 *
 * KEY — 401, 402, 403 (not moderation), 404 (OpenRouter: no endpoint for the
 *   key's data policy), 429, any other 4xx; an own key that can't be
 *   decrypted; no platform key. Owner: the KEY. It goes down at once for
 *   KEY_REJECTED_SECONDS (15 min, flat: a refused request bills nothing, so
 *   testing it again is cheap; a longer wait it is already in stays). No
 *   attempt spent.
 * TRANSIENT — 5xx, 408, 409, 425, the network, a timeout; a 200 that carries
 *   the provider's error (or finish_reason "error") with one of those codes.
 *   Owners: the workspace's LANE on its key (one more in its streak; the
 *   KEY_TRANSIENT_BREAKER-th in a row takes it down: 15 min, doubling each
 *   down in a row up to 6 h), the KEY (the same, except that a key several
 *   workspaces share only goes down when its streak comes from at least two
 *   of them: one tenant can't take the others down), and the CONVERSATION
 *   (it waits TRANSIENT_BACKOFF_SECONDS, doubling each time it fails that way
 *   again up to a day; no attempt spent). The run goes on with the next one.
 * CONTENT — 400, 413, 422, a moderation 403, a 200 that can't be read and
 *   carries no error, output that doesn't parse, a save the database rejects
 *   as data. Owner: the CONVERSATION: an attempt, 1 h per attempt,
 *   quarantine at the third.
 * BUDGET — the reservation doesn't fit the workspace's daily cap. Owner: the
 *   WORKSPACE: skipped for the rest of the run (note_classification_blocked
 *   'cap' tells the dashboard).
 * INFRA — our database fails. The run stops (halt). THE ONLY HALT: nothing a
 *   key, a conversation or the provider does stops the run.
 *
 * STATE, where it lives and what resets it:
 * - The key and each workspace's lane on it: classification_key_health, one
 *   row per circuit, across runs. The key's id is a hash of the key (never
 *   the key), so every workspace on the platform key — or one key pasted into
 *   two workspaces — shares it; a lane is 'lane:<workspace>:<key id>'.
 *     up    calls go; transient_failures counts transients in a row (and, on
 *           a key, streak_workspaces who they came from).
 *     down  down_since set: no call on it, in this run or the next, before
 *           down_until. A key down skips all its workspaces; a lane down,
 *           only its own.
 *     probe down_until passed: classification_key_gate hands ONE caller the
 *           call that tests it (the others still see it down). Answered: up,
 *           all reset. Transient: down again, twice as long. Refused: down
 *           15 min.
 *   Reset: any answer from the provider ON THIS KEY for that workspace — a
 *   result, invalid output, a refusal of the text — resets the key and the
 *   lane (written after every answer; the RPC only touches a row with
 *   something to reset). Answers on other keys never touch them, and a
 *   workspace skipped without a call touches nothing.
 *   The run reads them once per workspace and run (the gate, which also
 *   records which key the workspace runs on) and keeps what it learns in
 *   RunGuards; the dashboard reads them too (get_insights 'blocked': 'key'
 *   for an own key, 'platform_key' for the platform's, 'workspace' for a
 *   lane).
 * - The conversation: conversation_classification — claimed_until (its lease
 *   and every wait), attempts and quarantined_at (content), transient_failures
 *   (its transient waits). Reset when it is read.
 * - The run: RunGuards — what it learned of each key and lane, and the
 *   workspaces out of it (a key or lane down, over the cap). Shared by both
 *   phases; gone at the end.
 * A down PLATFORM key skips every workspace on it and the route answers 500,
 * so it shows in net._http_response. Own keys down never make a 500.
 *
 * THE BACKFILL walks a cursor, which can't step around a conversation:
 * - content: counts on the topic (record_backfill_failure); at the third in a
 *   row the cursor steps past that conversation;
 * - transient: never counts on the topic. The conversation waits (its own
 *   doubling), and its topic waits with it, without calls. Only its
 *   BACKFILL_TRANSIENT_SKIP-th transient failure in a row steps past it — a
 *   conversation that always times out can't hold a backfill forever. Each of
 *   those failures happened on a key and lane that were up: in an outage the
 *   lane (or the key) goes down at the third transient, and a probe's failure
 *   is the circuit's, never the conversation's, so an outage can't make it
 *   skip.
 *
 * SETTLEMENT of the reservation made before every call:
 *   result with usage ............................ the real count
 *   result or invalid output without usage ....... the estimate stays (a ceiling)
 *   an answer that isn't an HTTP error ........... the estimate stays
 *   any HTTP error answer (4xx, 5xx) ............. 0 (nothing was generated)
 *   timeout / network (no answer) ................ the estimate stays
 *   no call made (key down, no time, no inbound) . no reservation at all
 * The estimate is always a ceiling, so a crash between reservation and
 * settlement overcounts the day, never undercounts it.
 *
 * TURNS. A run (route.ts) gives the backfill of new topics the first
 * BACKFILL_SHARE_MS and the nightly phase the rest, including whatever the
 * backfill didn't use: a backfill with nothing it can do (no topic pending,
 * over the cap, a key down) returns at once. In both phases workspaces take
 * turns by the one served longest ago in THAT phase (classification_
 * workspace_state.last_served_at and last_backfill_at, stamped by the
 * reservation of each call: a row claimed and then not called — out of time,
 * its key down — is not a turn): every workspace's first conversation (or
 * oldest pending topic) before anyone's second, and among those the longest
 * waiting first. The backfill gives each topic one batch per round. Inside a
 * workspace, the nightly phase reads customers of the last 48 h oldest first,
 * then the rest newest first.
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

/** Transient failures in a row on ONE key that take it down. */
export const KEY_TRANSIENT_BREAKER = 3;
/** A key down from transient failures waits this long; each down in a row doubles it. */
export const KEY_DOWN_BASE_SECONDS = 900;
/** … up to this. */
export const KEY_DOWN_MAX_SECONDS = 21_600;
/** A key the provider refused waits this long, flat. */
export const KEY_REJECTED_SECONDS = 900;
/** A conversation's wait after a transient failure (doubles for each in a row, up to a day). */
export const TRANSIENT_BACKOFF_SECONDS = 3600;
/** A conversation's transient failures in a row after which the backfill steps past it. */
export const BACKFILL_TRANSIENT_SKIP = 3;

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

/** Pending topics the backfill looks at per run, in turn order. */
const BACKFILL_TOPICS = 50;

/**
 * The backfill's share of a run, taken first: its floor per call (40 s) plus
 * room for a handful of calls. What it doesn't use goes to the nightly phase.
 */
export const BACKFILL_SHARE_MS = 55_000;

export interface ClassificationPhaseResult {
  classified: number;
  /** Content failures: an attempt spent. */
  failed: number;
  /** Transient failures: the conversation waits, no attempt spent. */
  deferred: number;
  /** Workspaces over their daily cap, skipped for the rest of the run. */
  skipped_workspaces: number;
  /** Workspaces skipped for the rest of the run because their key is down. */
  unavailable_workspaces: number;
  /** true = our database failed: the run stops. The only halt. */
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
  /** Backfill only: the conversation waits after a transient failure until then. */
  waits_until?: string | null;
}

/** The key a workspace's calls run on this run. */
interface WorkspaceKey {
  /** classification_key_health.key_id: a hash of the key, never the key. */
  keyId: string;
  scope: KeyScope;
  /** null: it can't be used at all (an own key that can't be decrypted, no platform key). */
  key: string | null;
}

/** A circuit's state as the run knows it: the gate's answer, then every outcome on it. */
type CircuitState = "up" | "down" | "probe";
interface KeyView {
  state: CircuitState;
}

/** What a run learned; shared by both phases, gone at its end. */
export interface RunGuards {
  /** Each workspace's key, resolved once per run. */
  workspaces: Map<string, WorkspaceKey>;
  /** Each key's state, from the gate and from the run's own calls. */
  keys: Map<string, KeyView>;
  /** Each workspace's lane on its key (its own calls' circuit), the same way. */
  lanes: Map<string, CircuitState>;
  /** Workspaces out of the rest of the run: their key is down, or over the cap. */
  skipped: Set<string>;
  /** The platform key was down in this run: the route answers 500. */
  platformDown: boolean;
}

export function newRunGuards(): RunGuards {
  return { workspaces: new Map(), keys: new Map(), lanes: new Map(), skipped: new Set(), platformDown: false };
}


/** The outcome of one conversation, in the model's classes. */
type Outcome =
  | { kind: "ok" }
  | { kind: "no_time" }
  | { kind: "budget" }
  /** The workspace's key is down (it just went, or it already was): skip the workspace. */
  | { kind: "key" }
  /** `probe`: the call was the one that tested a key that was down. */
  | { kind: "transient"; code: string; probe: boolean }
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

/** Tells the dashboard a workspace reached its daily cap. Best effort. */
async function noteOverCap(db: SupabaseClient, workspaceId: string, deadline: number) {
  const { error } = await db
    .rpc("note_classification_blocked", { p_workspace_id: workspaceId, p_reason: "cap" })
    .abortSignal(dbSignal(deadline));
  if (error) console.error("[classify-topics] could not note a workspace over its cap", error.code);
}

type Stop = Extract<Outcome, { kind: "no_time" } | { kind: "infra" }>;
const dbStop = (error: DbError, deadline: number, code: string): Stop =>
  isDeadlineAbort(error, deadline) ? { kind: "no_time" } : { kind: "infra", code };

/** What the run learns of a key; a platform key down makes the route's 500. */
function learnKey(guards: RunGuards, wk: WorkspaceKey, view: KeyView) {
  guards.keys.set(wk.keyId, view);
  if (view.state === "down" && wk.scope === "platform") guards.platformDown = true;
}

/**
 * Records what a call of `workspaceId` on a key got back
 * (record_classification_key_outcome) and what its key and its lane are now.
 * `answered` is written after every answer (the RPC only touches a row with
 * something to reset) and is best effort: a circuit left marked down gets
 * probed again once its probe lease lapses, and answers then.
 */
async function recordKeyOutcome(
  db: SupabaseClient,
  guards: RunGuards,
  workspaceId: string,
  wk: WorkspaceKey,
  outcome: "answered" | "rejected" | "transient",
  code: string | null,
  deadline: number,
): Promise<Stop | null> {
  const { data, error } = await db
    .rpc("record_classification_key_outcome", {
      p_key_id: wk.keyId,
      p_scope: wk.scope,
      p_workspace_id: workspaceId,
      p_outcome: outcome,
      p_code: code,
      p_breaker: KEY_TRANSIENT_BREAKER,
      p_base_seconds: KEY_DOWN_BASE_SECONDS,
      p_max_seconds: KEY_DOWN_MAX_SECONDS,
      p_rejected_seconds: KEY_REJECTED_SECONDS,
    })
    .abortSignal(dbSignal(deadline));
  const before = guards.keys.get(wk.keyId)?.state ?? "up";
  if (error) {
    console.error("[classify-topics] key health write failed", error.code);
    if (outcome === "answered") {
      learnKey(guards, wk, { state: "up" });
      guards.lanes.set(workspaceId, "up");
      return null;
    }
    return dbStop(error, deadline, "key_health_failed");
  }
  const now = (data ?? {}) as { key?: unknown; workspace?: unknown };
  const keyDown = now.key === "down";
  if (keyDown && before !== "down") console.error("[classify-topics] OpenRouter key down", wk.scope, code ?? "");
  learnKey(guards, wk, { state: keyDown ? "down" : "up" });
  guards.lanes.set(workspaceId, now.workspace === "down" ? "down" : "up");
  return null;
}

/**
 * The key the workspace's calls run on, resolved once per run. The first
 * time, the gate records it for the dashboard and tells its state (unless the
 * run already knows the key, from another workspace on it). A key that can't
 * be used at all is refused on the spot, without a call.
 */
async function workspaceKey(
  db: SupabaseClient,
  guards: RunGuards,
  workspaceId: string,
  deadline: number,
): Promise<WorkspaceKey | Stop> {
  const known = guards.workspaces.get(workspaceId);
  if (known) return known;

  let resolution;
  try {
    resolution = await resolveOpenRouterKey(workspaceId, db, dbSignal(deadline));
  } catch {
    return { kind: "infra", code: "key_lookup_failed" };
  }
  const keyId = openRouterKeyId(resolution, workspaceId);
  if (resolution.scope === null || keyId === null) {
    return remainingMs(deadline) <= 0 ? { kind: "no_time" } : { kind: "infra", code: "key_lookup_failed" };
  }
  const wk: WorkspaceKey = { keyId, scope: resolution.scope, key: resolution.key || null };

  const { data, error } = await db
    .rpc("classification_key_gate", {
      p_workspace_id: workspaceId,
      p_key_id: wk.keyId,
      p_scope: wk.scope,
      p_probe_seconds: LEASE_SECONDS,
    })
    .abortSignal(dbSignal(deadline));
  if (error) return dbStop(error, deadline, "key_gate_failed");
  const gate = (data ?? {}) as { state?: unknown; workspace?: unknown };
  const circuit = (x: unknown): CircuitState => (x === "down" || x === "probe" ? x : "up");
  if (!guards.keys.has(wk.keyId)) learnKey(guards, wk, { state: circuit(gate.state) });
  guards.lanes.set(workspaceId, circuit(gate.workspace));
  if (!wk.key && guards.keys.get(wk.keyId)?.state !== "down") {
    const stop = await recordKeyOutcome(
      db, guards, workspaceId, wk, "rejected", wk.scope === "own" ? "key_unreadable" : "key_missing", deadline,
    );
    if (stop) return stop;
  }
  guards.workspaces.set(workspaceId, wk);
  return wk;
}

/** True when the run already knows this workspace's key, or its lane, is down: skip it, no call. */
function keyKnownDown(guards: RunGuards, workspaceId: string): boolean {
  const wk = guards.workspaces.get(workspaceId);
  return !!wk && (guards.keys.get(wk.keyId)?.state === "down" || guards.lanes.get(workspaceId) === "down");
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
  phase: "nightly" | "backfill",
): Promise<{ id: string | null } | "failed"> {
  const { data, error } = await db
    .rpc("reserve_classification_tokens", {
      p_workspace_id: row.workspace_id,
      p_conversation_id: row.conversation_id,
      p_estimate: estimate,
      p_cap: CLASSIFY_DAILY_TOKEN_CAP,
      // The reservation marks the workspace's turn in this phase.
      p_phase: phase,
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
  if (keyKnownDown(guards, row.workspace_id)) return { kind: "key" };
  const postLlmWrites = backfillTopic ? POST_LLM_WRITES_BACKFILL : POST_LLM_WRITES_CLASSIFY;
  // Piso de LLM COMPLETO antes de reservar: la reserva, los 20 s enteros del
  // LLM y el techo de cada escritura posterior. Toda llamada que sale tiene su
  // presupuesto completo, y un corte siempre es el proveedor lento (never a
  // timeout of ours counted against a key). Fase 1: 5 + 20 + 2×5 = 35 s;
  // fase 2: 40 s.
  const llmFloor = DB_TIMEOUT_MS + LLM_TIMEOUT_MS + postLlmWrites * DB_TIMEOUT_MS;
  let messages: PromptMessage[];
  try {
    messages = await loadMessages(db, row, deadline);
  } catch {
    return { kind: "infra", code: "load_messages_failed" };
  }

  let answered: WorkspaceKey | null = null;
  try {
    let matches: Array<{ topic_id: string; message_id: string }> = [];

    // Only the customer's messages can carry a topic: with none in view there
    // is nothing to ask the LLM, and the row is saved as analysed.
    if (messages.some((m) => m.direction === "in")) {
      if (remainingMs(deadline) < llmFloor) return { kind: "no_time" };

      // KEY: resolved once per workspace and run; its state from the gate.
      const wk = await workspaceKey(db, guards, row.workspace_id, deadline);
      if ("kind" in wk) return wk;
      const view = guards.keys.get(wk.keyId);
      const lane = guards.lanes.get(row.workspace_id) ?? "up";
      if (!wk.key || !view || view.state === "down" || lane === "down") return { kind: "key" };
      // The lookup took time: the floor again, so the LLM still gets all of its own.
      if (remainingMs(deadline) < llmFloor) return { kind: "no_time" };

      // Sin reserva no hay llamada.
      const estimate = classificationTokenCeiling(topics, messages);
      const reservation = await reserveTokens(db, row, estimate, deadline, backfillTopic ? "backfill" : "nightly");
      if (reservation === "failed") return { kind: "infra", code: "budget_reserve_failed" };
      if (reservation.id === null) return { kind: "budget" };

      // The call that tests a key, or a lane, whose wait just ended.
      const probe = view.state === "probe" || lane === "probe";
      const result = await classifyConversation({
        workspaceId: row.workspace_id,
        topics,
        messages,
        abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
        key: { scope: wk.scope, key: wk.key },
      });
      // SETTLEMENT: a known count (0 included) settles; unknown keeps the estimate.
      if (result.usage) await settleTokens(db, row, reservation.id, estimate, result.usage, deadline);

      // The key's health: its own outcome, never another key's.
      if (!result.ok && result.code === "key_rejected") {
        const stop = await recordKeyOutcome(db, guards, row.workspace_id, wk, "rejected", result.code, deadline);
        return stop ?? { kind: "key" };
      }
      if (!result.ok && (result.code === "provider_unavailable" || result.code === "timeout")) {
        const stop = await recordKeyOutcome(db, guards, row.workspace_id, wk, "transient", result.code, deadline);
        return stop ?? { kind: "transient", code: result.code, probe };
      }
      // The provider answered (a result, or a refusal of this text): the key
      // and the lane work. Written after every answer, last (best effort, so
      // it never takes time from the save).
      answered = wk;
      if (!result.ok) {
        await recordKeyOutcome(db, guards, row.workspace_id, wk, "answered", null, deadline);
        return { kind: "content", code: result.code };
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
    if (!error) {
      if (answered) await recordKeyOutcome(db, guards, row.workspace_id, answered, "answered", null, deadline);
      return { kind: "ok" };
    }
    if (isDeadlineAbort(error, deadline)) return { kind: "no_time" };
    if (isDataRejection(error)) {
      if (answered) await recordKeyOutcome(db, guards, row.workspace_id, answered, "answered", null, deadline);
      return { kind: "content", code: "save_failed" };
    }
    console.error("[classify-topics] save_conversation_topics failed", error.code);
    return { kind: "infra", code: "save_infra_failed" };
  } catch {
    return { kind: "content", code: "unexpected" };
  }
}

/**
 * A transient failure, as the conversation's owner sees it: it waits
 * (defer_classification: 1 h, doubling for each in a row), no attempt spent.
 * Returns its failures in a row. A probe's failure is the key's alone.
 */
async function deferConversation(
  db: SupabaseClient,
  row: ConversationRow,
  code: string,
  deadline: number,
): Promise<number | Stop> {
  const { data, error } = await db
    .rpc("defer_classification", {
      p_workspace_id: row.workspace_id,
      p_conversation_id: row.conversation_id,
      p_code: code,
      p_seconds: TRANSIENT_BACKOFF_SECONDS,
    })
    .abortSignal(dbSignal(deadline));
  if (error) return dbStop(error, deadline, "defer_failed");
  return Number(data ?? 1) || 1;
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
  const stopped = (stop: Stop): ClassificationPhaseResult =>
    stop.kind === "no_time" ? result : { ...result, error: stop.code, halt: true };

  while (hasTime(deadline)) {
    const { data, error } = await db
      .rpc("select_conversations_to_classify", {
        p_limit: BATCH_SIZE,
        p_skip_workspaces: [...guards.skipped],
        p_lease_seconds: LEASE_SECONDS,
      })
      .abortSignal(dbSignal(deadline));
    if (error) return stopped(dbStop(error, deadline, "select_failed"));
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
          break;
        case "no_time":
          return result;
        case "budget":
          guards.skipped.add(row.workspace_id);
          result.skipped_workspaces++;
          await noteOverCap(db, row.workspace_id, deadline);
          break;
        case "key":
          guards.skipped.add(row.workspace_id);
          result.unavailable_workspaces++;
          break;
        case "transient": {
          result.deferred++;
          if (!outcome.probe) {
            const failures = await deferConversation(db, row, outcome.code, deadline);
            if (typeof failures !== "number") return stopped(failures);
          }
          // Its key went down with this one: the workspace is out of the run.
          if (keyKnownDown(guards, row.workspace_id)) {
            guards.skipped.add(row.workspace_id);
            result.unavailable_workspaces++;
          }
          break;
        }
        case "content": {
          result.failed++;
          const { error: failErr } = await db
            .rpc("record_classification_failure", {
              p_workspace_id: row.workspace_id,
              p_conversation_id: row.conversation_id,
              p_code: outcome.code,
            })
            .abortSignal(dbSignal(deadline));
          // Cortado por el deadline = sin tiempo; el intento no se contó.
          if (failErr) return stopped(dbStop(failErr, deadline, "record_failure_failed"));
          break;
        }
        case "infra":
          return { ...result, error: outcome.code, halt: true };
      }
    }
  }

  return result;
}

type BackfillTopic = PromptTopic & { workspace_id: string };

/** How one turn of a topic ended. */
type TopicTurn = "again" | "done" | "yield" | { phase: BackfillPhaseResult };

export async function runBackfillPhase(
  deadline: number,
  db: SupabaseClient = svc(),
  guards: RunGuards = newRunGuards(),
): Promise<BackfillPhaseResult> {
  const result: BackfillPhaseResult = {
    processed: 0, failed: 0, deferred: 0, topics_done: 0, topics_expired: 0,
    skipped_workspaces: 0, unavailable_workspaces: 0, halt: false,
  };
  // Una escritura cortada por el deadline es "sin tiempo", no un 500.
  // El cursor que no avanzó solo repite trabajo idempotente la próxima corrida.
  const stopped = (err: DbError, code: string): BackfillPhaseResult =>
    isDeadlineAbort(err, deadline) ? result : { ...result, error: code, halt: true };
  const advance = async (topicId: string, to: ConversationRow) =>
    db
      .rpc("advance_topic_backfill", {
        p_topic_id: topicId,
        p_cursor_at: to.last_inbound_at,
        p_cursor_id: to.conversation_id,
        p_done: false,
      })
      .abortSignal(dbSignal(deadline));

  /** One turn of a topic: one batch, in cursor order. */
  const turn = async (topic: BackfillTopic): Promise<TopicTurn> => {
    // Reprocesamiento: solo ese tema, para no redetectar los viejos.
    const prompt: PromptTopic[] = [{ id: topic.id, name: topic.name, description: topic.description }];
    const { data, error: batchErr } = await db
      .rpc("next_backfill_batch", { p_topic_id: topic.id, p_limit: BATCH_SIZE })
      .abortSignal(dbSignal(deadline));
    if (batchErr) return { phase: stopped(batchErr, "backfill_batch_failed") };
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
      if (doneErr) return { phase: stopped(doneErr, "backfill_advance_failed") };
      if (status === "expired") result.topics_expired++;
      else result.topics_done++;
      return "done";
    }

    // In cursor order: the cursor only moves past consecutive successes.
    let done = 0;
    let stop: Outcome | { kind: "waiting" } | null = null;
    for (const row of batch) {
      if (!hasTime(deadline)) {
        stop = { kind: "no_time" };
        break;
      }
      // Waiting after a transient failure: the cursor can't step around
      // it, so the topic waits too, without a call.
      if (row.waits_until) {
        stop = { kind: "waiting" };
        break;
      }
      const outcome = await classifyOne(db, guards, row, prompt, deadline, topic.id);
      if (outcome.kind === "ok") {
        done++;
        continue;
      }
      stop = outcome;
      break;
    }
    result.processed += done;

    // Avanzar primero hasta el último éxito consecutivo: advance resetea
    // backfill_attempts, así que va antes de registrar un fallo.
    if (done > 0) {
      const { error: advErr } = await advance(topic.id, batch[done - 1]);
      if (advErr) return { phase: stopped(advErr, "backfill_advance_failed") };
    }

    if (!stop) return "again";
    const failedRow = batch[done];
    switch (stop.kind) {
      case "no_time":
        return { phase: result };
      case "infra":
        return { phase: { ...result, error: stop.code, halt: true } };
      case "waiting":
        return "yield";
      case "budget":
        guards.skipped.add(topic.workspace_id);
        result.skipped_workspaces++;
        await noteOverCap(db, topic.workspace_id, deadline);
        return "yield";
      case "key":
        guards.skipped.add(topic.workspace_id);
        result.unavailable_workspaces++;
        return "yield";
      case "transient": {
        // Never counts on the topic: the conversation waits (its own
        // doubling) and the topic with it. Only a conversation that keeps
        // failing that way while its key is up gets stepped past.
        result.deferred++;
        const failures = stop.probe ? 0 : await deferConversation(db, failedRow, stop.code, deadline);
        if (typeof failures !== "number") {
          return { phase: failures.kind === "no_time" ? result : { ...result, error: failures.code, halt: true } };
        }
        if (keyKnownDown(guards, topic.workspace_id)) {
          guards.skipped.add(topic.workspace_id);
          result.unavailable_workspaces++;
          return "yield";
        }
        if (failures < BACKFILL_TRANSIENT_SKIP) return "yield";
        const { error: skipErr } = await advance(topic.id, failedRow);
        if (skipErr) return { phase: stopped(skipErr, "backfill_advance_failed") };
        return "again";
      }
      case "content": {
        // A cursor can't step around one conversation: content failures
        // count on the topic, and the third in a row steps past it.
        result.failed++;
        const { data: attempts, error: recErr } = await db
          .rpc("record_backfill_failure", { p_topic_id: topic.id })
          .abortSignal(dbSignal(deadline));
        if (recErr) return { phase: stopped(recErr, "record_failure_failed") };
        if (Number(attempts ?? 0) < 3) return "yield"; // se reintenta en la próxima corrida
        const { error: skipErr } = await advance(topic.id, failedRow);
        if (skipErr) return { phase: stopped(skipErr, "backfill_advance_failed") };
        return "again";
      }
    }
  };

  // TURNS: the topics in the database's order (each workspace's oldest
  // pending topic first, the workspace served longest ago first), one batch
  // each per round, round after round while there is time. A topic is claimed
  // (its lease, LEASE_SECONDS) when its first turn comes; one that another run
  // holds is left alone.
  const { data: topics, error } = await db
    .rpc("pending_backfill_topics", { p_limit: BACKFILL_TOPICS, p_skip_workspaces: [...guards.skipped] })
    .abortSignal(dbSignal(deadline));
  if (error) return stopped(error, "backfill_topics_failed");
  let queue = (Array.isArray(topics) ? topics : []) as BackfillTopic[];
  const claimed = new Set<string>();
  const release = async () => {
    for (const id of claimed) {
      const { error: relErr } = await db
        .rpc("release_topic_backfill", { p_topic_id: id })
        .abortSignal(dbSignal(deadline));
      if (relErr) console.error("[classify-topics] backfill lease release failed", relErr.code);
    }
  };

  while (queue.length > 0 && hasTime(deadline)) {
    const next: BackfillTopic[] = [];
    for (const topic of queue) {
      if (!hasTime(deadline)) break;
      if (guards.skipped.has(topic.workspace_id)) continue;
      if (!claimed.has(topic.id)) {
        const { data: ok, error: claimErr } = await db
          .rpc("claim_topic_backfill", { p_topic_id: topic.id, p_lease_seconds: LEASE_SECONDS })
          .abortSignal(dbSignal(deadline));
        if (claimErr) return stopped(claimErr, "backfill_claim_failed");
        if (ok !== true) continue;
        claimed.add(topic.id);
      }
      const t = await turn(topic);
      if (typeof t === "object") return t.phase; // the leases lapse on their own
      if (t === "done") claimed.delete(topic.id); // closing it released the lease
      if (t === "again") next.push(topic);
    }
    queue = next;
  }

  await release();
  return result;
}
