import { randomUUID } from "node:crypto";
import type { NextResponse } from "next/server";
import { createClient as svcClient } from "@supabase/supabase-js";
import {
  generateChatReply,
  getWorkspaceModel,
} from "@/features/inbox/services/openrouter";
import { resolveSystemPrompt } from "@/features/inbox/services/prompt-resolver";
import {
  buildSystemPrompt,
  type PromptGuardrails,
} from "@/features/inbox/services/prompt-builder";
import {
  searchKb,
  formatKbContext,
  listKbSourceLinks,
  formatKbReferenceLinks,
} from "@/features/inbox/services/kb-service";
import {
  getBusinessInfo,
  buildBusinessInfoContext,
  buildNowContext,
} from "@/features/inbox/services/business-info";
import { workspaceSchedulingTimeZone } from "@/features/inbox/services/scheduling-timezone";
import { getEnabledTools } from "@/features/tools/services/tool-configs";
import type { AgentConfig } from "@/features/agents/types";
import { isCatalogModel } from "@/features/agents/lib/model-catalog";
import {
  guardClientTestChat,
  guardWorkspaceLlmCall,
} from "@/features/inbox/services/llm-call-guard";
import { recordWorkspaceLlmCall } from "@/features/inbox/services/cost-tracker";
import { enforceModelPolicy } from "@/features/inbox/services/model-policy";

// One pipeline for the two places a person chats with an agent without
// WhatsApp: the agent playground in Settings (test-chat, admins and managers)
// and /probar (any member, often an account handed to a client). Both mirror
// a production turn — prompt, business info, KB, response style, guardrails
// and the workspace's tools — never send WhatsApp nor persist a conversation,
// and spend the workspace's OpenRouter key, so both reserve the call against
// the daily budget and an hourly cap first. The routes only authorize and
// shape the response.

export interface PlaygroundMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * - "agent_test_chat": Settings' playground. A draft prompt and a catalog
 *   model may be tried; an admin runs every enabled tool, writes included, a
 *   manager only the read-only ones.
 * - "client_test_chat": /probar. The published prompt on the agent's model,
 *   and read-only tools for everyone, admins included.
 */
export type PlaygroundSurface = "agent_test_chat" | "client_test_chat";

export interface RunAgentPlaygroundInput {
  surface: PlaygroundSurface;
  workspaceId: string;
  /** The agent to talk to; it must belong to the workspace. */
  agentId: string;
  userId: string;
  /** The caller's role in THIS workspace, from its membership — never from the request. */
  role: string;
  messages: PlaygroundMessage[];
  /** agent_test_chat only. */
  draftPromptBody?: string;
  /** agent_test_chat only; already checked against the catalog. */
  modelOverride?: string;
  maxOutputTokens: number;
}

export type RunAgentPlaygroundResult =
  | {
      ok: true;
      text: string;
      inputTokens: number;
      outputTokens: number;
      model: string;
      writeTools: boolean;
    }
  | { ok: false; reason: "agent_not_found" }
  | { ok: false; reason: "model_not_in_catalog"; model: string }
  /** The budget or an hourly cap said no: answer with this response. */
  | { ok: false; reason: "refused"; response: NextResponse }
  | {
      ok: false;
      reason: "generation_failed";
      model: string;
      detail: string;
      /** A write tool ran before the failure: retrying would run it again. */
      wroteSomething: boolean;
    };

function svc() {
  return svcClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export async function runAgentPlayground(
  input: RunAgentPlaygroundInput,
): Promise<RunAgentPlaygroundResult> {
  const { workspaceId, agentId, surface } = input;
  const db = svc();

  // Load the agent and defend against IDOR (workspace mismatch).
  const { data: agent } = await db
    .from("agents")
    .select("id, workspace_id, type, name, model, config")
    .eq("id", agentId)
    .maybeSingle();
  if (!agent || agent.workspace_id !== workspaceId) {
    return { ok: false, reason: "agent_not_found" };
  }

  // Resolve model + system prompt. Both surfaces spend the workspace's key, so
  // an agent model outside the catalog is refused here (production turns keep
  // using it). The workspace default is validated when it is saved.
  const modelOverride = surface === "agent_test_chat" ? input.modelOverride : undefined;
  const agentModel = agent.model as string | null;
  if (!modelOverride && agentModel && !isCatalogModel(agentModel)) {
    return { ok: false, reason: "model_not_in_catalog", model: agentModel };
  }
  // The resolved model also goes through the runtime policy: on the platform
  // key a workspace default outside the catalog (a legacy config.model, or a
  // direct write) is swapped for the platform default.
  const model = await enforceModelPolicy(
    db,
    workspaceId,
    modelOverride ?? agentModel ?? (await getWorkspaceModel(workspaceId)),
    surface,
  );

  // Budget and hourly caps before anything that spends, KB embeddings included.
  const guard =
    surface === "client_test_chat"
      ? await guardClientTestChat(workspaceId, input.userId)
      : await guardWorkspaceLlmCall(workspaceId, "agent_test_chat");
  if (!guard.ok) return { ok: false, reason: "refused", response: guard.response };

  let promptBody = surface === "agent_test_chat" ? input.draftPromptBody : undefined;
  let guardrails: PromptGuardrails | null = null;
  if (!promptBody) {
    const resolved = await resolveSystemPrompt(workspaceId, {
      mode: agent.type as string,
    });
    promptBody =
      resolved?.body ??
      "Eres un asistente de WhatsApp. Responde de forma concisa y útil en español.";
    guardrails = resolved?.guardrails ?? null;
  }

  // Mirror production (buffer.ts) exactly via the shared builder: business info,
  // KB search, response style, variable substitution and strict guardrails.
  const info = await getBusinessInfo(workspaceId);
  const businessName =
    ((info?.structured as { name?: string } | null)?.name as string) ??
    "tu negocio";
  const bizContext = buildBusinessInfoContext(info);
  const timeZone = await workspaceSchedulingTimeZone(workspaceId, info);

  // KB: search with the latest user message, just like buffer.ts.
  const lastUserMessage =
    [...input.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const [kbResults, kbLinks] = await Promise.all([
    searchKb(workspaceId, lastUserMessage, 3),
    listKbSourceLinks(workspaceId),
  ]);
  const kbContext = [
    formatKbContext(kbResults),
    formatKbReferenceLinks(kbLinks),
  ]
    .filter(Boolean)
    .join("\n\n");

  const agentConfig = (agent.config ?? {}) as AgentConfig;
  const systemPrompt = buildSystemPrompt({
    nowContext: buildNowContext(timeZone),
    bizContext,
    promptBase: promptBody,
    kbContext,
    responseStyle: agentConfig.responseStyle ?? null,
    guardrails,
    vars: {
      agentName: agent.name as string,
      businessName,
      contactName: "",
    },
  });

  // In Settings, an admin tests with every tool the workspace has on, writes
  // included (booking — the playground has no contact to cancel or
  // reschedule for — and the n8n write workflows): they are the ones who
  // turned them on. A manager gets only the read-only ones (checking
  // availability, an n8n lookup): they must not book or fire the admin's
  // write workflows from here, with a draft prompt of their own. /probar is
  // read-only for everyone: whoever types there may not be on the team, and
  // nothing they say should book, cancel or write to a CRM. The seed gives
  // every call of this request the same idempotency key base, and
  // generateChatReply doesn't retry a turn after a write.
  const writeTools = surface === "agent_test_chat" && input.role === "admin";

  try {
    const enabled = await getEnabledTools(workspaceId);
    const tools = writeTools ? enabled : enabled.filter((t) => t.sensitivity === "read");
    const reply = await generateChatReply({
      model,
      systemPrompt,
      messages: input.messages,
      maxOutputTokens: input.maxOutputTokens,
      workspaceId,
      tools,
      toolContext: {
        workspaceId,
        conversationId: "",
        contactId: "",
        batchId: `playground:${randomUUID()}`,
        // A write acts only on what the tester typed (schedule_highlevel's
        // phone), and leaves a trace with who ran it.
        playground: {
          userId: input.userId,
          userMessages: input.messages
            .filter((m) => m.role === "user")
            .map((m) => m.content),
        },
      },
    });

    // Fills in the reserved row; its total_tokens counts toward the daily
    // budget, and /probar's user_id keeps counting toward the person's hourly
    // cap. Never throws.
    await recordWorkspaceLlmCall({
      reservationId: guard.reservationId,
      workspaceId,
      type: surface,
      model,
      promptTokens: reply.promptTokens,
      completionTokens: reply.completionTokens,
      extra:
        surface === "client_test_chat"
          ? { agent_id: agentId, user_id: input.userId }
          : { agent_id: agentId },
    });

    return {
      ok: true,
      text: reply.text,
      inputTokens: reply.promptTokens,
      outputTokens: reply.completionTokens,
      model,
      writeTools,
    };
  } catch (err) {
    console.error(`[agents/${surface}]`, err);
    return {
      ok: false,
      reason: "generation_failed",
      model,
      detail: err instanceof Error ? err.message : String(err),
      wroteSomething: (err as { wroteSomething?: unknown } | null)?.wroteSomething === true,
    };
  }
}
