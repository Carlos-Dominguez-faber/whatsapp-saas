import { createClient as createSbClient } from "@supabase/supabase-js";
import { generateWithTools, getWorkspaceModel } from "./openrouter";
import { recordLlmUsage, checkRateLimits } from "./cost-tracker";
import { dispatchText, dispatchTemplate } from "./dispatch";
import { decide, applyTransition } from "./decision-engine";
import type { ToolContext } from "@/features/tools/core/tool";
import { resolveSystemPrompt } from "./prompt-resolver";
import { buildSystemPrompt } from "./prompt-builder";
import { getActiveAgent } from "@/features/agents/services/active-agent";
import { maybeAutoProcess } from "@/features/agents/services/auto-tagging";
import {
  getBusinessInfo,
  buildBusinessInfoContext,
  buildNowContext,
} from "./business-info";
import {
  searchKb,
  formatKbContext,
  listKbSourceLinks,
  formatKbReferenceLinks,
} from "./kb-service";
import { enforceCostPolicy, buildCostAwareSystemPrompt } from "./cost-enforcer";
import {
  getConversationHistory,
  type ConversationTurn,
} from "./conversation-history";
import { getSetterConfig, evaluateLead } from "./setter";
import { syncContactToHL, createHLOpportunity } from "./highlevel-client";

const DEFAULT_SILENCE_MS = 30_000; // 30 seconds silence window
const MAX_BATCH_RETRIES = 3;

// ──────────────────────────────────────────────────────────────────────────────
// Internal types
// ──────────────────────────────────────────────────────────────────────────────

interface MessageBatch {
  id: string;
  workspace_id: string;
  conversation_id: string;
  status: "buffering" | "flushed" | "processing" | "cancelled";
  silence_ms: number;
  flush_at: string;
  message_count: number;
  merged_text: string | null;
  meta: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface BatchMessage {
  id: string;
  body: string | null;
  meta: Record<string, unknown> | null;
  type: string;
  created_at: string;
}

interface Integration {
  credentials: Record<string, unknown>;
  config: Record<string, unknown>;
}

export interface ProcessBatchResult {
  processed: boolean;
  conversationId?: string;
  error?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Service-role Supabase client — only used inside services/, never in routes
// ──────────────────────────────────────────────────────────────────────────────
function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// upsertBatch
// Creates a new buffering batch for a conversation, or extends an existing
// one — atomically, via the upsert_batch_and_link_message() SQL function.
// Extending/creating the batch and linking
// the message to it happen in the SAME Postgres transaction, so no external
// claim_next_batch() call can interpose between them. Returns the batch ID.
// ──────────────────────────────────────────────────────────────────────────────
export async function upsertBatch(
  opts: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    silenceMs?: number;
    /** Skip joining any in-flight batch — always create a standalone one.
     * Only reconcileOrphanedMessages sets this: a revived orphan is, by
     * definition, temporally unrelated to whatever else is buffering for
     * this conversation right now. */
    forceNewBatch?: boolean;
  },
  retryOpts: {
    attempts?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<string> {
  const {
    workspaceId,
    conversationId,
    messageId,
    silenceMs = DEFAULT_SILENCE_MS,
    forceNewBatch = false,
  } = opts;
  const supabase = svc();
  const {
    attempts = 3,
    delayMs = 300,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  } = retryOpts;

  let lastError: { message?: string } | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const { data, error } = await supabase.rpc("upsert_batch_and_link_message", {
      p_workspace_id: workspaceId,
      p_conversation_id: conversationId,
      p_message_id: messageId,
      p_silence_ms: silenceMs,
      p_force_new_batch: forceNewBatch,
    });

    if (!error && data) return data as string;

    lastError = error;
    // Espera fija — cubre un blip transitorio de la RPC, no un
    // servicio caído (mismo patrón que recordLlmUsage en cost-tracker.ts).
    if (attempt < attempts - 1) await sleep(delayMs);
  }

  console.error(
    "[buffer] upsert_batch_and_link_message RPC error after retries:",
    lastError,
  );
  throw new Error(`Failed to upsert batch: ${lastError?.message}`);
}

const ORPHAN_MESSAGE_AGE_MS = 2 * 60_000; // 2 minutos — más que suficiente
// margen para que los 3 reintentos de upsertBatch (~1s en el peor
// caso) ya se hayan resuelto en un sentido u otro.
const MAX_ORPHANS_PER_RUN = 20;
// Without an upper bound on age, every inbound the
// webhook deliberately left unbatched (AI off, rate-limited) stayed a
// candidate forever, and re-enabling the AI days later made the agent answer
// the whole backlog one message at a time. Anything older than this is not a
// transient upsertBatch() failure any more — it is history.
const ORPHAN_MESSAGE_MAX_AGE_MS = 15 * 60_000;

// ──────────────────────────────────────────────────────────────────────────────
// reconcileOrphanedMessages (exported)
// Red de seguridad para el caso que los reintentos de upsertBatch() no
// cierran: un mensaje entrante cuya RPC de linkeo falló de forma
// persistente. Kapso deduplica su reentrega por wamid (índice único en
// messages), así que una vez que la fila del mensaje existe nunca vuelve a
// pasar por upsertBatch() — sin esto, se queda con batch_id NULL para
// siempre y jamás recibe respuesta de IA. Se llama desde el cron buffer-flush (ya corre cada
// minuto) antes de drenar batches.
// ──────────────────────────────────────────────────────────────────────────────
export async function reconcileOrphanedMessages(
  retryOpts: {
    attempts?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<number> {
  const supabase = svc();
  const now = Date.now();
  const cutoff = new Date(now - ORPHAN_MESSAGE_AGE_MS).toISOString();
  const oldest = new Date(now - ORPHAN_MESSAGE_MAX_AGE_MS).toISOString();

  // `!inner` + the embedded filter make PostgREST drop AI-off conversations
  // server-side, so they no longer consume the LIMIT budget.
  const { data, error } = await supabase
    .from("messages")
    .select("id, workspace_id, conversation_id, conversations!inner(ai_enabled, contact_id)")
    .is("batch_id", null)
    .eq("direction", "in")
    .gt("created_at", oldest)
    .lt("created_at", cutoff)
    .eq("conversations.ai_enabled", true)
    .limit(MAX_ORPHANS_PER_RUN);

  if (error) {
    console.error("[buffer] reconcileOrphanedMessages lookup error:", error);
    return 0;
  }

  const orphans = ((data ?? []) as unknown[]).map(
    (row) =>
      row as {
        id: string;
        workspace_id: string;
        conversation_id: string;
        conversations: { ai_enabled: boolean; contact_id: string } | null;
      },
  );

  let recovered = 0;
  for (const row of orphans) {
    // Re-verifica en vivo, no confía en un marcador escrito en el pasado: si
    // la conversación tiene la IA apagada o el contacto sigue rate-limited
    // AHORA, el mensaje se deja sin batch, igual que hizo el webhook cuando
    // llegó. Elimina la dependencia de una escritura que puede fallar (un
    // marcador best-effort escrito por el webhook).
    if (!row.conversations?.ai_enabled) continue;

    const rate = await checkRateLimits(
      row.workspace_id,
      row.conversations.contact_id,
    );
    if (!rate.allowed) continue;

    try {
      // silenceMs=0 + forceNewBatch=true: un huérfano recuperado nunca debe
      // unirse a un batch en curso, ni absorber uno nuevo. Sin
      // forceNewBatch, un mensaje nuevo no relacionado (p. ej. un simple
      // "Hola") que llegue mientras el cron no ha reclamado este batch
      // podría pegársele — o, al revés, este reconcile podría meterse en un
      // batch que un mensaje nuevo acaba de crear. La RPC
      // (20260825000000_isolate_reconciled_orphan_batches) fuerza un batch
      // aislado y lo deja con flush_at = NOW() para que claim_next_batch()
      // lo recoja en la misma pasada del cron.
      await upsertBatch(
        {
          workspaceId: row.workspace_id,
          conversationId: row.conversation_id,
          messageId: row.id,
          silenceMs: 0,
          forceNewBatch: true,
        },
        retryOpts,
      );
      recovered++;
    } catch (err) {
      console.error("[buffer] reconcileOrphanedMessages upsertBatch error:", {
        messageId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return recovered;
}

// ──────────────────────────────────────────────────────────────────────────────
// consolidateBatch (private)
// Fetches all inbound messages for a batch and joins them into a single string.
// Audio transcripts / image captions use media->>'transcript' / media->>'caption'
// when present; otherwise falls back to body text. (Multi-modal extended in F8.)
// ──────────────────────────────────────────────────────────────────────────────
async function consolidateBatch(
  batchId: string,
  supabase: ReturnType<typeof svc>,
): Promise<string> {
  const { data: msgs, error } = await supabase
    .from("messages")
    .select("id, body, meta, type, created_at")
    .eq("batch_id", batchId)
    .eq("direction", "in")
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`[buffer] consolidateBatch fetch error: ${error.message}`);
  }

  const lines = (msgs as BatchMessage[]).map((msg) => {
    // Media is pre-processed to text by media-understanding (transcript for
    // voice notes, description for images) and stored in messages.meta.
    const meta = msg.meta ?? {};
    const str = (v: unknown): string | null =>
      typeof v === "string" && v.trim() ? v.trim() : null;
    const transcript = str(meta.transcript);
    const description = str(meta.description);
    const caption = str(meta.caption);
    const filename = str(meta.filename);

    switch (msg.type) {
      case "audio":
      case "voice":
        // The transcript IS the customer's message — pass it through as plain
        // text. The old "[Nota de voz del cliente]:" prefix cued the model to
        // disclaim that it "can't hear voice notes" even though the transcript
        // was present, so it answered with a useless placeholder.
        return transcript
          ? transcript
          : "[El cliente envió una nota de voz que no se pudo transcribir; pídele que escriba su mensaje]";
      case "image":
        if (description)
          return `[El cliente envió una imagen]: ${description}${caption ? ` (texto adjunto: "${caption}")` : ""}`;
        return caption
          ? `[El cliente envió una imagen con el texto]: "${caption}"`
          : "[El cliente envió una imagen; pídele que describa qué necesita]";
      case "video":
        return `[El cliente envió un video${caption ? ` con el texto: "${caption}"` : ""}; no puedo verlo, pídele que lo describa o deriva a una persona]`;
      case "document":
        return `[El cliente envió un documento${filename ? `: "${filename}"` : ""}${caption ? ` con el texto: "${caption}"` : ""}; no puedo leer su contenido, pídele los datos clave o deriva a una persona]`;
      case "sticker":
        return "[El cliente envió un sticker]";
      default:
        return msg.body ?? "[Multimedia]";
    }
  });

  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────────
// processNextBatch (exported)
// Called by the cron job (/api/cron/buffer-flush) or the internal trigger.
//
// Flow:
//   1. claim_next_batch() RPC — atomic, uses FOR UPDATE SKIP LOCKED
//   2. No batch available → return { processed: false }
//   3. consolidateBatch → mergedText
//   4. Load conversation (ai_enabled, workspace_id, contact info)
//   5. checkRateLimits
//   6. generateReply with consolidated text
//   7. recordLlmUsage
//   8. sendText via kapso-client (or insert dev_mode outbound)
//   9. Mark batch 'processed', persist merged_text
//  10. On error: increment retry counter; if > MAX_BATCH_RETRIES → cancel_batch()
// ──────────────────────────────────────────────────────────────────────────────
export async function processNextBatch(): Promise<ProcessBatchResult> {
  const supabase = svc();

  // ── 1. Claim one ready batch atomically ───────────────────────────────────
  const { data: claimedRows, error: claimError } =
    await supabase.rpc("claim_next_batch");

  if (claimError) {
    console.error("[buffer] claim_next_batch RPC error:", claimError);
    return { processed: false, error: claimError.message };
  }

  const batch = (claimedRows as MessageBatch[] | null)?.[0] ?? null;

  // ── 2. Nothing to process ─────────────────────────────────────────────────
  if (!batch) {
    return { processed: false };
  }

  const retryCount = (batch.meta?.retry_count as number | undefined) ?? 0;

  try {
    // ── 3. Consolidate messages into one string ──────────────────────────────
    const mergedText = await consolidateBatch(batch.id, supabase);

    // ── 4. Load conversation record ─────────────────────────────────────────
    const { data: conversation, error: convError } = await supabase
      .from("conversations")
      .select("id, workspace_id, contact_id, ai_enabled, summary")
      .eq("id", batch.conversation_id)
      .single();

    if (convError || !conversation) {
      throw new Error(`Conversation not found: ${convError?.message}`);
    }

    // ── 5. Decision engine: state check + handoff trigger + rate limits ──────
    const decisionResult = await decide({
      workspaceId: batch.workspace_id,
      conversationId: batch.conversation_id,
      mergedText,
      contactId: conversation.contact_id as string,
    });

    const { decision, reason } = decisionResult;

    if (decision !== "respond") {
      console.info("[buffer] not responding:", decision, reason);
      await markBatchProcessed(batch.id, mergedText, supabase);
      return { processed: true, conversationId: batch.conversation_id };
    }

    // ── 6. Build ToolContext (SEC-01: anchored server-side, never from client) ─
    const toolCtx: ToolContext = {
      workspaceId: batch.workspace_id,
      conversationId: batch.conversation_id,
      contactId: conversation.contact_id as string,
    };

    // ── 6b. Resolve conversational memory window (WS2: configurable) ─────────
    // The Kapso integration config carries message_history_window; clamp to
    // [5, 50] and default to 10 when unset or non-numeric.
    const { data: kapsoCfg } = await supabase
      .from("integrations")
      .select("config")
      .eq("workspace_id", batch.workspace_id)
      .eq("provider", "kapso")
      .eq("enabled", true)
      .maybeSingle();
    const rawWindow = Number(
      (kapsoCfg?.config as { message_history_window?: number } | null)
        ?.message_history_window,
    );
    const historyWindow = Number.isFinite(rawWindow)
      ? Math.min(50, Math.max(5, rawWindow))
      : 10;

    // ── 6c. Load prior conversation turns (WS1: memory injection) ────────────
    const history = await getConversationHistory(batch.conversation_id, {
      limit: historyWindow,
      excludeBatchId: batch.id,
    });

    // ── 7. Build system prompt: KB > custom prompt > business info (F7) ──────
    // The active agent (if any) selects its mode-scoped published prompt; the
    // resolver falls back to the global prompt when there is no active agent.
    const activeAgent = await getActiveAgent(batch.workspace_id);
    const [resolvedPrompt, businessInfo, kbResults, kbLinks] =
      await Promise.all([
        resolveSystemPrompt(
          batch.workspace_id,
          activeAgent ? { mode: activeAgent.type } : {},
        ),
        getBusinessInfo(batch.workspace_id),
        searchKb(batch.workspace_id, mergedText, 3),
        listKbSourceLinks(batch.workspace_id),
      ]);

    const kbContext = [
      formatKbContext(kbResults),
      formatKbReferenceLinks(kbLinks),
    ]
      .filter(Boolean)
      .join("\n\n");
    const bizContext = buildBusinessInfoContext(businessInfo);
    const promptBase =
      resolvedPrompt?.body ??
      "Eres un asistente de WhatsApp. Responde de forma concisa y útil en español.";
    const structured = businessInfo?.structured as {
      timezone?: string;
      name?: string;
    } | null;
    const tz = structured?.timezone ?? "America/Mexico_City";
    // WS1: surface the rolling conversation summary so the model keeps long-term
    // context beyond the recent-message window.
    const summary =
      typeof conversation.summary === "string"
        ? conversation.summary.trim()
        : "";
    // Canonical assembly (shared with the test-chat playground) — includes the
    // response style, KB and the strict rules/restrictions guardrails.
    const fullSystemPrompt = buildSystemPrompt({
      nowContext: buildNowContext(tz),
      bizContext,
      promptBase,
      summary,
      kbContext,
      responseStyle: activeAgent?.config.responseStyle ?? null,
      guardrails: resolvedPrompt?.guardrails ?? null,
      vars: {
        agentName: activeAgent?.name ?? null,
        businessName: structured?.name ?? null,
        contactName: null,
      },
    });

    // ── 7b. SEC-06: enforce cost policy before calling LLM ───────────────────
    const costPolicy = await enforceCostPolicy(batch.workspace_id);
    const { systemPrompt: finalSystemPrompt, model: costModel } =
      await buildCostAwareSystemPrompt(
        batch.workspace_id,
        fullSystemPrompt,
        costPolicy.policy,
      );

    if (costPolicy.policy === "cut") {
      console.warn(
        "[buffer] SEC-06 cost cut — escalating to human for workspace",
        batch.workspace_id,
      );
      // The customer used to get silence. Hand the
      // thread to a human: notifyHandoffPending tells the team and ACKs the
      // contact once, and decide() abstains on later batches (state is no
      // longer ai_active), so the budget stays protected without spamming.
      // Non-fatal: if the transition fails we still close the batch — the
      // next batch for this conversation will try again.
      try {
        await applyTransition(batch.conversation_id, "handoff_pending", {
          trigger: "cost_cut",
          workspaceId: batch.workspace_id,
        });
      } catch (transitionErr) {
        console.error("[buffer] cost-cut handoff transition failed:", {
          conversationId: batch.conversation_id,
          error:
            transitionErr instanceof Error
              ? transitionErr.message
              : String(transitionErr),
        });
      }
      await markBatchProcessed(batch.id, mergedText, supabase);
      return { processed: true, conversationId: batch.conversation_id };
    }

    // ── 8. Generate AI reply with tool-calling support ───────────────────────
    // Resolve workspace model (falls back to env default or gpt-4o-mini).
    // costModel from SEC-06 takes priority when cost policy is degraded.
    const workspaceModel = await getWorkspaceModel(batch.workspace_id);
    const model = costModel ?? workspaceModel;

    const reply = await generateWithTools({
      systemPrompt: finalSystemPrompt,
      model,
      userMessage: mergedText,
      workspaceId: batch.workspace_id,
      availableTools: decisionResult.availableTools,
      toolContext: toolCtx,
      history,
    });

    // With stopWhen(stepCountIs(5)) a turn that
    // burns every step on tool calls comes back with text "". Kapso rejects an
    // empty body (131009) and the batch would end as processed with a failed
    // message. Treat it as a batch error so the retry path regenerates.
    if (!reply.text.trim()) {
      throw new Error(
        `LLM returned an empty reply (toolCallsExecuted=${reply.toolCallsExecuted ?? 0})`,
      );
    }

    // ── 8. Record LLM usage — una falla aquí NO debe reencolar el batch más
    // abajo: el LLM ya se llamó y ya se pagó, así que reencolar volvería a
    // llamarlo. Se loguea
    // y se sigue — el usuario igual recibe su respuesta y el batch se marca
    // procesado, no reencolado. Efecto aceptado: una reserva con los 3
    // reintentos internos agotados queda en total_tokens=0 para siempre,
    // subestimando ese turno en el presupuesto diario — caso raro (3 fallas
    // seguidas de un solo UPDATE) y mejor que pagar el LLM de nuevo.
    try {
      await recordLlmUsage({
        reservationId: decisionResult.reservationId,
        workspaceId: batch.workspace_id,
        conversationId: batch.conversation_id,
        contactId: conversation.contact_id as string,
        model,
        promptTokens: reply.inputTokens,
        completionTokens: reply.outputTokens,
      });
    } catch (usageErr) {
      console.error(
        "[buffer] recordLlmUsage failed, continuing without retrying the LLM call:",
        {
          batchId: batch.id,
          error: usageErr instanceof Error ? usageErr.message : String(usageErr),
        },
      );
    }

    // ── 9. Load Kapso integration credentials ──────────────────────────────
    const { data: integration, error: intError } = await supabase
      .from("integrations")
      // Only an existence check — dispatchText() loads and decrypts the
      // credentials itself, so there is no reason to pull secrets here.
      .select("workspace_id")
      .eq("workspace_id", batch.workspace_id)
      .eq("provider", "kapso")
      .eq("enabled", true)
      .single();

    if (intError || !integration) {
      throw new Error(`Kapso integration not found: ${intError?.message}`);
    }

    // ── 9b. Live state re-check ───────────────────────────────────────────────
    // The LLM turn above can take 10-20 s. If a human took the thread in the
    // meantime (Business App echo → processOutboundEcho → human_active, or
    // the inbox "take"), replying now would talk over them. decide() checked
    // the state before the turn; check it again right before the send.
    // El early-return de abajo también salta los pasos 10c/10d (auto-tag,
    // resumen y evaluación de setter): es deliberado, el humano ya tiene el
    // hilo y esos pasos describen un turno de la IA que no ocurrió.
    // Si la relectura falla se despacha igual (fail-open): un blip transitorio
    // no debe dejar al cliente sin respuesta. Se loguea para que el guard no
    // pueda degradarse a no-op en silencio.
    const { data: liveConv, error: liveErr } = await supabase
      .from("conversations")
      .select("state")
      .eq("id", batch.conversation_id)
      .single();

    if (liveErr || !liveConv) {
      console.error("[buffer] live state re-check failed, dispatching anyway", {
        batchId: batch.id,
        conversationId: batch.conversation_id,
        error: liveErr?.message,
      });
    }

    if (liveConv && liveConv.state !== "ai_active") {
      console.info("[buffer] skipping dispatch: conversation left ai_active during generation", {
        batchId: batch.id,
        conversationId: batch.conversation_id,
        state: liveConv.state,
      });
      await markBatchProcessed(batch.id, mergedText, supabase);
      return { processed: true, conversationId: batch.conversation_id };
    }

    // ── 10a. Dispatch via single exit point (SEC-04) ────────────────────────
    const dispatchResult = await dispatchText({
      workspaceId: batch.workspace_id,
      conversationId: batch.conversation_id,
      body: reply.text,
      // AI-generated: no senderUserId
    });

    if (!dispatchResult.ok) {
      if (dispatchResult.retryable) {
        // Un fallo transitorio de Kapso terminaba acá
        // con el batch marcado como procesado — el LLM pagado, nada enviado y
        // sin reintento. Lanzar entrega el batch al camino de retry/backoff de
        // más abajo, que lo reencola con retry_count+1 y lo manda a
        // dead-letter tras MAX_BATCH_RETRIES. El turno del LLM se regenera en
        // el reintento; ese es el precio aceptado de no perder la respuesta al
        // cliente.
        throw new Error(
          `dispatchText failed (retryable): ${dispatchResult.error ?? "unknown"}`,
        );
      }
      // Fallo permanente (número inválido, ventana vencida, cuenta
      // restringida): dispatch ya guardó el mensaje como 'failed' en el inbox
      // con un motivo legible. No hay nada que reintentar.
      console.error("[buffer] dispatchText failed (permanent):", dispatchResult.error);
    }

    // ── 10b. Mark batch as processed ────────────────────────────────────────
    await markBatchProcessed(batch.id, mergedText, supabase);

    // ── 10c. v1.5 opt-in: AI auto-tagging + summary (fire-and-forget) ────────
    if (
      activeAgent &&
      (activeAgent.config.autoTag || activeAgent.config.summarize)
    ) {
      void maybeAutoProcess({
        workspaceId: batch.workspace_id,
        conversationId: batch.conversation_id,
        contactId: conversation.contact_id as string,
        config: activeAgent.config,
      });
    }

    // ── 10d. F1: Setter qualification (only when the active agent is a setter) ─
    // The user-facing reply was already dispatched above, so this adds no latency
    // to the turn. We AWAIT it (not fire-and-forget) so the post_action reliably
    // runs even if the serverless function is frozen right after the batch. It is
    // fully try/catched internally and never throws into the batch path. Dormant
    // unless an enabled setter_config exists for the workspace.
    if (activeAgent?.type === "setter") {
      await runSetterEvaluation({
        workspaceId: batch.workspace_id,
        conversationId: batch.conversation_id,
        contactId: conversation.contact_id as string,
        history,
        mergedText,
      });
    }

    return { processed: true, conversationId: batch.conversation_id };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[buffer] processNextBatch error:", {
      batchId: batch.id,
      retryCount,
      error: errorMsg,
    });

    // ── 10. Dead-letter: increment retry or cancel ───────────────────────────
    const newRetryCount = retryCount + 1;

    if (newRetryCount > MAX_BATCH_RETRIES) {
      // Mark dead-letter via RPC
      await supabase.rpc("cancel_batch", { p_batch_id: batch.id });

      // Log to events table for observability
      await supabase.from("events").insert({
        type: "batch_dead_letter",
        level: "error",
        workspace_id: batch.workspace_id,
        conversation_id: batch.conversation_id,
        payload: {
          batch_id: batch.id,
          retry_count: newRetryCount,
          error: errorMsg,
        },
      });

      return {
        processed: false,
        conversationId: batch.conversation_id,
        error: `Batch cancelled after ${MAX_BATCH_RETRIES} retries: ${errorMsg}`,
      };
    }

    // Revert to 'buffering' with incremented retry count so it gets picked up again
    // Use a short backoff: flush_at = now + 30s * retry_count
    //
    // Known limitation (accepted): un batch aislado por
    // reconcileOrphanedMessages (forceNewBatch:true) que falla acá pierde su
    // aislación al volver a 'buffering' — este UPDATE no marca de ninguna
    // forma que el batch es "isolated", así que un mensaje real que llegue
    // durante el backoff puede volver a pegársele (mismo bug original, vía
    // el camino de retry en vez del de creación). Requiere un pipeline error
    // real en la ventana exacta del backoff sobre un batch que además viene
    // de un huérfano reconciliado — compuesto y poco frecuente. Fix
    // propuesto y no implementado: persistir `meta.isolated = true` al crear
    // el batch con forceNewBatch, y excluirlo también en el match normal de
    // upsert_batch_and_link_message (20260825000000), ya que meta sobrevive
    // el spread de este mismo UPDATE.
    const backoffMs = 30_000 * newRetryCount;
    await supabase
      .from("message_batches")
      .update({
        status: "buffering",
        flush_at: new Date(Date.now() + backoffMs).toISOString(),
        updated_at: new Date().toISOString(),
        meta: {
          ...batch.meta,
          retry_count: newRetryCount,
          last_error: errorMsg,
        },
      })
      .eq("id", batch.id)
      .eq("status", "processing");

    return {
      processed: false,
      conversationId: batch.conversation_id,
      error: errorMsg,
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// markBatchProcessed (private)
// Sets status = 'processed' and persists the merged_text for audit.
// ──────────────────────────────────────────────────────────────────────────────
async function markBatchProcessed(
  batchId: string,
  mergedText: string,
  supabase: ReturnType<typeof svc>,
): Promise<void> {
  const { error } = await supabase
    .from("message_batches")
    .update({
      status: "processed",
      merged_text: mergedText,
      updated_at: new Date().toISOString(),
    })
    .eq("id", batchId);

  if (error) {
    console.error("[buffer] markBatchProcessed error:", error);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// F1: Setter qualification (private, fire-and-forget)
// Scores the lead with the setter engine and, on qualification, runs the
// configured post_action. Only invoked when the active agent is a setter.
// Dormant unless an enabled setter_config exists. Never throws into the batch
// path — all failures are caught and logged as events.
// ──────────────────────────────────────────────────────────────────────────────

interface SetterEvalParams {
  workspaceId: string;
  conversationId: string;
  contactId: string;
  history: ConversationTurn[];
  mergedText: string;
}

async function runSetterEvaluation(params: SetterEvalParams): Promise<void> {
  const { workspaceId, conversationId, contactId, history, mergedText } =
    params;
  const supabase = svc();

  try {
    const cfg = await getSetterConfig(workspaceId);
    if (!cfg) return; // no enabled setter config → dormant

    // Load contact for the idempotency guard + tag merge in one read.
    const { data: contactRow, error: contactError } = await supabase
      .from("contacts")
      .select("tags, custom_fields, stage")
      .eq("id", contactId)
      .maybeSingle();

    if (contactError) {
      throw new Error(
        `[buffer] runSetterEvaluation contact lookup error: ${contactError.message}`,
      );
    }

    const customFields =
      (contactRow?.custom_fields as Record<string, unknown> | null) ?? {};

    // Idempotency: stop re-evaluating once the lead reached a terminal outcome.
    if (
      customFields.lead_qualified === true ||
      customFields.setter_knocked_out === true
    ) {
      return;
    }

    // Cost debounce: re-evaluate at most every 2 user turns (always the first
    // time). Bounds setter LLM spend on chatty leads that haven't qualified yet
    // — the setter path is not gated by the main reply's rate/cost limits.
    const userTurns = history.filter((t) => t.role === "user").length + 1;
    const lastEvalTurns =
      typeof customFields.setter_eval_turns === "number"
        ? customFields.setter_eval_turns
        : 0;
    if (lastEvalTurns > 0 && userTurns - lastEvalTurns < 2) return;

    // Build the transcript string from the already-loaded history + current turn.
    const transcript =
      history.map((t) => `${t.role}: ${t.content}`).join("\n") +
      `\nuser: ${mergedText}`;

    const evaluation = await evaluateLead(cfg, transcript);

    // Persist score/qualified/summary on the contact (no migration needed).
    const nextCustomFields = {
      ...customFields,
      lead_score: evaluation.score,
      lead_qualified: evaluation.qualified,
      lead_summary: evaluation.summary,
      setter_knocked_out: evaluation.knocked_out,
      setter_knockout_reason: evaluation.knockout_reason ?? null,
      setter_config_id: cfg.id,
      setter_evaluated_at: new Date().toISOString(),
      setter_eval_turns: userTurns,
    };

    const update: Record<string, unknown> = { custom_fields: nextCustomFields };
    // Move the CRM stage on a terminal outcome — but never downgrade a customer.
    const currentStage = contactRow?.stage as string | undefined;
    if (currentStage !== "customer") {
      if (evaluation.knocked_out) update.stage = "lost";
      else if (evaluation.qualified) update.stage = "qualified";
    }
    await supabase.from("contacts").update(update).eq("id", contactId);

    // Observability event (surfaces in the conversation timeline).
    await supabase.from("events").insert({
      type: "setter_evaluation",
      level: evaluation.knocked_out ? "warn" : "info",
      workspace_id: workspaceId,
      conversation_id: conversationId,
      payload: {
        score: evaluation.score,
        qualified: evaluation.qualified,
        knocked_out: evaluation.knocked_out,
        knockout_reason: evaluation.knockout_reason ?? null,
        summary: evaluation.summary,
        config_id: cfg.id,
        contact_id: contactId,
        post_action_type: (cfg.post_action as { type?: string }).type ?? null,
      },
    });

    // Execute the post_action only for a qualified lead (the configured "win"
    // action). Knocked-out leads are marked 'lost' above; we do not fire the
    // qualify-action on them.
    if (evaluation.qualified) {
      await executeSetterPostAction({
        postAction: cfg.post_action,
        workspaceId,
        conversationId,
        contactId,
        existingTags: Array.isArray(contactRow?.tags)
          ? (contactRow.tags as string[])
          : [],
        supabase,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[buffer] runSetterEvaluation error:", msg);
    await supabase
      .from("events")
      .insert({
        type: "setter_evaluation",
        level: "error",
        workspace_id: workspaceId,
        conversation_id: conversationId,
        payload: { error: msg, contact_id: contactId },
      })
      .then(
        () => {},
        () => {},
      );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// executeSetterPostAction (private)
// Runs the configured post_action for a qualified lead. Reuses existing
// executors; create_hl_opportunity is stubbed (logs a pending event) until HL
// pipeline/stage config exists.
// ──────────────────────────────────────────────────────────────────────────────

interface PostActionParams {
  postAction: Record<string, unknown>;
  workspaceId: string;
  conversationId: string;
  contactId: string;
  existingTags: string[];
  supabase: ReturnType<typeof svc>;
}

async function executeSetterPostAction(p: PostActionParams): Promise<void> {
  const type = typeof p.postAction.type === "string" ? p.postAction.type : null;
  if (!type) return;

  try {
    switch (type) {
      case "handoff": {
        // handoff_pending sets ai_enabled=false; only valid from ai_active.
        try {
          await applyTransition(p.conversationId, "handoff_pending", {
            trigger: "agent",
          });
        } catch (e) {
          console.warn(
            "[setter] handoff skipped:",
            e instanceof Error ? e.message : e,
          );
        }
        break;
      }

      case "add_tag": {
        const tag =
          typeof p.postAction.tag === "string" ? p.postAction.tag.trim() : "";
        if (!tag) break;
        const merged = Array.from(new Set([...p.existingTags, tag]));
        await p.supabase
          .from("contacts")
          .update({ tags: merged })
          .eq("id", p.contactId);
        // Best-effort push to HighLevel (no-op if HL not connected).
        void syncContactToHL(p.workspaceId, p.contactId);
        break;
      }

      case "send_template": {
        const templateName =
          typeof p.postAction.template_name === "string"
            ? p.postAction.template_name
            : "";
        if (!templateName) break;
        await dispatchTemplate({
          workspaceId: p.workspaceId,
          conversationId: p.conversationId,
          templateName,
          templateLanguage: "es",
        });
        break;
      }

      case "create_hl_opportunity": {
        // Creates the opportunity in the workspace's configured HL pipeline/stage.
        // Returns null when HL isn't connected or pipeline/stage is unconfigured.
        const result = await createHLOpportunity(p.workspaceId, p.contactId);
        await p.supabase.from("events").insert({
          type: result ? "setter_post_action" : "setter_post_action_failed",
          level: result ? "info" : "warn",
          workspace_id: p.workspaceId,
          conversation_id: p.conversationId,
          payload: {
            action: "create_hl_opportunity",
            contact_id: p.contactId,
            ...(result
              ? { opportunity_id: result.id }
              : {
                  reason:
                    "no se pudo crear la oportunidad (revisa PIT, pipeline y etapa de HighLevel)",
                }),
          },
        });
        break;
      }
    }
  } catch (err) {
    console.error(
      "[setter] post_action error:",
      err instanceof Error ? err.message : err,
    );
  }
}
