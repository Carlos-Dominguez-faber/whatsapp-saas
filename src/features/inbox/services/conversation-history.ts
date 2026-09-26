import { createClient as createSbClient } from "@supabase/supabase-js";

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
// Internal row shape
// ──────────────────────────────────────────────────────────────────────────────
interface HistoryRow {
  direction: "in" | "out";
  type: string;
  body: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
  batch_id: string | null;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// getConversationHistory
// Loads recent conversation turns for memory injection, in chronological order.
//
// excludeBatchId skips the in-flight inbound batch (whose messages are passed
// separately as the current user message) while still keeping previous outbound
// messages (batch_id null) and inbound messages from earlier batches.
//
// Internal messages (meta.internal === true) are filtered out, and so are
// failed sends: the customer never received them, and a retry that saw its own
// failed reply would answer "as I said…". Non-text media is rendered with a
// typed placeholder so the model knows something was sent.
// ──────────────────────────────────────────────────────────────────────────────
export async function getConversationHistory(
  conversationId: string,
  opts: {
    limit: number;
    excludeBatchId?: string;
    workspaceId?: string;
    /**
     * Only messages up to this instant: the current batch's last message.
     * Messages that arrived after it belong to a later batch and get their
     * own turn — here they would read as already said.
     */
    until?: string;
  },
): Promise<ConversationTurn[]> {
  const supabase = svc();

  let query = supabase
    .from("messages")
    .select("direction, type, body, meta, created_at, batch_id")
    .eq("conversation_id", conversationId)
    .or("status.is.null,status.neq.failed");

  if (opts.workspaceId) {
    query = query.eq("workspace_id", opts.workspaceId);
  }
  if (opts.until) {
    query = query.lte("created_at", opts.until);
  }

  if (opts.excludeBatchId) {
    query = query.or(`batch_id.is.null,batch_id.neq.${opts.excludeBatchId}`);
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(opts.limit);

  if (error || !data) {
    return [];
  }

  const rows = data as HistoryRow[];

  const turns = rows
    .filter((row) => {
      const meta = row.meta as Record<string, unknown> | null;
      return meta?.internal !== true;
    })
    .map((row): ConversationTurn => {
      const role: "user" | "assistant" =
        row.direction === "in" ? "user" : "assistant";
      const content = row.body || placeholderForType(row.type);
      return { role, content };
    });

  // Rows came back newest→oldest; reverse to chronological order.
  turns.reverse();

  return turns;
}

// ──────────────────────────────────────────────────────────────────────────────
// placeholderForType — typed fallback when a message has no text body
// ──────────────────────────────────────────────────────────────────────────────
function placeholderForType(type: string): string {
  switch (type) {
    case "audio":
      return "[audio]";
    case "image":
      return "[imagen]";
    case "document":
      return "[documento]";
    case "video":
      return "[video]";
    default:
      return "[multimedia]";
  }
}
