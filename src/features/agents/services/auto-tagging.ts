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

    const fields: string[] = [];
    if (config.autoTag)
      fields.push(
        '- "tags": array de 1 a 3 etiquetas cortas en minúsculas (ej: ["interesado","precio"]).',
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
      const newTags = parsed.tags
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.toLowerCase().trim())
        .filter(Boolean)
        .slice(0, 3);
      if (newTags.length > 0) {
        // Una sola llamada con las hasta 3 etiquetas: la RPC hace el merge
        // dentro del propio UPDATE (con la fila bloqueada), así que no hay
        // ventana entre leer `tags` y escribirlas. El read-modify-write que
        // había acá borraba las etiquetas que el motor de automatizaciones
        // acababa de poner.
        const { data: tagsData, error: tagsError } = await db.rpc(
          "append_contact_tags",
          {
            p_workspace_id: workspaceId,
            p_contact_id: contactId,
            p_tags: newTags,
          },
        );
        if (tagsError) {
          console.error("[auto-tagging] append_contact_tags:", tagsError.message);
        } else if (
          (tagsData as { contact_found: boolean }[] | null)?.[0]?.contact_found ===
          false
        ) {
          // Best-effort a propósito (no se lanza ni se cambia el flujo): pero un
          // contacto borrado, o de otro workspace, se quedaba sin etiquetas EN
          // SILENCIO. Esto vuelve visible un bug de scoping entre tenants que
          // antes solo se notaba porque las etiquetas nunca aparecían.
          console.warn(
            "[auto-tagging] append_contact_tags: contact_found=false",
            { workspaceId, contactId },
          );
        }
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
