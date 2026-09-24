import { createClient as createSbClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../core/tool";
import { fetchPinned, validateWebhookUrl } from "../services/ssrf-guard";
import {
  resolveTemplate,
  type WebhookField,
  type WebhookVariableValues,
} from "../lib/tool-config";

// The agent only decides WHEN to fire the webhook and may attach a short note;
// the payload itself is built from the workspace-configured fields + variables.
const schema = z.object({
  note: z
    .string()
    .max(500)
    .optional()
    .describe("Nota corta opcional para incluir en el webhook ({{note}})"),
});

type Args = z.infer<typeof schema>;

function db() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

/** Loads the variable values available to webhook payload fields. */
async function loadVariableValues(
  supabase: ReturnType<typeof db>,
  ctx: ToolContext,
  note: string,
): Promise<WebhookVariableValues> {
  const [contactRes, lastMsgRes, bizRes] = await Promise.all([
    ctx.contactId
      ? supabase
          .from("contacts")
          .select("name, phone, email")
          .eq("id", ctx.contactId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("messages")
      .select("body")
      .eq("conversation_id", ctx.conversationId)
      .eq("direction", "in")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("business_info")
      .select("structured")
      .eq("workspace_id", ctx.workspaceId)
      .maybeSingle(),
  ]);

  const contact = contactRes.data as {
    name?: string | null;
    phone?: string | null;
    email?: string | null;
  } | null;
  const lastMsg = lastMsgRes.data as { body?: string | null } | null;
  const structured = (bizRes.data as { structured?: { name?: string } } | null)
    ?.structured;

  return {
    "contact.name": contact?.name ?? "",
    "contact.phone": contact?.phone ?? "",
    "contact.email": contact?.email ?? "",
    last_user_message: lastMsg?.body ?? "",
    "business.name": structured?.name ?? "",
    "conversation.id": ctx.conversationId,
    note,
  };
}

async function run(args: Args, ctx: ToolContext): Promise<ToolResult> {
  const supabase = db();

  // Load the workspace webhook config (URL + payload fields).
  const { data: toolRow } = await supabase
    .from("tools")
    .select("id")
    .eq("key", "custom_webhook")
    .single();

  const { data: cfgRow } = toolRow
    ? await supabase
        .from("tool_configs")
        .select("config")
        .eq("workspace_id", ctx.workspaceId)
        .eq("tool_id", (toolRow as { id: string }).id)
        .single()
    : { data: null };

  const config = (cfgRow as { config?: Record<string, unknown> } | null)
    ?.config as
    | { webhook_url?: string; payload_fields?: WebhookField[] }
    | undefined;

  const webhookUrl = (config?.webhook_url ?? "").trim();
  if (!webhookUrl) {
    return { ok: false, output: null, error: "No webhook URL configured" };
  }

  // SEC-08: validate URL before fetching, and keep the IP it resolved to so
  // the request below is pinned to it (no second DNS lookup = no rebinding).
  const { error: urlError, resolvedIp } = await validateWebhookUrl(webhookUrl);
  if (urlError || !resolvedIp) {
    return { ok: false, output: null, error: urlError ?? "Cannot resolve hostname" };
  }

  // Resolve variables and build the payload from the configured fields.
  const values = await loadVariableValues(supabase, ctx, args.note ?? "");
  const fields = Array.isArray(config?.payload_fields)
    ? config!.payload_fields
    : [];

  const payload: Record<string, string> =
    fields.length > 0
      ? Object.fromEntries(
          fields.map((f) => [f.key, resolveTemplate(f.value, values)]),
        )
      : {
          // Sensible default when no fields are configured.
          contact_name: values["contact.name"],
          contact_phone: values["contact.phone"],
          last_user_message: values["last_user_message"],
          note: values.note,
        };

  // fetchPinned never follows redirects: a 3xx comes back as a non-ok status
  // instead of silently re-targeting an unvalidated host.
  const res = await fetchPinned(webhookUrl, resolvedIp, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace_id: ctx.workspaceId, payload }),
    timeoutMs: 8_000,
    maxResponseBytes: 0,
  });
  const ok = res.status >= 200 && res.status < 300;

  return {
    ok,
    output: { status: res.status },
    error: ok ? undefined : `HTTP ${res.status}`,
  };
}

export const customWebhookTool: Tool<Args> = {
  name: "custom_webhook",
  description:
    "Envía los datos del contacto a un webhook externo configurado por el negocio. Úsalo cuando debas notificar o registrar al contacto en un sistema externo.",
  sensitivity: "sensitive",
  schema,
  enabledFor: () => true,
  run,
};
