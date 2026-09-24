import { createClient as createSbClient, type SupabaseClient } from "@supabase/supabase-js";
import { isBodyTruncated, MAX_PROMPT_MESSAGES, type PromptMessage, type PromptTopic } from "../lib/classify-prompt";
import { classificationTokenCeiling, classifyConversation, CLASSIFY_MODEL, type LlmUsage } from "./classifier";

/**
 * La clasificación se detiene con 300k tokens del día UTC; el bot conserva
 * ≥ 1,2M. Tope DURO: ninguna llamada sale sin una
 * reserva de su techo (`reserve_classification_tokens`), y la reserva se niega
 * si consumo del día + techo > tope.
 */
export const CLASSIFY_DAILY_TOKEN_CAP = 300_000;

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
 * Invariante: RUN_BUDGET_MS (50 s, route.ts) < maxDuration (60 s) < LEASE_SECONDS.
 * Una corrida nunca sobrevive a su propio lease; por eso los leases no llevan
 * token de propiedad. Subir RUN_BUDGET_MS o maxDuration por encima de esto
 * rompe la exclusión.
 */
const LEASE_SECONDS = 120;

export interface ClassificationPhaseResult {
  classified: number;
  failed: number;
  skipped_workspaces: number;
  /**
   * true = la fase no debe seguir gastando: la reserva de tokens no se
   * pudo hacer, el proveedor está caído, o un resultado pagado que la base no pudo guardar. La ruta NO corre la fase
   * 2 detrás.
   */
  halt: boolean;
  error?: string;
}

export interface BackfillPhaseResult {
  processed: number;
  failed: number;
  topics_done: number;
  /** Lote vacío porque la ventana de 30 días se venció, no por terminar. */
  topics_expired: number;
  /** Mismo significado que en ClassificationPhaseResult. */
  halt: boolean;
  error?: string;
}

interface ConversationRow {
  conversation_id: string;
  workspace_id: string;
  contact_id: string;
  last_message_at: string;
}

/**
 * `infra` = no es culpa de la conversación: NO gasta un intento y
 * corta la fase. `halt` = además la fase no puede seguir gastando.
 * `no_time` y `over_budget` son aparte: tampoco gastan intento, y no son error.
 */
type Outcome = { ok: true } | { ok: false; code: string; infra?: boolean; halt?: boolean };

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

/**
 * Reserva el techo de la llamada ANTES de hacerla.
 * La RPC suma el consumo del día y, si cabe, inserta la fila de llm_usage con
 * la estimación, todo bajo un lock por workspace (mismo patrón que
 * reserve_llm_turn). Consultar `sum_daily_llm_tokens` dejaría a dos corridas
 * autorizar cada una su llamada con el mismo saldo, e insertar después
 * dejaría el gasto sin contar si ese INSERT falla.
 * Devuelve el id de la reserva, `null` si no cabe bajo el tope, o "failed".
 * "No pude reservar" ≠ "sin saldo". Un corte por el deadline común no
 * puede pasar acá: el caller solo reserva con ≥ 35 s por delante, y
 * el techo de la consulta es de 5 s.
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
    // Cualquier código, incluido un rechazo de datos: sin reserva no hay
    // llamada, y la conversación no tiene la culpa.
    console.error("[classify-topics] token reservation failed", error.code);
    return "failed";
  }
  return { id: typeof data === "string" ? data : null };
}

/**
 * Liquida la reserva con el consumo real. Si falla, la fila conserva la
 * estimación, que es un techo: el día queda SOBREcontado, nunca subcontado, y
 * el gasto sigue acotado por las reservas. Por eso NO corta la fase (un
 * `halt` acá frenaría el trabajo sin proteger nada); se deja en el log. Si la
 * base de verdad está caída, el save que viene detrás corta con halt.
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
  // Sin contact_id a propósito (la fila la crea la reserva sin él):
  // reserve_llm_turn cuenta el tope por contacto con payload->>'contact_id', y
  // la clasificación no debe comerle turnos al cliente.
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
    .order("created_at", { ascending: false })
    .limit(MAX_PROMPT_MESSAGES)
    .abortSignal(dbSignal(deadline));
  if (error) throw new Error("load_messages_failed");
  return ((data ?? []) as PromptMessage[]).reverse();
}

const NO_TIME: Outcome = { ok: false, code: "no_time" };

async function classifyOne(
  db: SupabaseClient,
  row: ConversationRow,
  topics: PromptTopic[],
  deadline: number,
  classifiedUntil: string | null,
  postLlmWrites: number,
): Promise<Outcome> {
  let messages: PromptMessage[];
  try {
    messages = await loadMessages(db, row, deadline);
  } catch {
    // La base no respondió; la conversación no tiene la culpa.
    return { ok: false, code: "load_messages_failed", infra: true };
  }

  try {
    let matches: Array<{ topic_id: string; message_id: string }> = [];

    if (messages.length > 0) {
      // Piso de LLM COMPLETO antes de reservar. Solo
      // se reserva y se llama si queda tiempo para la reserva, los 20 s enteros
      // del LLM y el techo de cada escritura posterior. Con un piso mínimo, la
      // última llamada de cada corrida saldría con segundos, se cortaría,
      // OpenRouter la cobraría, no se guardaría nada y la reserva quedaría en el
      // techo; con backlog, cada corrida de la noche quemaría una. Así
      // toda llamada que sale tiene su presupuesto completo, y un corte siempre
      // es el proveedor lento. Costo: el final de cada corrida queda ocioso.
      // Fase 1: 5 + 20 + 2×5 = 35 s; fase 2: 40 s; RUN_BUDGET_MS = 50 s.
      if (remainingMs(deadline) < DB_TIMEOUT_MS + LLM_TIMEOUT_MS + postLlmWrites * DB_TIMEOUT_MS) return NO_TIME;

      // Sin reserva no hay llamada.
      const estimate = classificationTokenCeiling(topics, messages);
      const reservation = await reserveTokens(db, row, estimate, deadline);
      if (reservation === "failed") return { ok: false, code: "budget_reserve_failed", infra: true, halt: true };
      if (reservation.id === null) return { ok: false, code: "over_budget" };

      // Presupuesto fijo. Con respuesta, la reserva tardó ≤ 5 s (su
      // abort la convierte en "failed"); el jitter de ms lo absorbe el techo de
      // las escrituras, que igual se acotan al deadline (dbSignal).
      const result = await classifyConversation({
        workspaceId: row.workspace_id,
        topics,
        messages,
        abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      });
      // Sin `usage` (corte, caída, o el proveedor no informó
      // los dos conteos) la reserva conserva la estimación. OpenRouter factura
      // las peticiones sin streaming aunque el cliente se desconecte, así que
      // liquidar en 0 subcontaría.
      if (result.usage) await settleTokens(db, row, reservation.id, estimate, result.usage, deadline);
      if (!result.ok) {
        // Una caída del proveedor no es culpa de la conversación. Si contara
        // como intento, un 503 largo mandaría a cuarentena conversaciones
        // sanas y el cron respondería 200.
        if (result.code === "provider_unavailable") return { ok: false, code: result.code, infra: true, halt: true };
        // Con el piso de arriba el LLM siempre tuvo sus 20 s: el corte es el
        // proveedor lento, nunca el deadline común.
        if (result.code === "timeout") return { ok: false, code: "timeout", infra: true, halt: true };
        return { ok: false, code: result.code };
      }
      matches = result.matches;
    }

    const { error } = await db
      .rpc("save_conversation_topics", {
        p_workspace_id: row.workspace_id,
        p_conversation_id: row.conversation_id,
        p_matches: matches,
        p_classified_until: classifiedUntil,
        // Cobertura parcial declarada. La RPC decide qué quedó fuera
        // (mensajes anteriores al más viejo que vio el LLM y aún no analizados)
        // y lo suma a los recortados. loadMessages ya trae los últimos 60 en
        // orden: son exactamente los que entran al prompt.
        p_window_from: messages[0]?.created_at ?? null,
        p_truncated_at: messages.filter(isBodyTruncated).map((m) => m.created_at),
      })
      .abortSignal(dbSignal(deadline));
    if (!error) return { ok: true };
    if (isDeadlineAbort(error, deadline)) return { ok: false, code: "no_time" };
    if (isDataRejection(error)) return { ok: false, code: "save_failed" };
    // Con la base fallando, la siguiente conversación pagaría el LLM y
    // perdería el resultado igual. halt deja el desperdicio en una llamada.
    console.error("[classify-topics] save_conversation_topics failed", error.code);
    return { ok: false, code: "save_infra_failed", infra: true, halt: true };
  } catch {
    return { ok: false, code: "unexpected" };
  }
}

export async function runClassificationPhase(
  deadline: number,
  db: SupabaseClient = svc(),
): Promise<ClassificationPhaseResult> {
  const result: ClassificationPhaseResult = { classified: 0, failed: 0, skipped_workspaces: 0, halt: false };
  const skipped = new Set<string>();
  const topicsByWorkspace = new Map<string, PromptTopic[]>();

  while (hasTime(deadline)) {
    const { data, error } = await db
      .rpc("select_conversations_to_classify", {
        p_limit: BATCH_SIZE,
        p_skip_workspaces: [...skipped],
        p_lease_seconds: LEASE_SECONDS,
      })
      .abortSignal(dbSignal(deadline));
    if (error) return { ...result, error: "select_failed" };
    const rows = (data ?? []) as ConversationRow[];
    if (rows.length === 0) break;

    // SECUENCIAL. Lo que quede del lote sin procesar sigue reclamado hasta
    // que vence el lease (LEASE_SECONDS) y lo retoma la corrida siguiente.
    for (const row of rows) {
      if (!hasTime(deadline)) return result; // chequeo tras cada espera
      if (skipped.has(row.workspace_id)) continue;

      let topics = topicsByWorkspace.get(row.workspace_id);
      if (!topics) {
        try {
          topics = await loadTopics(db, row.workspace_id, deadline);
        } catch {
          return { ...result, error: "load_topics_failed" }; // infraestructura
        }
        topicsByWorkspace.set(row.workspace_id, topics);
      }
      const outcome = await classifyOne(db, row, topics, deadline, row.last_message_at, POST_LLM_WRITES_CLASSIFY);

      if (outcome.ok) {
        result.classified++;
        continue;
      }
      // Quedarse sin tiempo no es culpa de la conversación: no gasta un intento.
      if (outcome.code === "no_time") return result;
      // Reserva negada: el workspace no tiene saldo para ESTA llamada. Se salta
      // entero por el resto de la corrida (y en la selección). La conversación
      // conserva su lease y vuelve cuando vence.
      if (outcome.code === "over_budget") {
        skipped.add(row.workspace_id);
        result.skipped_workspaces++;
        continue;
      }
      // La infraestructura tampoco. No se registra el fallo (tres
      // corridas con la base caída mandarían a cuarentena conversaciones sanas);
      // la fase se corta en su lugar, y eso es lo que acota el gasto repetido.
      // No hay RPC para soltar el lease de una conversación sin tocar sus
      // intentos: vence solo (LEASE_SECONDS), antes del cron siguiente.
      if (outcome.infra) return { ...result, error: outcome.code, halt: outcome.halt === true };

      result.failed++;
      const { error: failErr } = await db
        .rpc("record_classification_failure", {
          p_workspace_id: row.workspace_id,
          p_conversation_id: row.conversation_id,
          p_code: outcome.code,
        })
        .abortSignal(dbSignal(deadline));
      if (failErr) {
        // Cortado por el deadline = sin tiempo; el intento no se contó
        // y la conversación vuelve cuando vence el lease.
        if (isDeadlineAbort(failErr, deadline)) return result;
        // No poder registrar el fallo también es infraestructura caída.
        return { ...result, error: "record_failure_failed" };
      }
    }
  }

  return result;
}

export async function runBackfillPhase(
  deadline: number,
  db: SupabaseClient = svc(),
): Promise<BackfillPhaseResult> {
  const result: BackfillPhaseResult = { processed: 0, failed: 0, topics_done: 0, topics_expired: 0, halt: false };
  const TOPIC_PAGE = 20;
  // Memo: workspaces cuya reserva se negó en esta corrida. Sus temas se saltan.
  const noBudget = new Set<string>();
  let offset = 0;
  // Una escritura cortada por el deadline es "sin tiempo", no un 500.
  // El cursor que no avanzó solo repite trabajo idempotente la próxima corrida.
  const stopped = (err: DbError, code: string): BackfillPhaseResult =>
    isDeadlineAbort(err, deadline) ? result : { ...result, error: code };

  // Se PAGINA. Si se tomaran los 20 primeros temas y recién ahí se
  // descartaran los workspaces sin saldo, con 10 temas de A y 10 de B agotados
  // el tema de C nunca sería consultado, y si A/B llegan al tope cada noche, el
  // histórico de C quedaría bloqueado para siempre.
  while (hasTime(deadline)) {
    const { data: topics, error } = await db
      .from("insight_topics")
      .select("id, workspace_id, name, description")
      .eq("status", "active")
      .eq("backfill_status", "pending")
      .order("created_at")
      .range(offset, offset + TOPIC_PAGE - 1)
      .abortSignal(dbSignal(deadline));
    if (error) return { ...result, error: "backfill_topics_failed" };
    const page = (topics ?? []) as Array<PromptTopic & { workspace_id: string }>;
    if (page.length === 0) break;
    offset += page.length;

    for (const topic of page) {
      if (!hasTime(deadline)) return result;
      if (noBudget.has(topic.workspace_id)) continue; // se salta el tema, NO se corta el recorrido

      // Lease por tema (ver LEASE_SECONDS). Si otra corrida lo tiene,
      // se salta sin cortar la paginación.
      const { data: claimed, error: claimErr } = await db
        .rpc("claim_topic_backfill", { p_topic_id: topic.id, p_lease_seconds: LEASE_SECONDS })
        .abortSignal(dbSignal(deadline));
      if (claimErr) return { ...result, error: "backfill_claim_failed" };
      if (claimed !== true) continue;

      // Reprocesamiento: solo ese tema, para no redetectar los viejos.
      const prompt: PromptTopic[] = [{ id: topic.id, name: topic.name, description: topic.description }];

      while (hasTime(deadline)) {
        const { data, error: batchErr } = await db
          .rpc("next_backfill_batch", { p_topic_id: topic.id, p_limit: BATCH_SIZE })
          .abortSignal(dbSignal(deadline));
        if (batchErr) return { ...result, error: "backfill_batch_failed" };
        const batch = (data ?? []) as ConversationRow[];

        if (batch.length === 0) {
          // Lote vacío = terminado O ventana vencida. Lo decide la RPC (el piso
          // de la ventana vive en SQL) y devuelve el estado con que quedó.
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

        // Secuencial, con una reserva de tokens antes de cada llamada.
        const outcomes: Outcome[] = [];
        let ranOut = false;
        for (const row of batch) {
          if (!hasTime(deadline)) {
            ranOut = true;
            break;
          }
          const outcome = await classifyOne(db, row, prompt, deadline, null, POST_LLM_WRITES_BACKFILL);
          if (!outcome.ok && outcome.code === "over_budget") {
            noBudget.add(row.workspace_id);
            ranOut = true;
            break;
          }
          outcomes.push(outcome);
          if (!outcome.ok) break; // el cursor solo avanza hasta el último éxito
        }

        const firstFail = outcomes.findIndex((o) => !o.ok);
        const okCount = firstFail === -1 ? outcomes.length : firstFail;
        result.processed += okCount;

        // Avanzar primero hasta el último éxito consecutivo: advance resetea
        // backfill_attempts, así que va antes de registrar el fallo.
        if (okCount > 0) {
          const last = batch[okCount - 1];
          const { error: advErr } = await db
            .rpc("advance_topic_backfill", {
              p_topic_id: topic.id,
              p_cursor_at: last.last_message_at,
              p_cursor_id: last.conversation_id,
              p_done: false,
            })
            .abortSignal(dbSignal(deadline));
          if (advErr) return stopped(advErr, "backfill_advance_failed");
        }

        if (firstFail === -1) {
          if (ranOut) break; // sin tiempo o sin saldo: se retoma la próxima
          continue;
        }

        const failedOutcome = outcomes[firstFail] as Extract<Outcome, { ok: false }>;
        if (failedOutcome.code === "no_time") return result;
        // Igual que en la fase 1. Contarlo acá sería peor: al tercer
        // intento el tema SALTA la conversación para siempre.
        if (failedOutcome.infra) return { ...result, error: failedOutcome.code, halt: failedOutcome.halt === true };

        result.failed++;
        const { data: attempts, error: recErr } = await db
          .rpc("record_backfill_failure", { p_topic_id: topic.id })
          .abortSignal(dbSignal(deadline));
        if (recErr) return stopped(recErr, "record_failure_failed");
        if (Number(attempts ?? 0) < 3) break; // se reintenta en la próxima corrida

        const failedRow = batch[firstFail];
        const { error: skipErr } = await db
          .rpc("advance_topic_backfill", {
            p_topic_id: topic.id,
            p_cursor_at: failedRow.last_message_at,
            p_cursor_id: failedRow.conversation_id,
            p_done: false,
          })
          .abortSignal(dbSignal(deadline));
        if (skipErr) return stopped(skipErr, "backfill_advance_failed");
      }

      // Terminado con el tema: se suelta el lease (el cierre done/expired ya lo
      // soltó en su UPDATE). Los `return` de arriba cortan la corrida entera y
      // dejan que venza solo, igual que lo no procesado de la fase 1: 120 s,
      // antes de la próxima corrida del cron. Por eso un fallo acá solo se loguea.
      const { error: relErr } = await db
        .rpc("release_topic_backfill", { p_topic_id: topic.id })
        .abortSignal(dbSignal(deadline));
      if (relErr) console.error("[classify-topics] backfill lease release failed", relErr.code);
    }
  }

  return result;
}
