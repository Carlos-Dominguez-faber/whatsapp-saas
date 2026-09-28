import { createClient as createSbClient } from "@supabase/supabase-js";
import { generateWithTools, getWorkspaceModel } from "./openrouter";
import { recordLlmUsage, checkRateLimits } from "./cost-tracker";
import {
  isMissingFunctionError,
  reportMissingFunctionOnce,
} from "@/shared/lib/db-errors";
import { dispatchText, dispatchTemplate } from "./dispatch";
import { UNCONFIRMED_SEND_ERROR } from "./whatsapp-errors";
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
import { workspaceSchedulingTimeZone } from "./scheduling-timezone";
import {
  loadWhatsAppSettings,
  WHATSAPP_NOT_CONNECTED,
} from "./whatsapp-provider";

const DEFAULT_SILENCE_MS = 30_000; // 30 seconds silence window
const MAX_BATCH_RETRIES = 3;

// Errors that happen the same way on every attempt: waiting doesn't help.
const EMPTY_REPLY_ERROR = "LLM returned an empty reply";
const CONVERSATION_NOT_FOUND = "Conversation not found";

/**
 * How long a failed batch waits before its next attempt. Anything that may be
 * an outage — a timeout, the model's or WhatsApp's provider failing or rate
 * limiting, the database — waits 1, 5 and then 15 minutes: a provider down for
 * a few minutes must not hand every busy conversation to a person (the dead
 * letter does, and each one then needs turning back on by hand). Known
 * deterministic failures keep the short backoff.
 */
const TRANSIENT_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];
const DETERMINISTIC_BACKOFF_MS = 30_000;

function isDeterministicError(errorMsg: string): boolean {
  return [WHATSAPP_NOT_CONNECTED, EMPTY_REPLY_ERROR, CONVERSATION_NOT_FOUND].some(
    (marker) => errorMsg.includes(marker),
  );
}

function retryBackoffMs(retry: number, errorMsg: string): number {
  if (isDeterministicError(errorMsg)) return DETERMINISTIC_BACKOFF_MS * retry;
  return TRANSIENT_BACKOFF_MS[
    Math.min(retry, TRANSIENT_BACKOFF_MS.length) - 1
  ];
}

// A batch whose reply went out but that couldn't be closed: its next attempt
// only finds the send and closes it.
const CLOSE_RETRY_MS = 30_000;

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
  /** The batch this call claimed, if any. */
  batchId?: string;
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
    // #9 shipped a 4-parameter version of the function; until the migration
    // replaces it, that one answers PGRST202 for our 5 parameters.
    if (
      isMissingFunctionError(error, "upsert_batch_and_link_message", {
        acceptOtherSignature: true,
      })
    ) {
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

  // 1. Look for the conversation's unclaimed batch — never an isolated one (a
  //    reconciled orphan's, or a retry whose reply is already decided)
  const { data: existing } = await supabase
    .from("message_batches")
    .select("id, message_count, flush_at")
    .eq("workspace_id", workspaceId)
    .eq("conversation_id", conversationId)
    .eq("status", "buffering")
    .not("meta", "cs", JSON.stringify({ isolated: true }))
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
    // Stored but not for answering (a reaction): never a turn.
    .not("meta", "cs", JSON.stringify({ no_reply: true }))
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
// Also returns the time of the batch's last message: the turn's history stops
// there.
// ──────────────────────────────────────────────────────────────────────────────
async function consolidateBatch(
  batch: MessageBatch,
  supabase: ReturnType<typeof svc>,
): Promise<{ text: string; lastMessageAt: string | undefined }> {
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

  const rows = (msgs ?? []) as BatchMessage[];
  const lines = rows.map((msg) => {
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

  return { text: lines.join("\n"), lastMessageAt: rows.at(-1)?.created_at };
}

// ──────────────────────────────────────────────────────────────────────────────
// Time budget
// ──────────────────────────────────────────────────────────────────────────────

/**
 * What one batch may need to finish, at worst: Jev (8 s), the KB embedding
 * (15 s), an LLM turn with tools (120 s, openrouter.ts) plus a tool still
 * running when it ends (10 s), the send (20 s) and a handoff acknowledgement,
 * plus the database writes around them. A caller with less than this left
 * must not claim a batch: a function killed mid-turn leaves it in
 * 'processing' for the 7-minute lease.
 */
export const CLAIM_RESERVE_MS = 180_000;

export function hasTimeToClaim(
  startedAtMs: number,
  maxDurationSeconds: number,
  now: number = Date.now(),
): boolean {
  return now - startedAtMs < maxDurationSeconds * 1000 - CLAIM_RESERVE_MS;
}

// ──────────────────────────────────────────────────────────────────────────────
// Checkpoints
// ──────────────────────────────────────────────────────────────────────────────

/**
 * What an attempt leaves in the batch's meta so the next one — a retry, or a
 * reclaim after the worker died — resumes instead of repeating it:
 * - llm_reservation_id: the contact's turn slot, reused, not taken again;
 * - jev_verdict: Jev isn't asked (nor paid) twice;
 * - write_tools_ran: a booking or CRM write already happened — never re-run;
 * - pending_reply: the reply is decided — only sent (again), never regenerated;
 * - pending_handoff: the agent asked for a person (handoff_human), or a
 *   scheduling tool left something a person must settle (tool_failed) —
 *   honored even if the turn fails before its reply is sent, and retried
 *   (handoff_attempts) when the handoff itself fails; reply_settled then
 *   says the reply already went out or never will, so it isn't dispatched
 *   again.
 * A batch that carries any of them is `isolated`: it can't absorb new
 * messages, which would never get an answer from a reply already decided.
 */
const CHECKPOINT_KEYS = [
  "llm_reservation_id",
  "jev_verdict",
  "write_tools_ran",
  "pending_reply",
  "pending_handoff",
] as const;

function hasCheckpoint(meta: Record<string, unknown>): boolean {
  return CHECKPOINT_KEYS.some((key) => meta[key] !== undefined);
}

interface WriteRun {
  /** Pairs the record saved before the tool ran with its outcome. */
  id?: string;
  name: string;
  /**
   * true: done. null: started and not known to have failed — still running,
   * threw or timed out — so it may have happened, and counts as done.
   */
  ok: true | null;
}

function writeRunsOf(meta: Record<string, unknown>): WriteRun[] {
  return Array.isArray(meta.write_tools_ran)
    ? (meta.write_tools_ran as WriteRun[])
    : [];
}

/** Reasons handoff_human accepts (see handoff-human.ts). */
const HANDOFF_REASONS = new Set(["customer_request", "agent_stuck"]);

/**
 * A write tool whose outcome is unknown, or one of these tools answering
 * `needs_human` (it failed and told the model a person will follow up): the
 * reply promises a person, so one is handed the conversation after it.
 */
const TOOL_FAILED = "tool_failed";
/** The same for a write outside scheduling (an n8n tool): a generic label. */
const WRITE_UNCONFIRMED = "write_unconfirmed";
const NEEDS_HUMAN_TOOLS = new Set(["schedule_highlevel", "cancel_highlevel", "reschedule_highlevel"]);

function needsHuman(execution: { name: string; ok: boolean | null; output?: unknown }): boolean {
  if (!NEEDS_HUMAN_TOOLS.has(execution.name) || execution.ok === true) return false;
  return (execution.output as { needs_human?: unknown } | null)?.needs_human === true;
}

/**
 * The reason of a handoff the agent asked for this turn with handoff_human,
 * if it did. Only that tool's own results count — a workspace's n8n tool
 * returning the same shape can't move the conversation — and a second call
 * in the same turn hands off once.
 */
function findHandoffReason(
  toolResults: { toolName: string; output: unknown }[] | undefined,
): string | null {
  for (const entry of toolResults ?? []) {
    if (entry.toolName !== "handoff_human") continue;
    const result = entry.output as { ok?: unknown; output?: unknown } | null;
    if (!result || result.ok !== true) continue;
    const output = result.output as { handoff?: unknown; reason?: unknown } | null;
    if (output?.handoff !== true) continue;
    if (typeof output.reason === "string" && HANDOFF_REASONS.has(output.reason)) {
      return output.reason;
    }
  }
  return null;
}

/** The reason in handoff_human's own output, when it asked for a person. */
function handoffReasonOf(output: unknown): string | null {
  const o = output as { handoff?: unknown; reason?: unknown } | null;
  return o?.handoff === true && typeof o.reason === "string" && HANDOFF_REASONS.has(o.reason)
    ? o.reason
    : null;
}

/** The handoff an earlier attempt (or this turn's tools) decided. */
function pendingHandoffOf(meta: Record<string, unknown>): string | null {
  const reason = meta.pending_handoff;
  return typeof reason === "string" &&
    (HANDOFF_REASONS.has(reason) || reason === TOOL_FAILED || reason === WRITE_UNCONFIRMED)
    ? reason
    : null;
}

function handoffAttemptsOf(meta: Record<string, unknown>): number {
  return typeof meta.handoff_attempts === "number" ? meta.handoff_attempts : 0;
}

// ──────────────────────────────────────────────────────────────────────────────
// processNextBatch (exported)
// Called by the cron job (/api/cron/buffer-flush) or the internal trigger.
//
// Flow:
//   1. claim_next_batch() RPC — the oldest unfinished batch of a conversation
//   2. No batch available → return { processed: false }
//   3. consolidateBatch → mergedText
//   4. Load conversation (ai_enabled, workspace_id, contact info)
//   5. What an earlier attempt left: a send (close), a reply (deliver it,
//      once), a write (hand off), or no retries left (dead letter)
//   6. decide(): state, handoff keyword, atomic hourly reservation
//   7. Jev, WhatsApp provider, daily budget
//   8. generateWithTools + recordLlmUsage; the reply is saved on the batch
//   9. Deliver via the workspace's WhatsApp provider, mark 'processed'
//  10. On error: re-queue (isolated), hand off, or dead-letter
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
  const done = (): ProcessBatchResult => ({
    processed: true,
    conversationId: batch.conversation_id,
    batchId: batch.id,
  });
  // The reply (if any) is settled; only the handoff failed and is retried.
  const requeued = (): ProcessBatchResult => ({
    processed: false,
    conversationId: batch.conversation_id,
    batchId: batch.id,
    error: "handoff failed; re-queued",
  });
  // Write tools this batch ran (any attempt). Recorded before each one runs
  // and updated when it returns — also when the turn fails right after.
  const writeRuns: WriteRun[] = [...writeRunsOf(batch.meta)];
  let mergedText = "";
  // Set once this attempt's reply went out (or failed for good): from then
  // on the batch only needs closing, never another reply nor a dead letter.
  const progress = { replySent: false };

  try {
    // ── 3. Consolidate messages into one string ──────────────────────────────
    const consolidated = await consolidateBatch(batch, supabase);
    mergedText = consolidated.text;

    // ── 4. Load conversation record ─────────────────────────────────────────
    const { data: conversation, error: convError } = await supabase
      .from("conversations")
      .select("id, workspace_id, contact_id, ai_enabled, summary")
      .eq("id", batch.conversation_id)
      .eq("workspace_id", batch.workspace_id)
      .single();

    if (convError || !conversation) {
      throw new Error(`${CONVERSATION_NOT_FOUND}: ${convError?.message}`);
    }

    // ── 5. What an earlier attempt left behind ─────────────────────────────
    const pendingReply =
      typeof batch.meta.pending_reply === "string"
        ? batch.meta.pending_reply
        : null;
    // Any retry may follow a send whose worker died before closing the batch
    // (a lost checkpoint included): never send twice.
    const pendingHandoff = pendingHandoffOf(batch.meta);
    const earlierSend =
      retryCount > 0 || pendingReply ? await settleEarlierSend(supabase, batch) : null;
    if (earlierSend) {
      progress.replySent = true;
      // The worker that sent the reply died before handing off (or the
      // handoff failed and was re-queued): do it now. A reply known to have
      // gone out needs no generic acknowledgement.
      if (pendingHandoff) {
        const outcome = await handOffOrRequeue(
          supabase,
          batch,
          `${earlierSend.delivered ? "tool" : "tool_unsent"}:${pendingHandoff}`,
          pendingHandoff,
          earlierSend.delivered ? "sent" : "unsent",
        );
        if (outcome === "requeued") return requeued();
      }
      await markBatchProcessed(batch, mergedText, supabase);
      return done();
    }

    // The reply was settled — sent, or blocked or failed for good — by an
    // attempt whose handoff then failed and was re-queued: only the handoff
    // is left. A blocked reply is never dispatched again.
    const replySettled = batch.meta.reply_settled;
    if (pendingHandoff && (replySettled === "sent" || replySettled === "unsent")) {
      progress.replySent = true;
      const outcome = await handOffOrRequeue(
        supabase,
        batch,
        `${replySettled === "sent" ? "tool" : "tool_unsent"}:${pendingHandoff}`,
        pendingHandoff,
        replySettled,
      );
      if (outcome === "requeued") return requeued();
      await markBatchProcessed(batch, mergedText, supabase);
      return done();
    }

    // A reply an earlier attempt already generated (and paid for).
    if (pendingReply) {
      const outcome = await deliverReply(
        supabase,
        batch,
        mergedText,
        pendingReply,
        isLastAttempt,
        progress,
        pendingHandoff,
      );
      await noteUnconfirmedWrites(supabase, batch, writeRuns);
      return outcome === "requeued" ? requeued() : done();
    }

    // A person was asked for and the turn died before its reply: hand off
    // now (with the generic acknowledgement) instead of running the turn
    // again, which could repeat a write.
    if (pendingHandoff) {
      await noteWritesBeforeHandoff(supabase, batch, writeRuns);
      const outcome = await handOffOrRequeue(
        supabase,
        batch,
        `tool_unsent:${pendingHandoff}`,
        pendingHandoff,
      );
      if (outcome === "requeued") return requeued();
      await markBatchProcessed(batch, mergedText, supabase);
      return done();
    }

    // A write tool ran and the turn never produced a reply: running the turn
    // again would repeat the write (a second booking). A person takes over.
    if (writeRuns.length > 0) {
      await handOffAfterWrite(supabase, batch, mergedText, writeRuns);
      return done();
    }

    // Reclaimed after its last attempt died too (claim_next_batch counts each
    // reclaim): nothing is run again — a person takes over.
    if (retryCount > MAX_BATCH_RETRIES) {
      const reason = "stale lease reclaimed too many times";
      await deadLetter(supabase, batch, reason, retryCount);
      return {
        processed: false,
        conversationId: batch.conversation_id,
        batchId: batch.id,
        error: `Batch cancelled after ${MAX_BATCH_RETRIES} retries: ${reason}`,
      };
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
      return done();
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
    // The verdict is saved on the batch before its side effects run, so a
    // retry reuses it instead of judging again.
    // A failure falls through to the existing reply. It never downgrades customer.
    const cachedJev = batch.meta.jev_verdict;
    const jev: JevBatchEffect = isJevVerdict(cachedJev)
      ? cachedJev
      : await applyJevToBatch(
          supabase,
          {
            workspaceId: batch.workspace_id,
            conversationId: batch.conversation_id,
            contactId: conversation.contact_id as string,
            mergedText,
          },
          {
            onVerdict: async (effect) => {
              batch.meta = { ...batch.meta, jev_verdict: effect };
              await saveBatchMeta(supabase, batch);
            },
          },
        );
    if (jev.suppressReply) {
      await markBatchProcessed(batch, mergedText, supabase);
      return done();
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
        await handOff(supabase, batch, "cost_cut");
      }
      await markBatchProcessed(batch, mergedText, supabase);
      return done();
    }

    // ── 8a. Build ToolContext (SEC-01: anchored server-side, never from client) ─
    const toolCtx: ToolContext = {
      workspaceId: batch.workspace_id,
      conversationId: batch.conversation_id,
      contactId: conversation.contact_id as string,
      batchId: batch.id,
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
    // Up to this batch's last message: a later batch's messages get their own
    // turn, and here they'd read as already said.
    const history = await getConversationHistory(batch.conversation_id, {
      limit: historyWindow,
      excludeBatchId: batch.id,
      workspaceId: batch.workspace_id,
      until: consolidated.lastMessageAt,
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
        // The KB is context, not the turn: a slow or failing search (its
        // embedding times out at 15 s) answers without it.
        searchKb(batch.workspace_id, mergedText, 3).catch((err: unknown) => {
          console.warn("[buffer] KB search failed, answering without it:", {
            batchId: batch.id,
            error: err instanceof Error ? err.message : String(err),
          });
          return [];
        }),
        listKbSourceLinks(batch.workspace_id),
      ]);

    const kbContext = [
      formatKbContext(kbResults),
      formatKbReferenceLinks(kbLinks),
    ]
      .filter(Boolean)
      .join("\n\n");
    const bizContext = buildBusinessInfoContext(businessInfo);
    // The scheduling tools' zone, so "today" and their dates agree.
    const timeZone = await workspaceSchedulingTimeZone(batch.workspace_id, businessInfo);
    const promptBase =
      resolvedPrompt?.body ??
      "Eres un asistente de WhatsApp. Responde de forma concisa y útil en español.";
    const structured = businessInfo?.structured as { name?: string } | null;
    // WS1: surface the rolling conversation summary so the model keeps long-term
    // context beyond the recent-message window.
    const summary =
      typeof conversation.summary === "string"
        ? conversation.summary.trim()
        : "";
    // Canonical assembly (shared with the test-chat playground) — includes the
    // response style, KB and the strict rules/restrictions guardrails.
    const fullSystemPrompt = buildSystemPrompt({
      nowContext: buildNowContext(timeZone),
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
      // A write is on record BEFORE it runs, so neither a failed turn, a
      // timeout that cuts it off mid-call, nor a reclaim runs it again. If
      // the record can't be saved the tool doesn't run and the turn fails
      // (nothing was written: the retry is safe).
      onToolStart: async (start) => {
        if (start.sensitivity !== "write") return;
        const run: WriteRun = { id: start.callId, name: start.name, ok: null };
        const before = batch.meta;
        batch.meta = { ...batch.meta, write_tools_ran: [...writeRuns, run] };
        try {
          await saveBatchMeta(supabase, batch, { required: true });
        } catch (err) {
          batch.meta = before;
          throw err;
        }
        writeRuns.push(run);
      },
      // Then its outcome. A write the tool itself reported as failed changed
      // nothing, so it no longer counts; otherwise it stays counted.
      onToolExecuted: async (execution) => {
        // handoff_human asked for a person: keep that even if the turn fails
        // before its farewell goes out.
        if (execution.name === "handoff_human" && execution.ok === true) {
          const reason = handoffReasonOf(execution.output);
          if (reason && batch.meta.pending_handoff === undefined) {
            batch.meta = { ...batch.meta, pending_handoff: reason };
            await saveBatchMeta(supabase, batch);
          }
          return;
        }
        // A scheduling tool that promised the customer a person.
        if (needsHuman(execution) && batch.meta.pending_handoff === undefined) {
          batch.meta = { ...batch.meta, pending_handoff: TOOL_FAILED };
          await saveBatchMeta(supabase, batch);
        }
        if (execution.sensitivity !== "write") return;
        const index = writeRuns.findIndex((w) => w.id === execution.callId);
        if (index < 0) return;
        if (execution.ok === false) writeRuns.splice(index, 1);
        else writeRuns[index] = { ...writeRuns[index], ok: execution.ok };
        batch.meta = { ...batch.meta, write_tools_ran: [...writeRuns] };
        await saveBatchMeta(supabase, batch);
      },
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
    // The slot now holds this attempt's spend: drop it from the checkpoint
    // right away, so a reclaim can't reuse it and overwrite those tokens.
    if ("llm_reservation_id" in batch.meta) {
      const { llm_reservation_id: _recorded, ...rest } = batch.meta;
      batch.meta = rest;
      await saveBatchMeta(supabase, batch);
    }

    // ── 8h. An empty reply ───────────────────────────────────────────────────
    // A turn that spends every step on tool calls comes back with no text.
    // With no write done, regenerating is harmless: throw into the retry path.
    // After a write that went through or may have (a booking, a CRM write),
    // regenerating would run it again, so a person takes over instead.
    // The agent asked for a person (handoff_human). The tool itself changes
    // nothing: the handoff happens after the farewell is sent, below, because
    // deliverReply doesn't send once the conversation left ai_active.
    // A write whose outcome is unknown (it threw, timed out, or never
    // reported back) was answered with "a person will confirm": one does.
    const unconfirmed = writeRuns.filter((w) => w.ok === null);
    if (batch.meta.pending_handoff === undefined && unconfirmed.length > 0) {
      batch.meta = {
        ...batch.meta,
        pending_handoff: unconfirmed.some((w) => NEEDS_HUMAN_TOOLS.has(w.name))
          ? TOOL_FAILED
          : WRITE_UNCONFIRMED,
      };
    }
    const handoffReason =
      findHandoffReason(reply.toolResults) ?? pendingHandoffOf(batch.meta);

    if (!reply.text.trim()) {
      // A person was asked for but there's no reply: hand off right away,
      // and the contact gets the generic acknowledgement instead.
      if (handoffReason) {
        await noteWritesBeforeHandoff(supabase, batch, writeRuns);
        batch.meta = { ...batch.meta, pending_handoff: handoffReason };
        const outcome = await handOffOrRequeue(
          supabase,
          batch,
          `tool_unsent:${handoffReason}`,
          handoffReason,
        );
        if (outcome === "requeued") return requeued();
        await markBatchProcessed(batch, mergedText, supabase);
        return done();
      }
      if (writeRuns.length === 0) {
        throw new Error(EMPTY_REPLY_ERROR);
      }
      await handOffAfterWrite(supabase, batch, mergedText, writeRuns, "empty_reply");
      return done();
    }

    // ── 8i. Checkpoint the reply before sending it ──────────────────────────
    // From here on, any retry (or a reclaim after this worker dies) delivers
    // this same text instead of calling the model and its tools again. Not
    // sent unless saved: a reply sent without its checkpoint could be
    // generated — and sent — again. A handoff the agent asked for travels
    // with it, so a retry hands off too.
    batch.meta = {
      ...batch.meta,
      pending_reply: reply.text,
      ...(handoffReason ? { pending_handoff: handoffReason } : {}),
    };
    await saveBatchMeta(supabase, batch, { required: true });

    // ── 9. Deliver it and close the batch ───────────────────────────────────
    const delivered = await deliverReply(
      supabase,
      batch,
      mergedText,
      reply.text,
      isLastAttempt,
      progress,
      handoffReason,
    );
    await noteUnconfirmedWrites(supabase, batch, writeRuns);
    if (delivered === "requeued") return requeued();
    if (delivered === "skipped") {
      return done();
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

    return done();
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[buffer] processNextBatch error:", {
      batchId: batch.id,
      retryCount,
      error: errorMsg,
    });

    // ── 10a. The reply went out; only closing the batch failed ──────────────
    // Not a failed attempt at answering: no dead letter (the contact has the
    // reply) and no retry counted. The next attempt finds the send and closes
    // the batch; if even this re-queue fails, the lease brings it back.
    if (progress.replySent) {
      await supabase
        .from("message_batches")
        .update({
          status: "buffering",
          flush_at: new Date(Date.now() + CLOSE_RETRY_MS).toISOString(),
          updated_at: new Date().toISOString(),
          meta: { ...batch.meta, isolated: true, last_error: errorMsg },
        })
        .eq("id", batch.id)
        .eq("workspace_id", batch.workspace_id)
        .eq("status", "processing");
      return {
        processed: false,
        conversationId: batch.conversation_id,
        batchId: batch.id,
        error: errorMsg,
      };
    }

    // ── 10b. A person was asked for and there's no reply to send ────────────
    // Re-queuing would run the turn again; the contact gets the generic
    // acknowledgement instead of the reply that was never written.
    const handoffAsked = pendingHandoffOf(batch.meta);
    if (handoffAsked && typeof batch.meta.pending_reply !== "string") {
      try {
        await noteWritesBeforeHandoff(supabase, batch, writeRuns);
        // Not reported yet: a failure falls through to the re-queue below,
        // which keeps pending_handoff, and the next attempt tries again.
        if (
          await handOff(supabase, batch, `tool_unsent:${handoffAsked}`, { reportFailure: false })
        ) {
          await markBatchProcessed(batch, mergedText, supabase);
          return { ...done(), error: errorMsg };
        }
      } catch (handoffErr) {
        console.error("[buffer] hand-off asked by the agent failed:", handoffErr);
      }
    }

    // ── 10c. A write already went through and there's no reply to send ──────
    // Re-queuing would run the turn — and the write — again. With a handoff
    // owed (10b failed), the re-queue below retries that instead: the next
    // attempt hands off before running anything.
    if (
      writeRuns.length > 0 &&
      !handoffAsked &&
      typeof batch.meta.pending_reply !== "string"
    ) {
      try {
        await handOffAfterWrite(supabase, batch, mergedText, writeRuns);
        return { ...done(), error: errorMsg };
      } catch (handoffErr) {
        console.error("[buffer] hand-off after a write failed:", handoffErr);
        // Fall through: the re-queued batch keeps write_tools_ran, and the
        // next attempt hands off before running anything.
      }
    }

    // ── 10d. Dead-letter: out of retries ────────────────────────────────────
    const newRetryCount = retryCount + 1;

    if (newRetryCount > MAX_BATCH_RETRIES) {
      await deadLetter(supabase, batch, errorMsg, newRetryCount);
      return {
        processed: false,
        conversationId: batch.conversation_id,
        batchId: batch.id,
        error: `Batch cancelled after ${MAX_BATCH_RETRIES} retries: ${errorMsg}`,
      };
    }

    // ── 10e. Re-queue, backing off (retryBackoffMs).
    // The meta keeps every checkpoint; a batch that carries one is isolated,
    // so new messages open their own batch (the claim serves this one first).
    const backoffMs = retryBackoffMs(newRetryCount, errorMsg);
    // A long outage stays quiet for ~20 minutes before the dead letter: the
    // first transient failure of a batch is an event the team can see now.
    if (newRetryCount === 1 && !isDeterministicError(errorMsg)) {
      await supabase
        .from("events")
        .insert({
          type: "batch_retry_transient",
          level: "warn",
          workspace_id: batch.workspace_id,
          conversation_id: batch.conversation_id,
          payload: {
            batch_id: batch.id,
            error: errorMsg,
            next_attempt_at: new Date(Date.now() + backoffMs).toISOString(),
          },
        })
        .then(
          () => {},
          () => {},
        );
    }
    await supabase
      .from("message_batches")
      .update({
        status: "buffering",
        flush_at: new Date(Date.now() + backoffMs).toISOString(),
        updated_at: new Date().toISOString(),
        meta: {
          ...batch.meta,
          ...(hasCheckpoint(batch.meta) ? { isolated: true } : {}),
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
      batchId: batch.id,
      error: errorMsg,
    };
  }
}

/**
 * Sends `text` as the AI reply for `batch` and closes the batch. Returns
 * "skipped" when nothing was sent on purpose (a person took the conversation
 * while the reply was being generated), and "requeued" when the reply went
 * out but the handoff after it failed and will be retried. Throws when
 * nothing left and it is safe to send the same text again: the retry path
 * re-queues the batch, which still holds the text in `pending_reply`.
 */
async function deliverReply(
  supabase: ReturnType<typeof svc>,
  batch: MessageBatch,
  mergedText: string,
  text: string,
  isLastAttempt: boolean,
  progress: { replySent: boolean },
  handoffReason: string | null = null,
): Promise<"sent" | "skipped" | "requeued"> {
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
    return "skipped";
  }

  // ── Dispatch via single exit point (SEC-04) ──
  const dispatchResult = await dispatchText({
    workspaceId: batch.workspace_id,
    conversationId: batch.conversation_id,
    body: text,
    // AI-generated: no senderUserId
    recordRetryableFailure: isLastAttempt,
    // A reply blocked by the 24h window or an opt-out stays visible.
    noteWhenBlocked: true,
    // Lets a retry see that this batch's reply already left.
    meta: { batch_id: batch.id },
  });

  if (!dispatchResult.ok) {
    if (dispatchResult.retryable && !isLastAttempt) {
      // Nothing left (a rate limit, or the database before the send):
      // sending the same text again can't duplicate it.
      throw new Error(`dispatchText not sent: ${dispatchResult.errorCode}`);
    }
    // Anything else — the number, the 24 h window, or a failure where the
    // message may have left — is final and visible in the thread. Sending
    // again could reach the customer twice.
    console.error("[buffer] dispatchText failed:", dispatchResult.errorCode);
  }

  progress.replySent = true;
  // A person was asked for: hand off now that the reply was sent (tool:, no
  // generic acknowledgement) or definitively wasn't (tool_unsent:, the
  // contact gets the acknowledgement). Before closing the batch, so a worker
  // that dies here leaves it to a retry that still hands off.
  if (handoffReason) {
    const outcome = await handOffOrRequeue(
      supabase,
      batch,
      dispatchResult.ok ? `tool:${handoffReason}` : `tool_unsent:${handoffReason}`,
      handoffReason,
      dispatchResult.ok ? "sent" : "unsent",
    );
    if (outcome === "requeued") return "requeued";
  }
  await markBatchProcessed(batch, mergedText, supabase);
  return "sent";
}

/**
 * True when this batch's reply was already sent (or definitively failed) by
 * an earlier attempt that died before closing the batch. A row still 'queued'
 * means that worker died mid-send: the message may or may not have left, so
 * it is marked failed for the team to check — never sent again. A row
 * WhatsApp did not accept (`meta.not_accepted`) is no send at all: skipped.
 */
async function settleEarlierSend(
  supabase: ReturnType<typeof svc>,
  batch: MessageBatch,
): Promise<{ delivered: boolean } | null> {
  const { data, error } = await supabase
    .from("messages")
    .select("id, status, meta")
    .eq("workspace_id", batch.workspace_id)
    .eq("conversation_id", batch.conversation_id)
    .eq("direction", "out")
    .contains("meta", { batch_id: batch.id })
    .not("meta", "cs", JSON.stringify({ not_accepted: true }))
    // The batch's internal notes carry its id too; they are no send.
    .not("meta", "cs", JSON.stringify({ internal: true }))
    .limit(1);
  if (error) {
    throw new Error(`[buffer] earlier-send lookup failed: ${error.message}`);
  }
  const row = (data ?? [])[0] as
    | { id: string; status: string; meta: Record<string, unknown> | null }
    | undefined;
  if (!row) return null;

  if (row.status === "queued" && row.meta?.dev_mode !== true) {
    await supabase
      .from("messages")
      .update({ status: "failed", error_message: UNCONFIRMED_SEND_ERROR })
      .eq("id", row.id)
      .eq("workspace_id", batch.workspace_id);
  }
  // Sent, delivered or read: the contact has it.
  return { delivered: ["sent", "delivered", "read"].includes(row.status) };
}

/**
 * Moves the conversation to a person through applyTransition — the path a
 * handoff keyword takes, so the contact's acknowledgement and the team's
 * notification fire too. Never throws. Returns true when the conversation is
 * with a person now, or no longer with the AI (a person took it: nothing to
 * do). Otherwise false, and unless `reportFailure` is off (the caller will
 * try again) the failure is left as an error event, a note in the thread and
 * the team's email, since the AI stays on.
 */
async function handOff(
  supabase: ReturnType<typeof svc>,
  batch: MessageBatch,
  trigger: string,
  opts: { reportFailure?: boolean } = {},
): Promise<boolean> {
  const transition = () =>
    applyTransition(batch.conversation_id, "handoff_pending", {
      trigger,
      workspaceId: batch.workspace_id,
    });
  const isSettled = (err: unknown) =>
    err instanceof Error && err.name === "TransitionError";
  try {
    try {
      await transition();
    } catch (firstErr) {
      if (isSettled(firstErr)) throw firstErr;
      // One more try: a blip must not leave the AI on a conversation that
      // needs a person.
      await transition();
    }
  } catch (transitionErr) {
    if (isSettled(transitionErr)) {
      return true;
    }
    const error =
      transitionErr instanceof Error ? transitionErr.message : String(transitionErr);
    console.error(`[buffer] ${trigger} handoff failed:`, {
      conversationId: batch.conversation_id,
      error,
      willRetry: opts.reportFailure === false,
    });
    if (opts.reportFailure === false) return false;
    await supabase
      .from("events")
      .insert({
        type: "handoff_failed",
        level: "error",
        workspace_id: batch.workspace_id,
        conversation_id: batch.conversation_id,
        payload: { batch_id: batch.id, trigger, error },
      })
      .then(
        () => {},
        () => {},
      );
    await addInternalNote(
      supabase,
      batch,
      "No se pudo pasar esta conversación a una persona: la IA sigue activa. Revísala tú.",
      "handoff_failed",
    );
    // And by email, where the workspace turned it on: the inbox shows no
    // waiting conversation, so the note alone may go unseen.
    try {
      const { notifyTeamHandoff } = await import("./team-notifier");
      await notifyTeamHandoff({
        workspaceId: batch.workspace_id,
        conversationId: batch.conversation_id,
        trigger: "handoff_failed",
      });
    } catch (notifyErr) {
      console.error("[buffer] handoff_failed email failed:", notifyErr);
    }
    return false;
  }
  return true;
}

/**
 * A handoff the batch owes (pending_handoff), with retries: when it fails
 * and attempts remain, the batch is re-queued with backoff, keeping
 * pending_handoff, and the failure is reported only on the last attempt.
 * `replySettled` records that this attempt's reply went out ("sent") or
 * never will ("unsent": blocked, or failed for good), so the retry only
 * hands off and never dispatches it again.
 */
async function handOffOrRequeue(
  supabase: ReturnType<typeof svc>,
  batch: MessageBatch,
  trigger: string,
  reason: string,
  replySettled?: "sent" | "unsent",
): Promise<"done" | "requeued"> {
  const attempt = handoffAttemptsOf(batch.meta) + 1;
  const canRetry = attempt <= MAX_BATCH_RETRIES;
  if (await handOff(supabase, batch, trigger, { reportFailure: !canRetry })) return "done";
  if (!canRetry) return "done";

  const { error } = await supabase
    .from("message_batches")
    .update({
      status: "buffering",
      flush_at: new Date(Date.now() + retryBackoffMs(attempt, "handoff failed")).toISOString(),
      updated_at: new Date().toISOString(),
      meta: {
        ...batch.meta,
        pending_handoff: reason,
        handoff_attempts: attempt,
        ...(replySettled ? { reply_settled: replySettled } : {}),
        isolated: true,
        last_error: `handoff failed (${trigger})`,
      },
    })
    .eq("id", batch.id)
    .eq("workspace_id", batch.workspace_id)
    .eq("status", "processing");
  if (error) {
    // Left 'processing': the lease brings it back, still owing the handoff.
    console.error("[buffer] re-queue for the handoff failed:", error.message);
  }
  return "requeued";
}

/**
 * A handoff that replaces handOffAfterWrite still tells the team a write
 * ran (a booking, a CRM write), so they check what was done.
 */
async function noteWritesBeforeHandoff(
  supabase: ReturnType<typeof svc>,
  batch: MessageBatch,
  writeRuns: WriteRun[],
): Promise<void> {
  if (writeRuns.length === 0) return;
  await addInternalNote(
    supabase,
    batch,
    `La IA ejecutó una acción (${[...new Set(writeRuns.map((w) => w.name))].join(", ")}) y la conversación pasa a una persona. Revisa qué quedó hecho.`,
    "write_tool_unfinished",
  );
}

/**
 * Leaves an internal note in the thread (never sent to the contact), so what
 * happened to the reply is visible where the team reads the conversation.
 * One per batch and reason: an attempt that runs again doesn't repeat it.
 */
async function addInternalNote(
  supabase: ReturnType<typeof svc>,
  batch: MessageBatch,
  body: string,
  reason: string,
): Promise<void> {
  const { data: existing } = await supabase
    .from("messages")
    .select("id")
    .eq("workspace_id", batch.workspace_id)
    .eq("conversation_id", batch.conversation_id)
    .contains("meta", { internal: true, batch_id: batch.id, reason })
    .limit(1);
  if ((existing ?? []).length > 0) return;

  const { error } = await supabase.from("messages").insert({
    workspace_id: batch.workspace_id,
    conversation_id: batch.conversation_id,
    direction: "out",
    type: "system",
    body,
    status: "sent",
    meta: { internal: true, batch_id: batch.id, reason },
  });
  if (error) {
    console.error("[buffer] internal note failed:", error.message);
  }
}

/**
 * A write whose outcome is unknown (it threw, timed out, or HighLevel didn't
 * confirm) and the agent still replied: the reply can't say what happened,
 * so a person is told to check. One note per batch.
 */
async function noteUnconfirmedWrites(
  supabase: ReturnType<typeof svc>,
  batch: MessageBatch,
  writeRuns: WriteRun[],
): Promise<void> {
  const unconfirmed = writeRuns.filter((w) => w.ok === null);
  if (unconfirmed.length === 0) return;
  const tools = [...new Set(unconfirmed.map((w) => w.name))].join(", ");
  await addInternalNote(
    supabase,
    batch,
    `La IA ejecutó una acción (${tools}) cuyo resultado no se pudo confirmar. Revisa qué quedó hecho.`,
    "write_tool_unfinished",
  );
}

/**
 * A write tool went through (or may have) and there is no reply to send.
 * Running the turn again would repeat the write, so a person takes over.
 */
async function handOffAfterWrite(
  supabase: ReturnType<typeof svc>,
  batch: MessageBatch,
  mergedText: string,
  writeRuns: WriteRun[],
  trigger: "write_tool_unfinished" | "empty_reply" = "write_tool_unfinished",
): Promise<void> {
  const tools = [...new Set(writeRuns.map((w) => w.name))].join(", ");
  console.warn("[buffer] a write tool ran but the turn didn't finish — handing off", {
    batchId: batch.id,
    tools,
    trigger,
  });
  await handOff(supabase, batch, trigger);
  await addInternalNote(
    supabase,
    batch,
    `La IA ejecutó una acción (${tools}) pero no pudo terminar su respuesta. Revisa qué quedó hecho y contesta tú.`,
    "write_tool_unfinished",
  );
  await markBatchProcessed(batch, mergedText, supabase);
}

/**
 * Out of retries. The customer has no reply, so besides the event a person
 * takes the conversation and the thread says why. The batch is cancelled
 * last: a worker that dies before that leaves it to be reclaimed and
 * dead-lettered again (the handoff and the note don't repeat), never
 * cancelled without anyone taking the conversation.
 */
async function deadLetter(
  supabase: ReturnType<typeof svc>,
  batch: MessageBatch,
  errorMsg: string,
  retryCount: number,
): Promise<void> {
  await handOff(supabase, batch, "batch_dead_letter");
  await addInternalNote(
    supabase,
    batch,
    "La IA no pudo responder a este mensaje después de varios intentos. Atiéndelo tú.",
    "batch_dead_letter",
  );

  await supabase.from("events").insert({
    type: "batch_dead_letter",
    level: "error",
    workspace_id: batch.workspace_id,
    conversation_id: batch.conversation_id,
    payload: {
      batch_id: batch.id,
      retry_count: retryCount,
      error: errorMsg,
    },
  });

  await supabase.rpc("cancel_batch", { p_batch_id: batch.id });
}

/**
 * Persists the batch's meta while it is being processed. A batch that carries
 * a checkpoint is marked isolated from here on. Best-effort by default: a
 * failed write only loses the checkpoint, and the retry path writes the whole
 * meta again. `required` throws instead — also when the batch is no longer
 * this worker's — for a checkpoint whose loss could repeat a write or a send.
 */
async function saveBatchMeta(
  supabase: ReturnType<typeof svc>,
  batch: MessageBatch,
  opts: { required?: boolean } = {},
): Promise<void> {
  if (hasCheckpoint(batch.meta)) {
    batch.meta = { ...batch.meta, isolated: true };
  }
  const { data, error } = await supabase
    .from("message_batches")
    .update({ meta: batch.meta, updated_at: new Date().toISOString() })
    .eq("id", batch.id)
    .eq("workspace_id", batch.workspace_id)
    .eq("status", "processing")
    .select("id");
  const saved = !error && (data ?? []).length > 0;
  if (saved) return;
  const reason = error?.message ?? "the batch is no longer processing";
  if (opts.required) {
    throw new Error(`[buffer] batch checkpoint not saved: ${reason}`);
  }
  console.error("[buffer] batch checkpoint failed:", {
    batchId: batch.id,
    error: reason,
  });
}

function isJevVerdict(value: unknown): value is JevBatchEffect {
  const v = value as Partial<JevBatchEffect> | null | undefined;
  return (
    typeof v?.suppressReply === "boolean" && typeof v?.ownsStage === "boolean"
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// markBatchProcessed (private)
// Sets status = 'processed' and persists the merged_text for audit. Retries,
// then throws: a batch left in 'processing' after its reply went out would be
// reclaimed, and only the earlier-send check stands between it and a second
// send — closing it for real is worth a few attempts.
// ──────────────────────────────────────────────────────────────────────────────
async function markBatchProcessed(
  batch: MessageBatch,
  mergedText: string,
  supabase: ReturnType<typeof svc>,
  attempts = 3,
): Promise<void> {
  let lastError: { message: string } | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const { error } = await supabase
      .from("message_batches")
      .update({
        status: "processed",
        merged_text: mergedText,
        updated_at: new Date().toISOString(),
      })
      .eq("id", batch.id)
      .eq("workspace_id", batch.workspace_id);
    if (!error) return;
    lastError = error;
    if (attempt < attempts - 1) {
      await new Promise<void>((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
  console.error("[buffer] markBatchProcessed error:", lastError);
  throw new Error(`[buffer] could not close batch ${batch.id}: ${lastError?.message}`);
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
