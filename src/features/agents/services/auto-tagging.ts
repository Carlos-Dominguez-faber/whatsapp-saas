import { createClient as svcClient } from "@supabase/supabase-js";
import { generateChatReply } from "@/features/inbox/services/openrouter";
import type { AgentConfig } from "@/features/agents/types";

// v1.5 backlog: opt-in AI auto-tagging + conversation summary. Runs
// fire-and-forget after a reply is dispatched, only when the active agent has
// config.autoTag / config.summarize enabled. Uses a cheap model.

const CHEAP_MODEL = "openai/gpt-4o-mini";

function svc() {
  return svcClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

/** Normalized controlled vocabulary from config, or null → free-form tags. */
function parseTaxonomy(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const items = raw
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.toLowerCase().trim())
    .filter(Boolean);
  return items.length > 0 ? Array.from(new Set(items)) : null;
}

function safeParseJson(text: string): Record<string, unknown> | null {
  try {
    const cleaned = text
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function maybeAutoProcess(opts: {
  workspaceId: string;
  conversationId: string;
  contactId: string;
  config: AgentConfig;
}): Promise<void> {
  const { workspaceId, conversationId, contactId, config } = opts;
  if (!config.autoTag && !config.summarize) return;

  try {
    const db = svc();

    const { data: msgs } = await db
      .from("messages")
      .select("direction, body, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(12);

    if (!msgs || msgs.length === 0) return;

    const transcript = (msgs as { direction: string; body: string }[])
      .slice()
      .reverse()
      .map((m) => `${m.direction === "in" ? "Cliente" : "Agente"}: ${m.body}`)
      .join("\n");

    const taxonomy = config.autoTag ? parseTaxonomy(config.tagTaxonomy) : null;

    const fields: string[] = [];
    if (config.autoTag)
      fields.push(
        taxonomy
          ? `- "tags": array de 1 a 3 etiquetas elegidas SOLO de esta lista: ${taxonomy.join(
              ", ",
            )}. Si el cliente preguntó por un tema importante que NO está en la lista, agrega ADEMÁS una etiqueta con el prefijo "nuevo:" (ej: "nuevo:encerado"). No inventes etiquetas fuera de la lista sin ese prefijo.`
          : '- "tags": array de 1 a 3 etiquetas cortas en minúsculas (ej: ["interesado","precio"]).',
      );
    if (config.summarize)
      fields.push('- "summary": resumen de la conversación en una sola frase.');

    const systemPrompt = `Analiza esta conversación de WhatsApp y responde SOLO con un objeto JSON válido con estos campos:\n${fields.join(
      "\n",
    )}\nNo incluyas texto fuera del JSON.`;

    const reply = await generateChatReply({
      model: CHEAP_MODEL,
      systemPrompt,
      messages: [{ role: "user", content: transcript }],
      maxOutputTokens: 200,
      workspaceId,
    });

    const parsed = safeParseJson(reply.text);
    if (!parsed) return;

    if (config.autoTag && Array.isArray(parsed.tags)) {
      const cleaned = parsed.tags
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.toLowerCase().trim())
        .filter(Boolean);
      // With a controlled vocabulary, drop hallucinated tags: keep only
      // list members (max 3) plus at most one "nuevo:" gap candidate.
      const newTags = taxonomy
        ? [
            ...cleaned.filter((t) => taxonomy.includes(t)).slice(0, 3),
            ...cleaned
              .filter((t) => t.startsWith("nuevo:") && t.length > "nuevo:".length)
              .slice(0, 1),
          ]
        : cleaned.slice(0, 3);
      if (newTags.length > 0) {
        const { data: contact } = await db
          .from("contacts")
          .select("tags")
          .eq("id", contactId)
          .maybeSingle();
        const existing = Array.isArray(contact?.tags)
          ? (contact?.tags as string[])
          : [];
        const merged = Array.from(new Set([...existing, ...newTags]));
        await db.from("contacts").update({ tags: merged }).eq("id", contactId);
      }
    }

    if (config.summarize && typeof parsed.summary === "string") {
      await db
        .from("conversations")
        .update({ summary: parsed.summary.slice(0, 500) })
        .eq("id", conversationId);
    }
  } catch (e) {
    console.error(
      "[auto-tagging] failed:",
      e instanceof Error ? e.message : String(e),
    );
  }
}
