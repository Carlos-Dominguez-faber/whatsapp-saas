import { createClient as createSbClient } from "@supabase/supabase-js";
import { generateWithTools, getWorkspaceModel } from "./openrouter";
import { recordLlmUsage, checkRateLimits } from "./cost-tracker";
import {
  isMissingFunctionError,
  reportMissingFunctionOnce,
} from "@/shared/lib/db-errors";
import { dispatchText, dispatchTemplate } from "./dispatch";
import { decide, applyTransition } from "./decision-engine";
import {
  applyJevToBatch,
  type JevBatchEffect,
} from "@/features/jev-judge/apply";
import { enforceModelPolicy } from "./model-policy";
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
import {
  loadWhatsAppSettings,
  WHATSAPP_NOT_CONNECTED,
} from "./whatsapp-provider";

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
// Creates a new buffering batch for a conversation, or extends an existing one
// — atomically, via upsert_batch_and_link_message(): extending/creating the
// batch and linking the message happen in the SAME transaction, so no
// claim_next_batch() call can consolidate the batch between the two writes and
// miss the message. Returns the batch ID.
// ──────────────────────────────────────────────────────────────────────────────
export async function upsertBatch(
  opts: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    silenceMs?: number;
    /** Skip joining any in-flight batch — always create a standalone one.
     * Only reconcileOrphanedMessages sets this: a revived orphan is, by
     * definition, unrelated to whatever else is buffering right now. */
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

    // Code deployed before `db-push`: keep batching the old way instead of
    // failing every inbound message (which would silence the agent).
    if (isMissingFunctionError(error, "upsert_batch_and_link_message")) {
      reportMissingFunctionOnce(
        "upsert_batch_and_link_message",
        "batching with two separate writes",
      );
      return upsertBatchLegacy(supabase, {
        workspaceId,
        conversationId,
        messageId,
        silenceMs,
      });
    }

    lastError = error;
    // A fixed wait covers a transient blip, not a service outage.
    if (attempt < attempts - 1) await sleep(delayMs);
  }

  console.error(
    "[buffer] upsert_batch_and_link_message RPC error after retries:",
    lastError,
  );
  throw new Error(`Failed to upsert batch: ${lastError?.message}`);
}

/**
 * The pre-RPC path: two writes, not atomic. Only used until the migration
 * that creates upsert_batch_and_link_message() is applied.
 */
async function upsertBatchLegacy(
  supabase: ReturnType<typeof svc>,
  opts: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    silenceMs: number;
  },
): Promise<string> {
  const { workspaceId, conversationId, messageId, silenceMs } = opts;

  // 1. Look for an active buffering batch for this conversation
  const { data: existing } = await supabase
    .from("message_batches")
    .select("id, message_count, flush_at")
    .eq("workspace_id", workspaceId)
    .eq("conversation_id", conversationId)
    .eq("status", "buffering")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let batchId: string;

  if (existing) {
    // Extend: push flush_at forward and increment count
    const newFlushAt = new Date(Date.now() + silenceMs).toISOString();
    const { error: updateError } = await supabase
      .from("message_batches")
      .update({
        flush_at: newFlushAt,
        message_count: existing.message_count + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id)
      .eq("status", "buffering"); // Guard: only extend if still buffering

    if (updateError) {
      console.error("[buffer] extend batch error:", updateError);
      throw new Error(`Failed to extend batch: ${updateError.message}`);
    }

    batchId = existing.id as string;
  } else {
    // Create a new buffering batch
    const flushAt = new Date(Date.now() + silenceMs).toISOString();
    const { data: created, error: insertError } = await supabase
      .from("message_batches")
      .insert({
        workspace_id: workspaceId,
        conversation_id: conversationId,
        status: "buffering",
        silence_ms: silenceMs,
        flush_at: flushAt,
        message_count: 1,
        meta: {},
      })
      .select("id")
      .single();

    if (insertError || !created) {
      console.error("[buffer] create batch error:", insertError);
      throw new Error(`Failed to create batch: ${insertError?.message}`);
    }

    batchId = created.id as string;
  }

  // 2. Link the message to the batch
  const { error: linkError } = await supabase
    .from("messages")
    .update({ batch_id: batchId })
    .eq("id", messageId)
    .eq("workspace_id", workspaceId);

  if (linkError) {
    // Non-fatal: batch still works; log and continue
    console.warn("[buffer] failed to link message to batch:", linkError);
  }

  return batchId;
}

// More than enough for upsertBatch's 3 attempts (~1 s) to have settled.
const ORPHAN_MESSAGE_AGE_MS = 2 * 60_000;
const MAX_ORPHANS_PER_RUN = 20;
// Anything older is history, not a transient failure: without this bound,
// re-enabling the AI days later would answer the whole backlog one message at
// a time (every inbound the webhook left unbatched on purpose — AI off, rate
// limited — would qualify).
const ORPHAN_MESSAGE_MAX_AGE_MS = 15 * 60_000;

// ──────────────────────────────────────────────────────────────────────────────
// reconcileOrphanedMessages (exported)
// Safety net for what upsertBatch()'s retries don't close: an inbound message
// whose link kept failing. The provider dedupes its redelivery by wamid, so
// once the row exists it never reaches upsertBatch() again — it would keep
// batch_id NULL forever and never get an answer. The buffer-flush cron calls
// this every minute, before draining batches.
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

  // `!inner` + the embedded filter drop AI-off conversations server-side, so
  // they don't use up the LIMIT.
  const { data, error } = await supabase
    .from("messages")
    .select(
      "id, workspace_id, conversation_id, conversations!inner(ai_enabled, contact_id)",
    )
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
    // Re-check live, like the webhook did when the message arrived: AI off or
    // a rate-limited contact means the message stays unbatched on purpose.
    if (!row.conversations?.ai_enabled) continue;

    const rate = await checkRateLimits(
      row.workspace_id,
      row.conversations.contact_id,
    );
    if (!rate.allowed) continue;

    try {
      // An isolated batch flushed now: a revived orphan must never join an
      // unrelated new message, nor absorb one.
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
  batch: MessageBatch,
  supabase: ReturnType<typeof svc>,
): Promise<string> {
  const { data: msgs, error } = await supabase
    .from("messages")
    .select("id, body, meta, type, created_at")
    .eq("batch_id", batch.id)
    .eq("workspace_id", batch.workspace_id)
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
//   1. claim_next_batch() RPC — one batch per conversation at a time
//   2. No batch available → return { processed: false }
//   3. consolidateBatch → mergedText
//   4. Load conversation (ai_enabled, workspace_id, contact info)
//   5. A reply generated by an earlier attempt → just deliver it again
//   6. decide(): state, handoff keyword, atomic hourly reservation
//   7. Jev, WhatsApp provider, daily budget
//   8. generateWithTools + recordLlmUsage; the reply is saved on the batch
//   9. Deliver via the workspace's WhatsApp provider, mark 'processed'
//  10. On error: increment retry counter; if > MAX_BATCH_RETRIES → cancel_batch()
//
// Each step that must not be repeated leaves a checkpoint in the batch's meta
// (turn reservation, Jev verdict, generated reply), so a retry — or a stale
// batch reclaimed after its worker died — resumes instead of re-running the
// model and its tools (a second booking, a different reply).
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

  batch.meta = batch.meta ?? {};
  const retryCount = (batch.meta.retry_count as number | undefined) ?? 0;
  // The inbox shows a failed send once: on the attempt after which the batch
  // is dead-lettered, not on every retry that re-sends the same text.
  const isLastAttempt = retryCount >= MAX_BATCH_RETRIES;

  try {
    // ── 3. Consolidate messages into one string ──────────────────────────────
    const mergedText = await consolidateBatch(batch, supabase);

    // ── 4. Load conversation record ─────────────────────────────────────────
    const { data: conversation, error: convError } = await supabase
      .from("conversations")
      .select("id, workspace_id, contact_id, ai_enabled, summary")
      .eq("id", batch.conversation_id)
      .eq("workspace_id", batch.workspace_id)
      .single();

    if (convError || !conversation) {
      throw new Error(`Conversation not found: ${convError?.message}`);
    }

    // ── 5. A reply an earlier attempt already generated (and paid for) ──────
    const pendingReply =
      typeof batch.meta.pending_reply === "string"
        ? batch.meta.pending_reply
        : null;
    if (pendingReply) {
      await deliverReply(supabase, batch, mergedText, pendingReply, isLastAttempt);
      return { processed: true, conversationId: batch.conversation_id };
    }

    // ── 6. Decision engine: state check + handoff trigger + rate limits ──────
    // A retry reuses the turn slot its first attempt reserved, so failing and
    // retrying never costs a second slot.
    const priorReservationId =
      typeof batch.meta.llm_reservation_id === "string"
        ? batch.meta.llm_reservation_id
        : undefined;
    const decisionResult = await decide({
      workspaceId: batch.workspace_id,
      conversationId: batch.conversation_id,
      mergedText,
      contactId: conversation.contact_id as string,
      reservationId: priorReservationId,
    });

    const { decision, reason } = decisionResult;

    if (decision !== "respond") {
      console.info("[buffer] not responding:", decision, reason);
      await markBatchProcessed(batch, mergedText, supabase);
      return { processed: true, conversationId: batch.conversation_id };
    }

    if (decisionResult.reservationId) {
      batch.meta = {
        ...batch.meta,
        llm_reservation_id: decisionResult.reservationId,
      };
    }

    // ── 7a. Jev, before the workspace's own checks ─────────────────────────
    // Jev runs on the platform key, outside the workspace budget, and may hand
    // the conversation to a person or suppress the reply — which must keep
    // working on a day the budget is spent, and needs no WhatsApp provider.
    // A retry reuses the verdict of its first attempt instead of judging again.
    // A failure falls through to the existing reply. It never downgrades customer.
    const cachedJev = batch.meta.jev_verdict;
    const jev: JevBatchEffect = isJevVerdict(cachedJev)
      ? cachedJev
      : await applyJevToBatch(supabase, {
          workspaceId: batch.workspace_id,
          conversationId: batch.conversation_id,
          contactId: conversation.contact_id as string,
          mergedText,
        });
    if (jev.suppressReply) {
      await markBatchProcessed(batch, mergedText, supabase);
      return { processed: true, conversationId: batch.conversation_id };
    }
    batch.meta = { ...batch.meta, jev_verdict: jev };
    // Checkpoint: a worker that dies from here on leaves the reservation and
    // the verdict for the attempt that reclaims the batch.
    await saveBatchMeta(supabase, batch);

    // ── 7b. The workspace must have an active WhatsApp provider ─────────────
    // Checked before the model and its tools run: a reply with nowhere to go
    // must not repeat model spend or tool side effects on every attempt.
    // dispatchText() loads and decrypts the credentials itself.
    const whatsapp = await loadWhatsAppSettings(supabase, batch.workspace_id);
    if (!whatsapp) {
      throw new Error(`[buffer] ${WHATSAPP_NOT_CONNECTED}`);
    }

    // ── 7c. SEC-06: daily budget, before the KB search and the model ────────
    // A cut workspace must not pay for KB embeddings either. A database error
    // throws into the retry path below.
    const costPolicy = await enforceCostPolicy(batch.workspace_id);
    if (costPolicy.policy === "cut") {
      console.warn(
        "[buffer] SEC-06 cost cut — aborting AI for workspace",
        batch.workspace_id,
      );
      // Opt-in: hand the thread to a person instead of leaving the customer
      // without a reply until tomorrow. Off by default — a handoff doesn't
      // come back to the AI by itself when the budget resets.
      if (
        (whatsapp.config as { cost_cut_handoff?: boolean }).cost_cut_handoff ===
        true
      ) {
        try {
          await applyTransition(batch.conversation_id, "handoff_pending", {
            trigger: "cost_cut",
            workspaceId: batch.workspace_id,
          });
        } catch (transitionErr) {
          console.error("[buffer] cost-cut handoff failed:", {
            conversationId: batch.conversation_id,
            error:
              transitionErr instanceof Error
                ? transitionErr.message
                : String(transitionErr),
          });
        }
      }
      await markBatchProcessed(batch, mergedText, supabase);
      return { processed: true, conversationId: batch.conversation_id };
    }

    // ── 8a. Build ToolContext (SEC-01: anchored server-side, never from client) ─
    const toolCtx: ToolContext = {
      workspaceId: batch.workspace_id,
      conversationId: batch.conversation_id,
      contactId: conversation.contact_id as string,
    };

    // ── 8b. Resolve conversational memory window (WS2: configurable) ─────────
    // The workspace's WhatsApp integration config carries
    // message_history_window; clamp to [5, 50] and default to 10 when unset or
    // non-numeric.
    const rawWindow = Number(
      (whatsapp.config as { message_history_window?: number })
        .message_history_window,
    );
    const historyWindow = Number.isFinite(rawWindow)
      ? Math.min(50, Math.max(5, rawWindow))
      : 10;

    // ── 8c. Load prior conversation turns (WS1: memory injection) ────────────
    const history = await getConversationHistory(batch.conversation_id, {
      limit: historyWindow,
      excludeBatchId: batch.id,
      workspaceId: batch.workspace_id,
    });

    // ── 8d. Build system prompt: KB > custom prompt > business info (F7) ─────
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

    // ── 8e. SEC-06: a degraded budget keeps the prompt, switches the model ──
    const { systemPrompt: finalSystemPrompt, model: costModel } =
      await buildCostAwareSystemPrompt(
        batch.workspace_id,
        fullSystemPrompt,
        costPolicy.policy,
      );

    // ── 8f. Generate AI reply with tool-calling support ─────────────────────
    // Resolve workspace model (falls back to env default or gpt-4o-mini).
    // costModel from SEC-06 takes priority when cost policy is degraded.
    // On the platform key a model outside the catalog is swapped for the
    // platform default, however it got saved (enforceModelPolicy).
    const workspaceModel = await getWorkspaceModel(batch.workspace_id);
    const model =
      costModel ??
      (await enforceModelPolicy(
        supabase,
        batch.workspace_id,
        workspaceModel,
        "agent_turn",
      ));

    const reply = await generateWithTools({
      systemPrompt: finalSystemPrompt,
      model,
      userMessage: mergedText,
      workspaceId: batch.workspace_id,
      availableTools: decisionResult.availableTools,
      toolContext: toolCtx,
      history,
    });

    // ── 8g. Record LLM usage — BEFORE judging the reply: an empty reply was
    // paid for too. A failure here must not re-queue the batch: the model was
    // already paid, and the retry would call it again. recordLlmUsage retries
    // the write itself; if it still fails, log and deliver the reply.
    try {
      await recordLlmUsage({
        // Fill in the slot decide() reserved instead of inserting a second row:
        // both would count toward the contact's hourly limit.
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
    // The slot now holds this attempt's spend. Should a later step throw, the
    // retry's model call is new spend: it reserves and records its own row
    // instead of overwriting this one.
    if ("llm_reservation_id" in batch.meta) {
      const { llm_reservation_id: _recorded, ...rest } = batch.meta;
      batch.meta = rest;
    }

    // ── 8h. An empty reply ───────────────────────────────────────────────────
    // A turn that spends every step on tool calls comes back with no text.
    // With no tool run, regenerating is harmless: throw into the retry path.
    // After a tool ran (a booking, a CRM write), regenerating would run it
    // again, so a person takes over instead.
    if (!reply.text.trim()) {
      if (reply.toolCallsExecuted === 0) {
        throw new Error("LLM returned an empty reply");
      }
      console.warn("[buffer] empty reply after tool calls — handing off", {
        batchId: batch.id,
        toolCalls: reply.toolCallsExecuted,
      });
      try {
        await applyTransition(batch.conversation_id, "handoff_pending", {
          trigger: "empty_reply",
          workspaceId: batch.workspace_id,
        });
      } catch (transitionErr) {
        console.error("[buffer] empty-reply handoff failed:", {
          conversationId: batch.conversation_id,
          error:
            transitionErr instanceof Error
              ? transitionErr.message
              : String(transitionErr),
        });
      }
      await markBatchProcessed(batch, mergedText, supabase);
      return { processed: true, conversationId: batch.conversation_id };
    }

    // ── 8i. Checkpoint the reply before sending it ──────────────────────────
    // From here on, any retry (or a reclaim after this worker dies) delivers
    // this same text instead of calling the model and its tools again.
    batch.meta = { ...batch.meta, pending_reply: reply.text };
    await saveBatchMeta(supabase, batch);

    // ── 9. Deliver it and close the batch ───────────────────────────────────
    const delivered = await deliverReply(
      supabase,
      batch,
      mergedText,
      reply.text,
      isLastAttempt,
    );
    if (!delivered) {
      return { processed: true, conversationId: batch.conversation_id };
    }

    // ── 9b. v1.5 opt-in: AI auto-tagging + summary (fire-and-forget) ─────────
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

    // ── 9c. F1: Setter qualification (only when the active agent is a setter) ─
    // The user-facing reply was already dispatched above, so this adds no latency
    // to the turn. We AWAIT it (not fire-and-forget) so the post_action reliably
    // runs even if the serverless function is frozen right after the batch. It is
    // fully try/catched internally and never throws into the batch path. Dormant
    // unless an enabled setter_config exists for the workspace.
    if (!jev.ownsStage && activeAgent?.type === "setter") {
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

    // Revert to 'buffering' with incremented retry count so it gets picked up
    // again, with a short backoff: flush_at = now + 30s * retry_count. The
    // meta keeps every checkpoint (reservation, Jev verdict, pending reply).
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
      .eq("workspace_id", batch.workspace_id)
      .eq("status", "processing");

    return {
      processed: false,
      conversationId: batch.conversation_id,
      error: errorMsg,
    };
  }
}

/**
 * Sends `text` as the AI reply for `batch` and closes the batch. Returns
 * false when nothing was sent on purpose (a person took the conversation
 * while the reply was being generated). Throws when WhatsApp didn't accept
 * the message and it is safe to send the same text again: the retry path
 * re-queues the batch, which still holds the text in `pending_reply`.
 */
async function deliverReply(
  supabase: ReturnType<typeof svc>,
  batch: MessageBatch,
  mergedText: string,
  text: string,
  isLastAttempt: boolean,
): Promise<boolean> {
  // The turn can take 10-20 s. If a human took the thread meanwhile (the
  // inbox "take", a Business App echo), replying would talk over them.
  // decide() checked before the turn; check again right before the send. A
  // failed re-check is logged and dispatches anyway: a blip must not leave
  // the customer without a reply.
  const { data: liveConv, error: liveErr } = await supabase
    .from("conversations")
    .select("state")
    .eq("id", batch.conversation_id)
    .eq("workspace_id", batch.workspace_id)
    .single();

  if (liveErr || !liveConv) {
    console.error("[buffer] live state re-check failed, dispatching anyway", {
      batchId: batch.id,
      error: liveErr?.message,
    });
  } else if (liveConv.state !== "ai_active") {
    console.info("[buffer] not sending: the conversation left ai_active", {
      batchId: batch.id,
      state: liveConv.state,
    });
    await markBatchProcessed(batch, mergedText, supabase);
    return false;
  }

  // ── Dispatch via single exit point (SEC-04) ──
  const dispatchResult = await dispatchText({
    workspaceId: batch.workspace_id,
    conversationId: batch.conversation_id,
    body: text,
    // AI-generated: no senderUserId
    recordRetryableFailure: isLastAttempt,
  });

  if (!dispatchResult.ok) {
    if (dispatchResult.retryable && !isLastAttempt) {
      // WhatsApp didn't accept it (rate limit): sending the same text again
      // can't duplicate it.
      throw new Error(`dispatchText not accepted: ${dispatchResult.error}`);
    }
    // Anything else — the number, the 24 h window, or a failure where the
    // message may have left — is final: dispatch stored it as 'failed' with
    // the reason for the team. Sending again could reach the customer twice.
    console.error("[buffer] dispatchText failed:", dispatchResult.errorCode);
  }

  await markBatchProcessed(batch, mergedText, supabase);
  return true;
}

/**
 * Persists the batch's meta while it is being processed. Best-effort: a
 * failed write only loses the checkpoint, and the retry path writes the whole
 * meta again anyway.
 */
async function saveBatchMeta(
  supabase: ReturnType<typeof svc>,
  batch: MessageBatch,
): Promise<void> {
  const { error } = await supabase
    .from("message_batches")
    .update({ meta: batch.meta, updated_at: new Date().toISOString() })
    .eq("id", batch.id)
    .eq("workspace_id", batch.workspace_id)
    .eq("status", "processing");
  if (error) {
    console.error("[buffer] batch checkpoint failed:", {
      batchId: batch.id,
      error: error.message,
    });
  }
}

function isJevVerdict(value: unknown): value is JevBatchEffect {
  const v = value as Partial<JevBatchEffect> | null | undefined;
  return (
    typeof v?.suppressReply === "boolean" && typeof v?.ownsStage === "boolean"
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// markBatchProcessed (private)
// Sets status = 'processed' and persists the merged_text for audit.
// ──────────────────────────────────────────────────────────────────────────────
async function markBatchProcessed(
  batch: MessageBatch,
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
    .eq("id", batch.id)
    .eq("workspace_id", batch.workspace_id);

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
    const { data: contactRow } = await supabase
      .from("contacts")
      .select("tags, custom_fields, stage")
      .eq("id", contactId)
      .maybeSingle();

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
